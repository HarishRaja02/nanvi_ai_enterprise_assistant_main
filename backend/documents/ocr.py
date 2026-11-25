"""Shared Offline OCR Engine for standalone images, scanned PDFs, and embedded document images."""
from __future__ import annotations

import hashlib
import logging
import os
import re
import subprocess
import sys
import tempfile
import threading
from io import BytesIO
from pathlib import Path
from typing import Any, Iterator
from zipfile import BadZipFile, ZipFile

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".bmp",
        ".tif",
        ".tiff",
        ".gif",
    }
)

MAX_OCR_IMAGE_BYTES = 30 * 1024 * 1024
MAX_OCR_SIDE_PX = 2400
UPSCALE_THRESHOLD_PX = 900
EMBEDDED_MIN_WIDTH = 64
EMBEDDED_MIN_HEIGHT = 48
EMBEDDED_MIN_AREA = 6000

_RAPIDOCR_LOCK = threading.Lock()
_RAPIDOCR_INSTANCE: Any = None
_RAPIDOCR_UNAVAILABLE = False


def is_image_filename(filename: str | Path) -> bool:
    """Return True if the filename has a supported raster image extension."""
    return Path(str(filename)).suffix.casefold() in IMAGE_EXTENSIONS


def _get_rapidocr() -> Any | None:
    """Lazily initialize a thread-safe singleton RapidOCR ONNX engine."""
    global _RAPIDOCR_INSTANCE, _RAPIDOCR_UNAVAILABLE
    if _RAPIDOCR_INSTANCE is not None:
        return _RAPIDOCR_INSTANCE
    if _RAPIDOCR_UNAVAILABLE:
        return None
    with _RAPIDOCR_LOCK:
        if _RAPIDOCR_INSTANCE is not None:
            return _RAPIDOCR_INSTANCE
        if _RAPIDOCR_UNAVAILABLE:
            return None
        try:
            from rapidocr_onnxruntime import RapidOCR

            _RAPIDOCR_INSTANCE = RapidOCR()
            return _RAPIDOCR_INSTANCE
        except Exception as exc:
            logger.warning("RapidOCR engine unavailable (%s); falling back if supported.", exc)
            _RAPIDOCR_UNAVAILABLE = True
            return None


def _reconstruct_reading_order(ocr_boxes: list[Any]) -> str:
    """Sort OCR detections into natural top-to-bottom, left-to-right reading lines."""
    items: list[tuple[float, float, float, float, str]] = []
    heights: list[float] = []

    for entry in ocr_boxes:
        if not entry or len(entry) < 2:
            continue
        box = entry[0]
        text = str(entry[1] or "").strip()
        if not text:
            continue
        if not box or len(box) < 4:
            items.append((0.0, 0.0, 0.0, 12.0, text))
            continue
        xs = [float(pt[0]) for pt in box]
        ys = [float(pt[1]) for pt in box]
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)
        y_mid = (y_min + y_max) / 2.0
        h = max(4.0, y_max - y_min)
        heights.append(h)
        items.append((y_mid, x_min, x_max, h, text))

    if not items:
        return ""

    median_h = sorted(heights)[len(heights) // 2] if heights else 14.0
    line_tol = max(6.0, median_h * 0.55)

    items.sort(key=lambda it: (it[0], it[1]))
    lines: list[list[tuple[float, float, float, float, str]]] = []
    for it in items:
        if not lines:
            lines.append([it])
            continue
        prev_y_avg = sum(x[0] for x in lines[-1]) / len(lines[-1])
        if abs(it[0] - prev_y_avg) <= line_tol:
            lines[-1].append(it)
        else:
            lines.append([it])

    rendered_lines: list[str] = []
    for line in lines:
        line.sort(key=lambda it: it[1])
        parts: list[str] = [line[0][4]]
        prev_x_max = line[0][2]
        for cell in line[1:]:
            gap = cell[1] - prev_x_max
            sep = "  " if gap > median_h * 1.8 else " "
            parts.append(sep + cell[4])
            prev_x_max = max(prev_x_max, cell[2])
        joined = "".join(parts).strip()
        if joined:
            rendered_lines.append(joined)

    return "\n".join(rendered_lines)


def _run_winrt_ocr_bytes(image_bytes: bytes) -> str:
    """Fallback Windows 10/11 built-in WinRT OCR if ONNX runtime is unavailable."""
    if sys.platform != "win32" or not image_bytes:
        return ""
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
            tmp_path = Path(tf.name)
        from PIL import Image

        with Image.open(BytesIO(image_bytes)) as im:
            im.convert("RGB").save(tmp_path, format="PNG")

        ps_code = (
            "param([string]$ImgPath)\n"
            "Add-Type -AssemblyName System.Runtime.WindowsRuntime\n"
            "[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null\n"
            "[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null\n"
            "[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null\n"
            "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { "
            "$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]\n"
            "function Await-RT($op, $t) { $n = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op)); $n.Wait(-1) | Out-Null; $n.Result }\n"
            "$f = Await-RT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImgPath)) ([Windows.Storage.StorageFile])\n"
            "$s = Await-RT ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])\n"
            "$d = Await-RT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])\n"
            "$b = Await-RT ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])\n"
            "$e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()\n"
            "if ($null -eq $e) { exit 0 }\n"
            "$r = Await-RT ($e.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])\n"
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n"
            "$r.Lines | ForEach-Object { Write-Output $_.Text }\n"
        )
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_code, str(tmp_path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=15,
        )
        if proc.returncode == 0 and proc.stdout:
            return proc.stdout.strip()
    except Exception as exc:
        logger.debug("WinRT OCR fallback failed: %s", exc)
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
    return ""


def _prepare_pil_frame_for_ocr(frame: Any, *, allow_small: bool = True) -> tuple[Any | None, tuple[int, int]]:
    """Normalize color mode, alpha background, resolution, and padding for clean OCR."""
    from PIL import Image, ImageOps
    import numpy as np

    im = ImageOps.exif_transpose(frame)
    orig_w, orig_h = im.size
    if orig_w <= 1 or orig_h <= 1:
        return None, (orig_w, orig_h)
    if not allow_small and (orig_w < EMBEDDED_MIN_WIDTH or orig_h < EMBEDDED_MIN_HEIGHT or (orig_w * orig_h) < EMBEDDED_MIN_AREA):
        return None, (orig_w, orig_h)

    # Composite transparent PNGs/GIFs onto solid white so dark text stays legible
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        white_bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        im = Image.alpha_composite(white_bg, rgba).convert("RGB")
    elif im.mode != "RGB":
        im = im.convert("RGB")

    # Skip flat/solid images before running neural OCR
    probe_arr = np.asarray(im, dtype=np.uint8)
    if float(np.std(probe_arr)) < 1.5:
        return None, (orig_w, orig_h)

    w, h = im.size
    max_dim = max(w, h)
    min_dim = min(w, h)

    # Bound oversized camera photos for predictable latency & RAM
    if max_dim > MAX_OCR_SIDE_PX:
        scale = MAX_OCR_SIDE_PX / float(max_dim)
        im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.Resampling.LANCZOS)
    elif min_dim < UPSCALE_THRESHOLD_PX and max_dim < 1800:
        # Mildly upscale compact scans/screenshots so small digits & currency punctuation are preserved
        scale = min(2.0, 1400.0 / float(max(max_dim, 1)))
        if scale > 1.05:
            im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.Resampling.LANCZOS)

    # Add quiet white margin around text near edges
    pad = 24
    padded = Image.new("RGB", (im.width + pad * 2, im.height + pad * 2), (255, 255, 255))
    padded.paste(im, (pad, pad))
    return np.asarray(padded, dtype=np.uint8), (orig_w, orig_h)


def _run_ocr_on_rgb_array(rgb_arr: Any, *, raw_fallback_bytes: bytes | None = None) -> tuple[str, str]:
    """Execute RapidOCR (thread-locked) with WinRT fallback. Returns (text, engine_name)."""
    engine = _get_rapidocr()
    if engine is not None:
        try:
            with _RAPIDOCR_LOCK:
                try:
                    res, _ = engine(rgb_arr, unclip_ratio=1.85, box_thresh=0.35)
                except TypeError:
                    res, _ = engine(rgb_arr)
            if res:
                return _reconstruct_reading_order(res), "rapidocr"
            return "", "rapidocr"
        except Exception as exc:
            logger.debug("RapidOCR inference error: %s", exc)

    if sys.platform == "win32":
        if raw_fallback_bytes:
            win_txt = _run_winrt_ocr_bytes(raw_fallback_bytes)
            if win_txt:
                return win_txt, "winrt_ocr"
        else:
            try:
                from PIL import Image

                buf = BytesIO()
                Image.fromarray(rgb_arr).save(buf, format="PNG")
                win_txt = _run_winrt_ocr_bytes(buf.getvalue())
                if win_txt:
                    return win_txt, "winrt_ocr"
            except Exception:
                pass
    return "", "none"


def extract_text_from_image_bytes(
    data: bytes,
    *,
    filename: str = "",
    allow_small: bool = True,
    max_frames: int = 20,
    strict: bool = False,
) -> tuple[str, dict[str, Any]]:
    """Run offline OCR over any supported raster image (including multi-page TIFF).

    Returns (extracted_text, metadata_dict).
    """
    if not data or len(data) > MAX_OCR_IMAGE_BYTES:
        if strict:
            raise ValueError("Empty or oversized image file")
        return "", {"ocr_engine": "none", "frames": 0}

    try:
        from PIL import Image, ImageSequence
    except Exception as exc:
        if strict:
            raise ValueError("Pillow imaging library is unavailable") from exc
        return "", {"ocr_engine": "none", "frames": 0}

    # Allow high-resolution legitimate business scans up to 80M pixels while guarding bombs
    old_max = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = 80_000_000
    try:
        with Image.open(BytesIO(data)) as img:
            img.load()
            ext_low = Path(filename).suffix.casefold() if filename else ""
            is_multipage = ext_low in {".tif", ".tiff"} and getattr(img, "n_frames", 1) > 1
            frame_count = min(int(getattr(img, "n_frames", 1) or 1), max_frames if is_multipage else 1)

            frame_texts: list[str] = []
            used_engine = "none"
            dims = img.size

            for f_idx, frame in enumerate(ImageSequence.Iterator(img), start=1):
                if f_idx > frame_count:
                    break
                arr, dims = _prepare_pil_frame_for_ocr(frame, allow_small=allow_small)
                if arr is None:
                    continue
                txt, eng = _run_ocr_on_rgb_array(arr, raw_fallback_bytes=data if frame_count == 1 else None)
                if eng != "none":
                    used_engine = eng
                txt = txt.strip()
                if txt:
                    if frame_count > 1:
                        frame_texts.append(f"[Page {f_idx}]\n{txt}")
                    else:
                        frame_texts.append(txt)

            combined = "\n\n".join(frame_texts).strip()
            return combined, {
                "ocr_engine": used_engine,
                "image_width": dims[0],
                "image_height": dims[1],
                "frames": frame_count,
            }
    except Exception as exc:
        if strict:
            raise ValueError(f"Malformed image file: {exc}") from exc
        logger.debug("Image OCR skipped for %s: %s", filename or "<bytes>", exc)
        return "", {"ocr_engine": "none", "frames": 0}
    finally:
        Image.MAX_IMAGE_PIXELS = old_max


def _merge_selectable_and_ocr(selectable_text: str, ocr_chunks: list[str]) -> tuple[str, bool]:
    """Merge selectable PDF text with OCR findings while suppressing invisible-OCR layer duplicates."""
    sel = (selectable_text or "").strip()
    cleaned_ocr = [c.strip() for c in ocr_chunks if c and sum(1 for ch in c if ch.isalnum()) >= 4]
    if not cleaned_ocr:
        return sel, False

    merged_ocr = "\n\n".join(cleaned_ocr).strip()
    if not sel:
        return f"[Image OCR]\n{merged_ocr}", True

    # Avoid duplicating text when the PDF already contains an invisible OCR text layer
    sel_words = set(re.findall(r"[a-z0-9]{3,}", sel.casefold()))
    ocr_words = re.findall(r"[a-z0-9]{3,}", merged_ocr.casefold())
    if ocr_words and sel_words:
        overlap_ratio = sum(1 for w in ocr_words if w in sel_words) / len(ocr_words)
        if overlap_ratio >= 0.78:
            return sel, False

    return f"{sel}\n\n[Image OCR]\n{merged_ocr}", True


def iter_pdf_pages_with_ocr(
    pdf_source: bytes | str | Path,
    *,
    max_ocr_pages: int = 80,
) -> Iterator[tuple[int, str, bool]]:
    """Yield (page_num, page_text, ocr_used) across a PDF, running OCR on scans & embedded images.

    - Uses PyMuPDF (`pymupdf`) when available so rotated/tiled/masked/vector pages render at 180 DPI
      whenever selectable text is sparse (<40 alphanumeric chars), and extracts unique embedded
      content images on text-rich pages without duplicating repeated logos/watermarks.
    - Falls back cleanly to `pypdf` + `page.images` when PyMuPDF is absent.
    """
    seen_xrefs: set[int] = set()
    seen_hashes: set[str] = set()
    ocr_pages_done = 0

    try:
        import pymupdf

        if isinstance(pdf_source, (bytes, bytearray)):
            doc = pymupdf.open(stream=bytes(pdf_source), filetype="pdf")
        else:
            doc = pymupdf.open(str(pdf_source))

        try:
            for page_num, page in enumerate(doc, start=1):
                try:
                    sel_text = (page.get_text("text") or "").strip()
                except Exception:
                    sel_text = ""

                alnum_count = sum(1 for c in sel_text if c.isalnum())
                try:
                    images_info = page.get_images(full=True) or []
                except Exception:
                    images_info = []

                ocr_parts: list[str] = []

                if alnum_count < 40 and ocr_pages_done < max_ocr_pages:
                    # Page is likely a scanned image, rotated scan, tiled image scan, or outlined vector scan.
                    has_visual_content = bool(images_info)
                    if not has_visual_content:
                        try:
                            has_visual_content = bool(page.get_drawings())
                        except Exception:
                            has_visual_content = True
                    if has_visual_content or not sel_text:
                        try:
                            rect = page.rect
                            max_pt = max(float(rect.width), float(rect.height), 1.0)
                            # Target ~180 DPI (2.5x) clamped to MAX_OCR_SIDE_PX
                            zoom = min(2.5, 2000.0 / max_pt)
                            zoom = max(zoom, 1.0)
                            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
                            if pix.width >= 32 and pix.height >= 32:
                                import numpy as np
                                from PIL import Image

                                pil_page = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                                arr, _ = _prepare_pil_frame_for_ocr(pil_page, allow_small=True)
                                if arr is not None:
                                    page_ocr, _ = _run_ocr_on_rgb_array(arr)
                                    ocr_pages_done += 1
                                    if page_ocr.strip():
                                        ocr_parts.append(page_ocr.strip())
                        except Exception as exc:
                            logger.debug("Full-page PyMuPDF OCR failed on page %d: %s", page_num, exc)

                elif images_info and ocr_pages_done < max_ocr_pages:
                    # Page has selectable text AND embedded raster images (e.g. receipt/invoice image inside PDF).
                    for img_tuple in images_info[:12]:
                        xref = int(img_tuple[0]) if img_tuple else 0
                        if xref <= 0 or xref in seen_xrefs:
                            continue
                        seen_xrefs.add(xref)
                        try:
                            img_dict = doc.extract_image(xref)
                            if not img_dict:
                                continue
                            w = int(img_dict.get("width") or 0)
                            h = int(img_dict.get("height") or 0)
                            if w < EMBEDDED_MIN_WIDTH or h < EMBEDDED_MIN_HEIGHT or (w * h) < EMBEDDED_MIN_AREA:
                                continue
                            raw_img = img_dict.get("image") or b""
                            if not raw_img:
                                continue
                            digest = hashlib.sha256(raw_img).hexdigest()
                            if digest in seen_hashes:
                                continue
                            seen_hashes.add(digest)
                            txt, _ = extract_text_from_image_bytes(raw_img, allow_small=False)
                            ocr_pages_done += 1
                            if txt:
                                ocr_parts.append(txt)
                        except Exception as exc:
                            logger.debug("Embedded PDF XObject %s OCR skipped on page %d: %s", xref, page_num, exc)

                merged, used_ocr = _merge_selectable_and_ocr(sel_text, ocr_parts)
                if merged:
                    yield page_num, merged, used_ocr
        finally:
            doc.close()
        return
    except ImportError:
        pass
    except Exception as exc:
        logger.debug("PyMuPDF inspection fell back to pypdf (%s)", exc)

    # Fallback path using pypdf + embedded page.images
    from pypdf import PdfReader

    stream = BytesIO(pdf_source) if isinstance(pdf_source, (bytes, bytearray)) else str(pdf_source)
    reader = PdfReader(stream)
    for page_num, page in enumerate(reader.pages, start=1):
        try:
            sel_text = (page.extract_text() or "").strip()
        except Exception:
            sel_text = ""

        alnum_count = sum(1 for c in sel_text if c.isalnum())
        ocr_parts: list[str] = []
        if ocr_pages_done < max_ocr_pages:
            try:
                page_imgs = list(getattr(page, "images", []) or [])
            except Exception:
                page_imgs = []

            for img_file in page_imgs[:12]:
                raw_img = getattr(img_file, "data", b"") or b""
                if not raw_img:
                    continue
                digest = hashlib.sha256(raw_img).hexdigest()
                if digest in seen_hashes:
                    continue
                seen_hashes.add(digest)
                txt, _ = extract_text_from_image_bytes(
                    raw_img,
                    filename=getattr(img_file, "name", ""),
                    allow_small=(alnum_count < 40),
                )
                ocr_pages_done += 1
                if txt:
                    ocr_parts.append(txt)

        merged, used_ocr = _merge_selectable_and_ocr(sel_text, ocr_parts)
        if merged:
            yield page_num, merged, used_ocr


def extract_ocr_from_zip_media(
    data: bytes,
    *,
    media_prefixes: tuple[str, ...] = ("word/media/", "ppt/media/", "xl/media/"),
    max_images: int = 25,
) -> list[tuple[str, str]]:
    """Run OCR on content-bearing images embedded inside OOXML archives (.docx/.pptx/.xlsx)."""
    if not data or not data.startswith(b"PK\x03\x04"):
        return []
    seen_hashes: set[str] = set()
    extracted: list[tuple[str, str]] = []
    try:
        with ZipFile(BytesIO(data)) as zf:
            for info in zf.infolist():
                if len(extracted) >= max_images:
                    break
                name_low = info.filename.replace("\\", "/").lower()
                if not any(name_low.startswith(p) for p in media_prefixes):
                    continue
                if Path(name_low).suffix not in IMAGE_EXTENSIONS:
                    continue
                if info.file_size <= 0 or info.file_size > 12 * 1024 * 1024:
                    continue
                try:
                    raw = zf.read(info.filename)
                except Exception:
                    continue
                digest = hashlib.sha256(raw).hexdigest()
                if digest in seen_hashes:
                    continue
                seen_hashes.add(digest)
                txt, _ = extract_text_from_image_bytes(
                    raw,
                    filename=Path(info.filename).name,
                    allow_small=False,
                )
                if txt and sum(1 for c in txt if c.isalnum()) >= 6:
                    extracted.append((Path(info.filename).name, txt))
    except (BadZipFile, Exception) as exc:
        logger.debug("OOXML embedded media OCR skipped: %s", exc)
    return extracted

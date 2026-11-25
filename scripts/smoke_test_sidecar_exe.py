"""End-to-end process smoke test for frozen nanvi-search-sidecar.exe (or Python module)."""
from __future__ import annotations

import json
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EXE = REPO_ROOT / "frontend" / "resources" / "search-sidecar" / "nanvi-search-sidecar.exe"


def _http_json(
    url: str,
    *,
    method: str = "GET",
    token: str | None = None,
    payload: dict | None = None,
) -> tuple[int, dict]:
    headers = {}
    if token is not None:
        headers["X-Nanvi-Sidecar-Token"] = token
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as err:
        raw_err = err.read().decode("utf-8", errors="replace")
        try:
            return err.code, json.loads(raw_err)
        except Exception:
            return err.code, {"raw_error": raw_err}


def main() -> int:
    exe = DEFAULT_EXE
    if exe.exists():
        cmd = [str(exe)]
    else:
        cmd = [sys.executable, "-m", "backend.desktop_search.sidecar"]

    tmp = Path(tempfile.mkdtemp(prefix="nanvi-exe-smoke-"))
    token = secrets.token_urlsafe(32)
    proc = None
    try:
        docs = tmp / "docs"
        data_dir = tmp / "appdata"
        (docs / "Finance").mkdir(parents=True)
        (docs / "Projects").mkdir(parents=True)
        (docs / "Finance" / "INV-2025-777.txt").write_text(
            "Invoice INV-2025-777\nVendor: Orion Freight\nDue Date: 2025-08-01\nStatus: Overdue\nAmount: $9,500.00",
            encoding="utf-8",
        )
        (docs / "Projects" / "roadmap.md").write_text(
            "Desktop multi-engine architecture uses Tantivy BM25F and SQLite Trigram.",
            encoding="utf-8",
        )
        # Create a minimal valid OOXML .docx using zipfile to verify read-only docx parsing works
        # even after stripping default-docx-template for MSIX MakeAppx compatibility.
        import zipfile
        docx_path = docs / "Projects" / "brief.docx"
        with zipfile.ZipFile(docx_path, "w") as zf:
            zf.writestr(
                "[Content_Types].xml",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                '<Default Extension="xml" ContentType="application/xml"/>'
                '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                '</Types>',
            )
            zf.writestr(
                "_rels/.rels",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                '</Relationships>',
            )
            zf.writestr(
                "word/document.xml",
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                '<w:body><w:p><w:r><w:t>DocxParserFrozenToken991 verified without templates</w:t></w:r></w:p></w:body>'
                '</w:document>',
            )

        # Create a scanned image-only PNG & image-only PDF to verify frozen OCR + PyMuPDF
        from PIL import Image, ImageDraw, ImageFont
        from reportlab.pdfgen import canvas as rl_canvas
        from reportlab.lib.utils import ImageReader
        import io as _io

        font_path = "C:/Windows/Fonts/arial.ttf"
        font = ImageFont.truetype(font_path, 28) if Path(font_path).exists() else ImageFont.load_default()
        img = Image.new("RGB", (900, 220), color="white")
        draw = ImageDraw.Draw(img)
        draw.text((30, 40), "Invoice INV-OCR-7741\nToken: ImageOcrSmoke991\nStatus: Overdue", fill="black", font=font)
        png_path = docs / "Finance" / "receipt_scan.png"
        img.save(png_path, format="PNG")

        pdf_img = Image.new("RGB", (900, 220), color="white")
        draw2 = ImageDraw.Draw(pdf_img)
        draw2.text((30, 40), "Scanned PDF Attachment\nToken: PdfOcrSmoke882\nVendor: Zenith Systems", fill="black", font=font)
        img_buf = _io.BytesIO()
        pdf_img.save(img_buf, format="PNG")
        img_buf.seek(0)
        scanned_pdf = docs / "Finance" / "scanned_brief.pdf"
        cv = rl_canvas.Canvas(str(scanned_pdf), pagesize=(650, 250))
        cv.drawImage(ImageReader(img_buf), 20, 20, width=600, height=200)
        cv.save()

        proc = subprocess.Popen(
            [*cmd, "--host", "127.0.0.1", "--port", "0", "--data-dir", str(data_dir), "--no-download"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(token + "\n")
        proc.stdin.flush()
        proc.stdin.close()

        banner = None
        for _ in range(40):
            line = proc.stdout.readline()
            if not line:
                break
            line = line.strip()
            if line.startswith("{"):
                parsed = json.loads(line)
                if parsed.get("status") == "ready":
                    banner = parsed
                    break

        if not banner or not banner.get("port"):
            err = proc.stderr.read() if proc.stderr else ""
            raise RuntimeError(f"Sidecar did not emit ready banner. stderr={err}")

        base = f"http://{banner['host']}:{banner['port']}"
        code, _ = _http_json(f"{base}/internal/health")
        assert code == 401, f"Expected 401 without token, got {code}"

        code, health = _http_json(f"{base}/internal/health", token=token)
        assert code == 200 and health["status"] == "ok", f"Unexpected health: {code} {health}"

        code, warm = _http_json(
            f"{base}/internal/warm",
            method="POST",
            token=token,
            payload={"folder_path": str(docs), "wait_for_drain": True},
        )
        assert code == 200 and warm["scan"]["indexed"] == 5, f"Unexpected warm: {code} {warm}"
        assert warm["health"]["tantivy_available"] is True
        assert warm["health"]["hnsw_available"] is True
        assert warm["health"]["fts5_chunks_retired"] is True

        code, img_srch = _http_json(
            f"{base}/internal/search",
            method="POST",
            token=token,
            payload={"folder_path": str(docs), "query": "ImageOcrSmoke991", "role": "CEO", "roles": ["CEO"]},
        )
        assert code == 200 and img_srch["total_matches"] >= 1, f"Image OCR search failed: {img_srch}"
        assert any(f["name"] == "receipt_scan.png" for f in img_srch["files"]), img_srch

        code, pdf_ocr_srch = _http_json(
            f"{base}/internal/search",
            method="POST",
            token=token,
            payload={"folder_path": str(docs), "query": "PdfOcrSmoke882", "role": "CEO", "roles": ["CEO"]},
        )
        assert code == 200 and pdf_ocr_srch["total_matches"] >= 1, f"Scanned PDF OCR search failed: {pdf_ocr_srch}"
        assert any(f["name"] == "scanned_brief.pdf" for f in pdf_ocr_srch["files"]), pdf_ocr_srch

        code, docx_srch = _http_json(
            f"{base}/internal/search",
            method="POST",
            token=token,
            payload={"folder_path": str(docs), "query": "DocxParserFrozenToken991", "role": "Employee", "roles": ["Employee"]},
        )
        assert code == 200 and docx_srch["total_matches"] == 1
        assert docx_srch["files"][0]["name"] == "brief.docx"

        code, emp_srch = _http_json(
            f"{base}/internal/search",
            method="POST",
            token=token,
            payload={"folder_path": str(docs), "query": "INV-2025-777", "role": "Employee", "roles": ["Employee"]},
        )
        assert code == 200
        assert emp_srch["total_matches"] == 0, f"Finance doc leaked to Employee: {emp_srch}"

        code, ceo_srch = _http_json(
            f"{base}/internal/search",
            method="POST",
            token=token,
            payload={"folder_path": str(docs), "query": "INV-2025-777", "role": "CEO", "roles": ["CEO"]},
        )
        assert code == 200 and ceo_srch["total_matches"] == 1
        assert ceo_srch["files"][0]["name"] == "INV-2025-777.txt"
        assert "tantivy" in ceo_srch["engines_used"]

        code, _ = _http_json(f"{base}/internal/shutdown", method="POST", token=token, payload={})
        assert code == 200
        exit_code = proc.wait(timeout=10)
        assert exit_code == 0, f"Non-zero exit code on shutdown: {exit_code}"

        print(json.dumps({"exe": str(exe), "banner": banner, "ceo_search": ceo_srch["engines_used"], "status": "PASSED"}))
        return 0
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())


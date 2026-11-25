from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
import re
from typing import Any, Iterator

from backend.integrations.files.company_data.extraction import (
    aggregate_entities_from_documents,
    create_default_document_service,
    extract_contract_records_from_files,
    extract_invoice_records_from_files,
)
from backend.security.authorization import Role, UserAttributes

from .models import CanonicalChunkRecord, CanonicalFileRecord

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = frozenset(
    {
        ".txt",
        ".md",
        ".markdown",
        ".csv",
        ".tsv",
        ".json",
        ".jsonl",
        ".xml",
        ".html",
        ".htm",
        ".rtf",
        ".pdf",
        ".docx",
        ".xlsx",
        ".xlsm",
        ".pptx",
        ".py",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".sql",
        ".yaml",
        ".yml",
        ".log",
        ".ini",
        ".cfg",
        ".eml",
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

IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"})

CODE_OR_LOG_EXTS = frozenset({".log", ".csv", ".tsv", ".jsonl", ".sql"})
PAGE_MARKER_RE = re.compile(r"\[(?:Page|Sheet|Slide|Rows)\s+([^\]]+)\]", re.IGNORECASE)

_DOC_SVC = None


def _get_doc_service():
    global _DOC_SVC
    if _DOC_SVC is None:
        _DOC_SVC = create_default_document_service()
    return _DOC_SVC


def compute_sha256_streaming(file_path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    """Compute SHA-256 hex digest using bounded 1 MB streaming reads."""
    digest = hashlib.sha256()
    with open(file_path, "rb") as fh:
        while True:
            buf = fh.read(chunk_size)
            if not buf:
                break
            digest.update(buf)
    return digest.hexdigest()


def extract_ntfs_identity(file_path: Path) -> tuple[str, str, int, int]:
    """Return (volume_serial, file_index, size_bytes, mtime_ns)."""
    st = os.stat(file_path)
    vol = str(int(getattr(st, "st_dev", 0) or 0))
    ino = str(int(getattr(st, "st_ino", 0) or 0))
    mtime_ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000)))
    return vol, ino, int(st.st_size), mtime_ns


def infer_doc_type(ext: str, filename: str, rel_path: str) -> str:
    low = f"{rel_path} {filename}".casefold()
    if "invoice" in low or "receipt" in low:
        return "invoice"
    if "contract" in low or "agreement" in low or "nda" in low or "msa" in low:
        return "contract"
    if ext in {".xlsx", ".xlsm", ".csv", ".tsv"}:
        return "spreadsheet"
    if ext == ".pdf":
        return "pdf"
    if ext in {".docx", ".pptx", ".rtf"}:
        return "office_document"
    if ext in {".py", ".ts", ".tsx", ".js", ".jsx", ".sql", ".json", ".yaml", ".yml"}:
        return "code_or_data"
    if ext == ".eml":
        return "email"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    return "document"


def _is_numeric_heavy_table(text: str) -> bool:
    if len(text) < 200:
        return False
    digits = sum(1 for ch in text if ch.isdigit())
    alpha = sum(1 for ch in text if ch.isalpha())
    return digits > max(60, alpha * 2)


def _split_into_chunks(
    text: str,
    *,
    doc_id: str,
    file_version: int,
    ext: str,
    start_index: int = 0,
    page_label: str = "",
    section_label: str = "",
    target_chars: int = 900,
    overlap_chars: int = 120,
) -> list[CanonicalChunkRecord]:
    cleaned = "\n".join(line.rstrip() for line in text.splitlines()).strip()
    if not cleaned:
        return []

    records: list[CanonicalChunkRecord] = []
    pos = 0
    idx = start_index
    length = len(cleaned)
    current_page = page_label

    while pos < length:
        end = min(length, pos + target_chars)
        if end < length:
            nl = cleaned.rfind("\n", pos + target_chars // 2, end)
            sp = cleaned.rfind(" ", pos + target_chars // 2, end)
            split_at = nl if nl > pos else (sp if sp > pos else end)
            end = max(pos + 200, split_at)
        piece = cleaned[pos:end].strip()
        if piece:
            markers = PAGE_MARKER_RE.findall(piece)
            if markers:
                current_page = f"Page {markers[-1]}" if not markers[-1].lower().startswith(("page", "sheet", "rows")) else markers[-1]
            c_sha = hashlib.sha256(piece.encode("utf-8", errors="ignore")).hexdigest()
            embed_ok = not (_is_numeric_heavy_table(piece) and ext in CODE_OR_LOG_EXTS)
            records.append(
                CanonicalChunkRecord(
                    chunk_id=f"{doc_id}:v{file_version}:c{idx}",
                    doc_id=doc_id,
                    file_version=file_version,
                    chunk_index=idx,
                    page_label=current_page,
                    section_label=section_label,
                    content=piece,
                    content_sha256=c_sha,
                    char_count=len(piece),
                    embed_eligible=embed_ok,
                    is_deleted=False,
                )
            )
            idx += 1
        if end >= length:
            break
        pos = max(pos + 1, end - overlap_chars)

    return records


def _iter_pdf_pages_streaming(file_path: Path, *, max_ocr_pages: int = 80) -> Iterator[tuple[str, str]]:
    from backend.documents.ocr import iter_pdf_pages_with_ocr

    for page_num, txt, _used_ocr in iter_pdf_pages_with_ocr(file_path, max_ocr_pages=max_ocr_pages):
        txt = txt.strip()
        if txt:
            yield f"Page {page_num}", f"[Page {page_num}]\n{txt}"


def _iter_xlsx_sheets_streaming(file_path: Path, row_batch: int = 200) -> Iterator[tuple[str, str]]:
    import openpyxl

    wb = openpyxl.load_workbook(str(file_path), read_only=True, data_only=True)
    try:
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            headers: list[str] = []
            buf: list[str] = []
            for r_idx, row in enumerate(ws.iter_rows(values_only=True), start=1):
                vals = ["" if v is None else str(v).strip() for v in row]
                if not any(vals):
                    continue
                if r_idx == 1:
                    headers = vals
                    buf.append(f"[Sheet {sheet_name}] Columns: " + " | ".join(h for h in headers if h))
                    continue
                if headers and len(headers) == len(vals):
                    pairs = [f"{h}: {v}" for h, v in zip(headers, vals) if v]
                    line = " | ".join(pairs) if pairs else " | ".join(v for v in vals if v)
                else:
                    line = " | ".join(v for v in vals if v)
                if line:
                    buf.append(line)
                if len(buf) >= row_batch:
                    yield f"Sheet {sheet_name}", "\n".join(buf)
                    buf.clear()
            if buf:
                yield f"Sheet {sheet_name}", "\n".join(buf)
    finally:
        wb.close()


def _iter_text_streaming(file_path: Path, line_batch: int = 120) -> Iterator[tuple[str, str]]:
    start_line = 1
    buf: list[str] = []
    with open(file_path, "r", encoding="utf-8", errors="replace") as fh:
        for line_no, raw in enumerate(fh, start=1):
            stripped = raw.rstrip("\r\n")
            if stripped:
                buf.append(stripped)
            if len(buf) >= line_batch:
                yield f"Lines {start_line}-{line_no}", "\n".join(buf)
                buf.clear()
                start_line = line_no + 1
    if buf:
        yield f"Lines {start_line}+", "\n".join(buf)


def parse_file_to_chunks(
    file_path: Path,
    file_rec: CanonicalFileRecord,
    *,
    target_chars: int = 900,
    overlap_chars: int = 120,
    max_file_mb: int = 256,
    allow_ocr: bool = True,
    max_ocr_pages: int = 80,
) -> tuple[list[CanonicalChunkRecord], str]:
    """Parse any supported workspace file into bounded canonical chunks without silent truncation.

    Returns (chunks, preview_text_for_structured_extraction).
    """
    ext = file_rec.ext.casefold()
    size_mb = file_rec.size_bytes / (1024 * 1024)
    if size_mb > max_file_mb:
        raise ValueError(f"File exceeds configured local safety limit ({size_mb:.1f} MB > {max_file_mb} MB)")

    chunks: list[CanonicalChunkRecord] = []
    preview_parts: list[str] = []
    preview_chars = 0

    def _append_from_section(section_label: str, body: str) -> None:
        nonlocal preview_chars
        new_chunks = _split_into_chunks(
            body,
            doc_id=file_rec.doc_id,
            file_version=file_rec.current_version,
            ext=ext,
            start_index=len(chunks),
            page_label=section_label if section_label.startswith("Page ") else "",
            section_label=section_label,
            target_chars=target_chars,
            overlap_chars=overlap_chars,
        )
        chunks.extend(new_chunks)
        if preview_chars < 250_000 and body:
            take = body[: 250_000 - preview_chars]
            preview_parts.append(take)
            preview_chars += len(take)

    # Use memory-bounded streaming readers for large files or heavy container formats.
    if ext == ".pdf":
        eff_ocr_pages = max_ocr_pages if allow_ocr else 0
        for label, page_text in _iter_pdf_pages_streaming(file_path, max_ocr_pages=eff_ocr_pages):
            _append_from_section(label, page_text)
    elif ext in {".xlsx", ".xlsm"}:
        for label, sheet_text in _iter_xlsx_sheets_streaming(file_path):
            _append_from_section(label, sheet_text)
    elif ext in {".txt", ".md", ".markdown", ".csv", ".tsv", ".log", ".jsonl", ".py", ".ts", ".tsx", ".js", ".jsx", ".sql", ".yaml", ".yml", ".ini", ".cfg", ".eml"} and file_rec.size_bytes > 2 * 1024 * 1024:
        for label, block in _iter_text_streaming(file_path):
            _append_from_section(label, block)
    elif ext in IMAGE_EXTENSIONS and not allow_ocr:
        # During bulk partition indexing (10k+ files), index image path/filename metadata immediately
        # without spawning thousands of synchronous OCR processes.
        pass
    else:
        raw_bytes = file_path.read_bytes()
        try:
            doc = _get_doc_service().parse_bytes(
                filename=file_rec.filename,
                relative_path=file_rec.rel_path,
                data=raw_bytes,
            )
            full_text = (doc.text or "").strip()
        except Exception:
            if ext in {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".html", ".htm", ".py", ".ts", ".tsx", ".js", ".jsx", ".sql", ".yaml", ".yml", ".log", ".ini", ".cfg", ".eml"}:
                full_text = raw_bytes.decode("utf-8", errors="replace").strip()
            else:
                raise
        if full_text:
            _append_from_section("Body", full_text)

    if not chunks:
        # Ensure filename-only or scanned empty documents remain searchable via filename/path chunk.
        stub = f"Document: {file_rec.rel_path} ({file_rec.department})"
        _append_from_section("Metadata", stub)

    return chunks, "\n".join(preview_parts)


def extract_structured_metadata(
    file_rec: CanonicalFileRecord,
    preview_text: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[tuple[str, str, dict[str, Any]]]]:
    """Extract normalized invoices, contracts, and named entities using shared Nanvi extractors."""
    if not preview_text.strip():
        return [], [], []

    # Synthetic admin user runs extractor solely over this file's already-parsed text;
    # query-time RBAC filters enforce user access before anything is surfaced.
    extractor_user = UserAttributes(
        user_id="local-indexer",
        tenant_id=file_rec.tenant_id,
        department=None,
        roles=frozenset({Role.CEO}),
    )
    doc_payload = {
        file_rec.rel_path: {
            "source_id": file_rec.doc_id,
            "filename": file_rec.filename,
            "relative_path": file_rec.rel_path,
            "text": preview_text,
            "content": preview_text,
            "department": file_rec.department,
        }
    }
    invoices, _ = extract_invoice_records_from_files(
        doc_payload,
        lambda _u, _p: True,
        extractor_user,
        limit=200,
    )
    if not invoices and file_rec.doc_type == "invoice":
        m_inv = re.search(r"\b(INV[-_]?\d{3,}[-\w]*)\b", preview_text, re.IGNORECASE)
        m_amt = re.search(r"(?:Amount|Total)\s*[:\n\-]?\s*(\$?[\d,]+(?:\.\d{2})?)", preview_text, re.IGNORECASE)
        m_vend = re.search(r"(?:Vendor|Supplier|Billed\s*By)\s*[:\n\-]\s*([^\r\n]+)", preview_text, re.IGNORECASE)
        m_cust = re.search(r"(?:Customer|Client|Bill\s*To|Billed\s*To)\s*[:\n\-]\s*([^\r\n]+)", preview_text, re.IGNORECASE)
        m_due = re.search(r"Due\s*Date\s*[:\n\-]\s*([^\r\n]+)", preview_text, re.IGNORECASE)
        m_inv_dt = re.search(r"Invoice\s*Date\s*[:\n\-]\s*([^\r\n]+)", preview_text, re.IGNORECASE)
        m_stat = re.search(r"(?:Payment\s*Status|Status)\s*[:\n\-]\s*([^\r\n]+)", preview_text, re.IGNORECASE)
        if m_inv or m_amt:
            raw_amt = m_amt.group(1).strip() if m_amt else "0"
            cust_val = m_cust.group(1).strip() if m_cust else ""
            invoices = [
                {
                    "id": m_inv.group(1) if m_inv else file_rec.filename,
                    "invoice_number": m_inv.group(1) if m_inv else file_rec.filename,
                    "vendor": m_vend.group(1).strip() if m_vend else "",
                    "customer": cust_val or (m_vend.group(1).strip() if m_vend else ""),
                    "has_explicit_customer": bool(cust_val),
                    "amount": raw_amt,
                    "currency": "INR" if "inr" in raw_amt.lower() or "₹" in raw_amt else ("$" if "$" in raw_amt else "INR"),
                    "invoice_date": m_inv_dt.group(1).strip() if m_inv_dt else "",
                    "due_date": m_due.group(1).strip() if m_due else "",
                    "status": m_stat.group(1).strip() if m_stat else "",
                }
            ]

    contracts, _ = extract_contract_records_from_files(
        doc_payload,
        lambda _u, _p: True,
        extractor_user,
        limit=25,
    )
    agg = aggregate_entities_from_documents(
        doc_payload.values(),
        entity_kind="all",
        preview_limit=500,
        include_all=True,
    )
    entities: list[tuple[str, str, dict[str, Any]]] = []
    for agg_key, ent_type in (("employees", "employee"), ("customers", "customer"), ("vendors", "vendor")):
        bucket = agg.get(agg_key)
        seen_names: set[str] = set()
        if isinstance(bucket, dict):
            recs = bucket.get("all_records") or bucket.get("sample_names") or []
            for rec in recs:
                nm = rec.get("name") if isinstance(rec, dict) else str(rec)
                rec_dict = dict(rec) if isinstance(rec, dict) else {"name": nm}
                rec_key = (str(rec_dict.get("id") or "") + "|" + str(nm)).casefold()
                if nm and rec_key not in seen_names:
                    seen_names.add(rec_key)
                    entities.append((ent_type, str(nm), rec_dict))
        elif isinstance(bucket, list):
            for rec in bucket:
                nm = rec.get("name") if isinstance(rec, dict) else str(rec)
                rec_dict = dict(rec) if isinstance(rec, dict) else {"name": nm}
                if nm and nm.casefold() not in seen_names:
                    seen_names.add(nm.casefold())
                    entities.append((ent_type, str(nm), rec_dict))

    return invoices, contracts, entities

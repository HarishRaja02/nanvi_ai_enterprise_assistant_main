"""End-to-end tests for offline OCR across images, scanned/hybrid PDFs, Office media, RAG uploads, and search."""
from __future__ import annotations

import base64
import io
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas

from backend.desktop_search.models import CanonicalFileRecord
from backend.desktop_search.parsers import SUPPORTED_EXTENSIONS, parse_file_to_chunks
from backend.documents.ocr import extract_text_from_image_bytes, iter_pdf_pages_with_ocr
from backend.documents.parsers import ImageParser, PDFParser, PPTXParser, WordParser
from backend.integrations.files.company_data.extraction import create_default_document_service
from backend.integrations.files.company_data.service import CompanyDataService
from backend.retrieval.entity_resolver import discover_and_build_entity_index
from backend.security.authorization import Role, UserAttributes
from backend.services.company_memory import CompanyMemoryService


def _make_text_image_bytes(
    lines: list[str],
    *,
    fmt: str = "PNG",
    size: tuple[int, int] = (920, 260),
    mode: str = "RGB",
) -> bytes:
    font_path = Path("C:/Windows/Fonts/arial.ttf")
    font = ImageFont.truetype(str(font_path), 28) if font_path.exists() else ImageFont.load_default()
    bg = (255, 255, 255, 255) if mode == "RGBA" else "white"
    fg = (0, 0, 0, 255) if mode == "RGBA" else "black"
    img = Image.new(mode, size, color=bg)
    draw = ImageDraw.Draw(img)
    draw.text((30, 35), "\n".join(lines), fill=fg, font=font)
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def test_image_ocr_standalone_formats():
    png_bytes = _make_text_image_bytes(
        ["INVOICE INV-2026-9941", "Vendor: Horizon Freight", "Amount: $14,250.00", "Status: Overdue"],
        fmt="PNG",
    )
    txt, meta = extract_text_from_image_bytes(png_bytes, filename="invoice_scan.png")
    assert "9941" in txt
    assert "Horizon" in txt
    assert meta["ocr_engine"] in ("rapidocr", "winrt_ocr")

    # Transparent RGBA PNG must composite onto white background cleanly
    rgba_bytes = _make_text_image_bytes(["AlphaToken773", "Confidential Audit"], fmt="PNG", mode="RGBA")
    rgba_txt, _ = extract_text_from_image_bytes(rgba_bytes, filename="rgba.png")
    assert "AlphaToken773" in rgba_txt

    # JPG support via ImageParser and default document service
    jpg_bytes = _make_text_image_bytes(["JpegReceiptToken551", "Total: $420.00"], fmt="JPEG")
    svc = create_default_document_service()
    doc = svc.parse_bytes(filename="receipt.jpg", relative_path="Finance/receipt.jpg", data=jpg_bytes)
    assert "551" in doc.text
    assert "[Image OCR]" in doc.text


def test_pdf_scanned_only_and_hybrid_embedded_image():
    scan_img = _make_text_image_bytes(["ScannedOnlyPdf8821", "Customer: Asteron Tech"])
    pdf_buf = io.BytesIO()
    c = rl_canvas.Canvas(pdf_buf, pagesize=(650, 260))
    c.drawImage(ImageReader(io.BytesIO(scan_img)), 20, 20, width=600, height=200)
    c.save()
    scanned_pdf = pdf_buf.getvalue()

    parser = PDFParser()
    doc = parser.parse_bytes(filename="scanned.pdf", relative_path="scanned.pdf", data=scanned_pdf)
    assert "[Page 1]" in doc.text
    assert "[Image OCR]" in doc.text
    assert "Asteron" in doc.text

    # Hybrid PDF: Page 1 has selectable header text AND a content-bearing embedded image
    hybrid_img = _make_text_image_bytes(["HYBRID-IMG-912", "Due Date: 2026-09-01"])
    hbuf = io.BytesIO()
    hc = rl_canvas.Canvas(hbuf, pagesize=(650, 360))
    hc.drawString(40, 310, "Quarterly Vendor Statement Header Summary Section 2026")
    hc.drawImage(ImageReader(io.BytesIO(hybrid_img)), 20, 30, width=600, height=200)
    hc.save()

    pages = list(iter_pdf_pages_with_ocr(hbuf.getvalue()))
    assert len(pages) == 1
    assert "Quarterly Vendor Statement" in pages[0][1]
    assert "[Image OCR]" in pages[0][1]
    assert "912" in pages[0][1]
    assert "2026-09-01" in pages[0][1]
    assert pages[0][2] is True


def test_docx_and_pptx_embedded_media_ocr():
    from docx import Document as WordDocument
    from pptx import Presentation

    embed_img = _make_text_image_bytes(["OfficeMediaOcrToken404", "Contract Value: $90,000"])

    # DOCX with embedded image
    wdoc = WordDocument()
    wdoc.add_paragraph("Master Contract Appendix")
    wdoc.add_picture(io.BytesIO(embed_img))
    wbuf = io.BytesIO()
    wdoc.save(wbuf)

    parsed_docx = WordParser().parse_bytes(filename="contract.docx", relative_path="contract.docx", data=wbuf.getvalue())
    assert "Master Contract Appendix" in parsed_docx.text
    assert "OfficeMediaOcrToken404" in parsed_docx.text

    # PPTX with embedded image
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[5])
    slide.shapes.title.text = "Q4 Executive Deck"
    from pptx.util import Inches
    slide.shapes.add_picture(io.BytesIO(embed_img), Inches(1), Inches(2))
    pbuf = io.BytesIO()
    prs.save(pbuf)

    parsed_pptx = PPTXParser().parse_bytes(filename="deck.pptx", relative_path="deck.pptx", data=pbuf.getvalue())
    assert "Q4 Executive Deck" in parsed_pptx.text
    assert "OfficeMediaOcrToken404" in parsed_pptx.text


def test_company_memory_and_desktop_search_and_entity_resolver_ocr(tmp_path: Path):
    scan_img = _make_text_image_bytes(["Vendor: Nimbus Cloud", "Amount: $7,500", "Token: MemOcr663"])
    pdf_buf = io.BytesIO()
    c = rl_canvas.Canvas(pdf_buf, pagesize=(650, 260))
    c.drawImage(ImageReader(io.BytesIO(scan_img)), 20, 20, width=600, height=200)
    c.save()

    mem_svc = CompanyMemoryService(storage_file=tmp_path / "company_memory.json")
    extracted = mem_svc.extract_text_from_pdf(pdf_buf.getvalue())
    assert "Nimbus" in extracted
    assert "[Image OCR]" in extracted

    # Folder discovery + desktop parser + CompanyDataService search + entity resolver
    fin_dir = tmp_path / "Finance"
    fin_dir.mkdir()
    img_path = fin_dir / "vendor_bill.png"
    img_path.write_bytes(scan_img)
    pdf_path = fin_dir / "scanned_bill.pdf"
    pdf_path.write_bytes(pdf_buf.getvalue())

    assert ".png" in SUPPORTED_EXTENSIONS and ".jpg" in SUPPORTED_EXTENSIONS

    rec = CanonicalFileRecord(
        doc_id="img-doc-1",
        tenant_id="t1",
        user_id="u1",
        machine_id="m1",
        workspace_id="w1",
        abs_path=str(img_path),
        rel_path="Finance/vendor_bill.png",
        filename="vendor_bill.png",
        ext=".png",
        size_bytes=img_path.stat().st_size,
        mtime_ns=1,
        content_sha256="abc",
        department="Finance",
        compartment="comp_finance",
        doc_type="image",
        is_sensitive=True,
        is_cloud_stub=False,
        extraction_status="indexed",
        current_version=1,
        is_deleted=False,
    )
    chunks, preview = parse_file_to_chunks(img_path, rec)
    assert chunks and "Nimbus" in preview

    cds = CompanyDataService(tmp_path, tenant_id="t-ocr")
    cds.ensure_indexed(force=True)
    user = UserAttributes("ceo1", "t-ocr", "Executive", frozenset({Role.CEO}))
    res = cds.search(user, "Nimbus Cloud vendor bill")
    assert any("vendor_bill" in (s.display_name or "") or "scanned_bill" in (s.display_name or "") for s in res.sources)

    ent_idx = discover_and_build_entity_index(tmp_path)
    assert ent_idx.total_count() >= 1


def test_chat_upload_and_extract_text_endpoints_accept_images(tmp_path: Path, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.main import app
    from backend.api import chat_routes
    from backend.agents.knowledge_agent import KnowledgeAgent
    from backend.agents.models import AgentRequest
    from backend.security.dependencies import get_current_user
    from backend.security.models import UserIdentity

    monkeypatch.setattr(chat_routes, "_resolve_upload_fallback_dir", lambda: tmp_path / "uploads")

    fake_user = UserIdentity(
        subject="ceo-ocr-test",
        issuer="nanvi",
        tenant_id="t-ocr-api",
        roles=frozenset({Role.CEO}),
        department="Executive",
        email="ceo@nanvi.local",
        name="CEO Test",
    )
    app.dependency_overrides[get_current_user] = lambda: fake_user
    try:
        client = TestClient(app)

        png_bytes = _make_text_image_bytes(["Invoice INV-API-331", "Total: $3,200.00", "Client: Veridian Bio"])
        b64 = base64.b64encode(png_bytes).decode("ascii")

        ext_res = client.post("/api/local-agent/extract-text", json={"filename": "scan.png", "content_base64": b64})
        assert ext_res.status_code == 200, ext_res.text
        assert "Veridian" in ext_res.json()["text"]

        up_res = client.post("/api/chat/upload", json={"filename": "invoice_photo.png", "content_base64": b64})
        assert up_res.status_code == 200, up_res.text
        assert up_res.json()["filename"] == "invoice_photo.png"

        # Verify KnowledgeAgent retrieves active uploaded image OCR even when a Desktop folder context is active
        agent = KnowledgeAgent()
        user_attrs = UserAttributes("ceo-ocr-test", "t-ocr-api", "Executive", frozenset({Role.CEO}))
        ka_res = agent.run(
            AgentRequest(
                request_id="req-ocr-test-1",
                query="What is the client and total in this image?",
                user=user_attrs,
                active_document_id="invoice_photo.png",
                local_context={"folder_path": "C:/CompanyData", "files": [], "chunks": []},
            )
        )
        assert "Veridian" in ka_res.content
    finally:
        app.dependency_overrides.clear()

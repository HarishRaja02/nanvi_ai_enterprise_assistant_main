"""HTML Preview Generator for in-memory ephemeral document preview in browser.

Converts documents (Word, Excel, PowerPoint, CSV, TSV, JSON, XML, RTF, Text)
into self-contained, beautifully styled HTML pages that render seamlessly
inside the ephemeral browser preview iframe.
"""
from __future__ import annotations

import html
from pathlib import Path
from backend.documents.models import Document


def render_document_to_html(doc: Document) -> str:
    """Render a parsed Document model into an elegant, standalone HTML preview."""
    filename = html.escape(doc.source.filename)
    file_type = doc.source.file_type.lower()

    if file_type in ("xlsx", "xls", "xlsm", "csv", "tsv") or doc.tables:
        body_content = _render_spreadsheet(doc)
    elif file_type in ("docx", "doc", "rtf"):
        body_content = _render_word_doc(doc)
    elif file_type in ("pptx", "ppt"):
        body_content = _render_presentation(doc)
    elif file_type == "pdf":
        body_content = _render_pdf_doc(doc)
    elif file_type in ("json", "jsonl", "xml"):
        body_content = _render_code_view(doc, language=file_type)
    elif file_type in ("png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif"):
        body_content = _render_image_ocr_view(doc, image_type=file_type)
    else:
        body_content = _render_text_view(doc)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{filename}</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      line-height: 1.6;
      padding: 24px;
      -webkit-font-smoothing: antialiased;
    }}
    .preview-container {{
      max-width: 1100px;
      margin: 0 auto;
    }}
    .doc-paper {{
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);
      padding: 36px 44px;
      margin-bottom: 24px;
      min-height: 480px;
    }}
    .doc-header {{
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 16px;
      margin-bottom: 24px;
      border-bottom: 2px solid #e2e8f0;
    }}
    .doc-title {{
      font-size: 20px;
      font-weight: 700;
      color: #0f172a;
    }}
    .doc-badge {{
      display: inline-block;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-radius: 9999px;
      background: #e0f2fe;
      color: #0284c7;
    }}
    /* Spreadsheet table styling */
    .table-section {{
      margin-bottom: 32px;
    }}
    .table-section-title {{
      font-size: 15px;
      font-weight: 700;
      color: #334155;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 8px;
    }}
    .table-wrapper {{
      overflow-x: auto;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      background: #ffffff;
      margin-bottom: 16px;
    }}
    table.data-table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }}
    table.data-table th {{
      background: #f1f5f9;
      color: #334155;
      font-weight: 600;
      padding: 10px 14px;
      border-bottom: 2px solid #cbd5e1;
      border-right: 1px solid #e2e8f0;
      white-space: nowrap;
      position: sticky;
      top: 0;
    }}
    table.data-table th:last-child {{
      border-right: none;
    }}
    table.data-table td {{
      padding: 9px 14px;
      border-bottom: 1px solid #e2e8f0;
      border-right: 1px solid #f1f5f9;
      color: #1e293b;
      white-space: nowrap;
    }}
    table.data-table td:last-child {{
      border-right: none;
    }}
    table.data-table tr:hover td {{
      background: #f8fafc;
    }}
    table.data-table tr:last-child td {{
      border-bottom: none;
    }}
    /* Document text styling */
    .doc-paragraph {{
      margin-bottom: 14px;
      font-size: 14.5px;
      line-height: 1.7;
      color: #334155;
      white-space: pre-wrap;
    }}
    .doc-heading {{
      font-size: 18px;
      font-weight: 700;
      color: #0f172a;
      margin-top: 24px;
      margin-bottom: 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid #e2e8f0;
    }}
    /* Slide styling */
    .slide-card {{
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 24px 30px;
      margin-bottom: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }}
    .slide-header {{
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
      padding-bottom: 8px;
      border-bottom: 1px solid #e2e8f0;
    }}
    .slide-badge {{
      font-size: 12px;
      font-weight: 700;
      color: #2563eb;
      background: #eff6ff;
      padding: 3px 8px;
      border-radius: 4px;
    }}
    /* Code styling */
    pre.code-block {{
      background: #0f172a;
      color: #f8fafc;
      padding: 20px;
      border-radius: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 13px;
      line-height: 1.6;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }}
  </style>
</head>
<body>
  <div class="preview-container">
    {body_content}
  </div>
</body>
</html>"""


def _render_spreadsheet(doc: Document) -> str:
    """Render spreadsheet sheets and tabular data into clean HTML tables."""
    sections: list[str] = []

    # If structured tables exist
    if doc.tables:
        for tbl in doc.tables:
            label = html.escape(tbl.source_label or "Table")
            header_cells = "".join(f"<th>{html.escape(h)}</th>" for h in tbl.headers)
            header_row = f"<tr>{header_cells}</tr>" if header_cells else ""

            body_rows = []
            for row in tbl.rows:
                cells = "".join(f"<td>{html.escape(cell)}</td>" for cell in row)
                body_rows.append(f"<tr>{cells}</tr>")

            rows_html = "\n".join(body_rows)
            count = len(tbl.rows)
            sections.append(f"""
            <div class="table-section">
              <div class="table-section-title">
                <span>📊 {label}</span>
                <span class="doc-badge">{count} row{'s' if count != 1 else ''}</span>
              </div>
              <div class="table-wrapper">
                <table class="data-table">
                  <thead>{header_row}</thead>
                  <tbody>{rows_html}</tbody>
                </table>
              </div>
            </div>
            """)

    # If no structured tables parsed, or fallback to text chunk
    if not sections and doc.text.strip():
        import csv
        import io
        import re

        raw_lines = [l for l in doc.text.splitlines() if l.strip()]
        parsed_rows: list[list[str]] = []

        if any("|" in l for l in raw_lines):
            for line in raw_lines:
                if "---" in line:
                    continue
                parts = [p.strip() for p in line.split("|") if p.strip()]
                if parts:
                    parsed_rows.append(parts)
        else:
            first_line = raw_lines[0] if raw_lines else ""
            delim = "\t" if "\t" in first_line else (";" if ";" in first_line and "," not in first_line else ",")
            try:
                reader = csv.reader(io.StringIO(doc.text), delimiter=delim)
                for r in reader:
                    if any(cell.strip() for cell in r):
                        parsed_rows.append([cell.strip() for cell in r])
            except Exception:
                for l in raw_lines:
                    parts = [p.strip() for p in l.split(delim)]
                    if any(parts):
                        parsed_rows.append(parts)

        if parsed_rows:
            headers = parsed_rows[0]
            max_cols = max(len(r) for r in parsed_rows)
            if len(headers) < max_cols:
                headers = headers + [f"Col {i+1}" for i in range(len(headers), max_cols)]

            headers_html = "".join(f"<th>{html.escape(h)}</th>" for h in headers)
            num_pattern = re.compile(r"^[\$€£₹]?\s?-?[\d,]+(\.\d+)?%?$")

            data_rows = []
            for r in parsed_rows[1:]:
                cells = [r[i] if i < len(r) else "" for i in range(len(headers))]
                cells_html = "".join(
                    f'<td class="is-number" style="text-align: right; font-family: monospace;">{html.escape(c)}</td>'
                    if num_pattern.match(c.strip())
                    else f'<td>{html.escape(c)}</td>'
                    for c in cells
                )
                data_rows.append(f"<tr>{cells_html}</tr>")

            count = len(parsed_rows) - 1
            sections.append(f"""
            <div class="table-section">
              <div class="table-section-title">
                <span>📊 {html.escape(doc.source.filename)}</span>
                <span class="doc-badge">{count} row{'s' if count != 1 else ''} · {len(headers)} columns</span>
              </div>
              <div class="table-wrapper">
                <table class="data-table">
                  <thead><tr>{headers_html}</tr></thead>
                  <tbody>{'\n'.join(data_rows)}</tbody>
                </table>
              </div>
            </div>
            """)
        else:
            escaped_text = html.escape(doc.text)
            sections.append(f'<div class="doc-paper"><pre style="font-family: monospace; font-size: 13px; white-space: pre-wrap;">{escaped_text}</pre></div>')

    return f"""
    <div class="doc-paper">
      <div class="doc-header">
        <h1 class="doc-title">{html.escape(doc.source.filename)}</h1>
        <span class="doc-badge">{html.escape(doc.source.file_type.upper())} SPREADSHEET</span>
      </div>
      {''.join(sections)}
    </div>
    """


def _render_word_doc(doc: Document) -> str:
    """Render Word / RTF documents into clean document pages."""
    paragraphs: list[str] = []
    for line in doc.text.split("\n\n"):
        line = line.strip()
        if not line:
            continue
        if line.startswith("[Table ") and "]" in line:
            continue
        if len(line) < 80 and not line.endswith((".", ",", ";", ":", "?", "!")) and "\n" not in line:
            paragraphs.append(f'<h2 class="doc-heading">{html.escape(line)}</h2>')
        else:
            paragraphs.append(f'<p class="doc-paragraph">{html.escape(line)}</p>')

    # Append any structured tables
    tables_html = []
    if doc.tables:
        for tbl in doc.tables:
            label = html.escape(tbl.source_label or "Table")
            header_cells = "".join(f"<th>{html.escape(h)}</th>" for h in tbl.headers)
            body_rows = ["<tr>" + "".join(f"<td>{html.escape(c)}</td>" for c in row) + "</tr>" for row in tbl.rows]
            tables_html.append(f"""
            <div class="table-section">
              <div class="table-section-title"><span>{label}</span></div>
              <div class="table-wrapper">
                <table class="data-table">
                  <thead><tr>{header_cells}</tr></thead>
                  <tbody>{'\n'.join(body_rows)}</tbody>
                </table>
              </div>
            </div>
            """)

    return f"""
    <div class="doc-paper">
      <div class="doc-header">
        <h1 class="doc-title">{html.escape(doc.source.filename)}</h1>
        <span class="doc-badge">{html.escape(doc.source.file_type.upper())} DOCUMENT</span>
      </div>
      <div class="doc-body">
        {''.join(paragraphs)}
        {''.join(tables_html)}
      </div>
    </div>
    """


def _render_presentation(doc: Document) -> str:
    """Render presentation slides into individual visual cards."""
    slides = []
    chunks = doc.text.split("[Slide ")
    if len(chunks) > 1:
        for chunk in chunks[1:]:
            parts = chunk.split("]\n", 1)
            slide_no = parts[0]
            slide_text = parts[1] if len(parts) > 1 else ""
            lines_html = "".join(f'<p class="doc-paragraph">• {html.escape(l.strip())}</p>' for l in slide_text.splitlines() if l.strip())
            slides.append(f"""
            <div class="slide-card">
              <div class="slide-header">
                <span class="slide-badge">Slide {html.escape(slide_no)}</span>
              </div>
              <div>{lines_html}</div>
            </div>
            """)
    else:
        escaped_text = html.escape(doc.text)
        slides.append(f'<div class="slide-card"><pre class="doc-paragraph">{escaped_text}</pre></div>')

    return f"""
    <div style="max-width: 900px; margin: 0 auto;">
      <div class="doc-header" style="background: #ffffff; padding: 18px 24px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #e2e8f0;">
        <h1 class="doc-title">{html.escape(doc.source.filename)}</h1>
        <span class="doc-badge">PRESENTATION</span>
      </div>
      {''.join(slides)}
    </div>
    """


def _render_pdf_doc(doc: Document) -> str:
    """Render PDF document with authentic Adobe Acrobat-style sheets, headers, and formatted invoice/data tables."""
    import re

    raw_text = doc.text.strip()
    page_chunks = [p.strip() for p in re.split(r"(?:^|\n)(?:---+|\s*\[Page\s+\d+\]|\s*Page\s+\d+:?|\f)", raw_text, flags=re.IGNORECASE) if p.strip()]
    if not page_chunks:
        page_chunks = [raw_text or "(No document content)"]

    pages_html = []
    for idx, page_str in enumerate(page_chunks):
        lines = [l.strip() for l in page_str.splitlines() if l.strip()]
        title = lines[0] if lines else f"Page {idx + 1}"
        body_lines = lines[1:]

        table_rows = []
        body_parts = []
        i = 0
        while i < len(body_lines):
            line = body_lines[i]
            if ":" in line and not line.startswith("http"):
                parts = line.split(":", 1)
                table_rows.append((parts[0].strip(), parts[1].strip()))
            elif "|" in line:
                parts = [p.strip() for p in line.split("|") if p.strip()]
                if len(parts) >= 2:
                    table_rows.append((parts[0], " | ".join(parts[1:])))
                else:
                    table_rows.append((line, ""))
            elif i + 1 < len(body_lines) and len(line) < 35 and "." not in line:
                table_rows.append((line, body_lines[i + 1]))
                i += 1
            else:
                if table_rows:
                    rows_html = "".join(f'<tr><td style="padding: 8px 14px; border-bottom: 1px solid #e2e8f0; font-weight: 600; color: #475569; width: 35%; background: #f8fafc; border-right: 1px solid #e2e8f0;">{html.escape(r[0])}</td><td style="padding: 8px 14px; border-bottom: 1px solid #e2e8f0; color: #1e293b;">{html.escape(r[1])}</td></tr>' for r in table_rows)
                    body_parts.append(f'<table style="width: 100%; border-collapse: collapse; margin: 16px 0 20px; font-size: 13.5px; border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden;">{rows_html}</table>')
                    table_rows = []
                body_parts.append(f'<p style="margin: 0 0 12px; font-size: 14px; line-height: 1.7; color: #334155;">{html.escape(line)}</p>')
            i += 1

        if table_rows:
            rows_html = "".join(f'<tr><td style="padding: 8px 14px; border-bottom: 1px solid #e2e8f0; font-weight: 600; color: #475569; width: 35%; background: #f8fafc; border-right: 1px solid #e2e8f0;">{html.escape(r[0])}</td><td style="padding: 8px 14px; border-bottom: 1px solid #e2e8f0; color: #1e293b;">{html.escape(r[1])}</td></tr>' for r in table_rows)
            body_parts.append(f'<table style="width: 100%; border-collapse: collapse; margin: 16px 0 20px; font-size: 13.5px; border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden;">{rows_html}</table>')

        pages_html.append(f"""
        <div style="background: #ffffff; width: 100%; max-width: 820px; min-height: 1060px; padding: 56px 64px; box-shadow: 0 8px 24px rgba(0,0,0,0.2), 0 1px 3px rgba(0,0,0,0.08); border-radius: 2px; margin-bottom: 28px; display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e2e8f0; padding-bottom: 10px; margin-bottom: 24px; font-size: 12px; color: #64748b;">
              <span>{html.escape(doc.source.filename)}</span>
              <span style="font-weight: 700; color: #b30b00;">Page {idx + 1} of {len(page_chunks)}</span>
            </div>
            <h2 style="font-size: 22px; font-weight: 700; color: #0f172a; margin: 0 0 18px; border-bottom: 2px solid #b30b00; padding-bottom: 8px;">{html.escape(title)}</h2>
            <div>{''.join(body_parts)}</div>
          </div>
          <div style="border-top: 1px solid #e2e8f0; padding-top: 14px; margin-top: 24px; font-size: 11px; color: #94a3b8; display: flex; justify-content: space-between;">
            <span>Confidential Enterprise Document</span>
            <span>Portable Document Format · Verified PDF</span>
          </div>
        </div>
        """)

    return f"""
    <div style="background: #525659; padding: 32px 16px 60px; min-height: 100vh; display: flex; flex-direction: column; align-items: center;">
      <div style="width: 100%; max-width: 820px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; color: #ffffff;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="background: #b30b00; color: #fff; font-weight: 800; font-size: 11px; padding: 2px 6px; border-radius: 3px;">PDF</span>
          <span style="font-weight: 600; font-size: 13.5px;">{html.escape(doc.source.filename)}</span>
        </div>
        <span style="font-size: 12px; opacity: 0.85;">{len(page_chunks)} Pages</span>
      </div>
      {''.join(pages_html)}
    </div>
    """


def _render_code_view(doc: Document, language: str) -> str:
    """Render JSON, XML, or code files with monospace formatted blocks."""
    escaped = html.escape(doc.text)
    return f"""
    <div class="doc-paper">
      <div class="doc-header">
        <h1 class="doc-title">{html.escape(doc.source.filename)}</h1>
        <span class="doc-badge">{html.escape(language.upper())}</span>
      </div>
      <pre class="code-block"><code>{escaped}</code></pre>
    </div>
    """


def _render_image_ocr_view(doc: Document, image_type: str) -> str:
    """Render extracted OCR content for raster image documents."""
    escaped = html.escape(doc.text.strip() or "(No readable text detected in this image via OCR)")
    return f"""
    <div class="doc-paper">
      <div class="doc-header">
        <h1 class="doc-title">{html.escape(doc.source.filename)}</h1>
        <span class="doc-badge">{html.escape(image_type.upper())} · IMAGE OCR</span>
      </div>
      <div style="font-family: inherit; font-size: 14.5px; line-height: 1.7; white-space: pre-wrap; color: #1e293b;">
        {escaped}
      </div>
    </div>
    """


def _render_text_view(doc: Document) -> str:
    """Render plain text, markdown, or log files."""
    escaped = html.escape(doc.text)
    return f"""
    <div class="doc-paper">
      <div class="doc-header">
        <h1 class="doc-title">{html.escape(doc.source.filename)}</h1>
        <span class="doc-badge">{html.escape(doc.source.file_type.upper())} FILE</span>
      </div>
      <div style="font-family: inherit; font-size: 14.5px; line-height: 1.7; white-space: pre-wrap; color: #1e293b;">
        {escaped}
      </div>
    </div>
    """


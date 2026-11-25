"""Document extraction and structured record extraction routines."""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta
from typing import Any, Callable, Iterable

from backend.documents.parsers import (
    CSVParser,
    ExcelParser,
    HTMLParser,
    ImageParser,
    JSONParser,
    PDFParser,
    PPTXParser,
    RTFParser,
    TSVParser,
    TextParser,
    WordParser,
    XMLParser,
)
from backend.documents.service import DocumentProcessingService
from backend.security.authorization import UserAttributes
from backend.sources.models import SourceReference, SourceType

logger = logging.getLogger(__name__)


def create_default_document_service() -> DocumentProcessingService:
    """Instantiate the standard multi-format document processing engine."""
    return DocumentProcessingService([
        PDFParser(),
        WordParser(),
        ExcelParser(),
        CSVParser(),
        TSVParser(),
        PPTXParser(),
        TextParser(),
        RTFParser(),
        HTMLParser(),
        JSONParser(),
        XMLParser(),
        ImageParser(),
    ])


def _matches_status(status: str, status_filter: str | None, is_overdue: bool = False) -> bool:
    if not status_filter:
        return True
    sf = status_filter.strip().casefold()
    s = status.strip().casefold()
    if sf == "unpaid_all":
        is_explicit_paid = (
            ("paid" in s and "unpaid" not in s and not is_overdue)
            or "settled" in s
            or "cleared" in s
        )
        return not is_explicit_paid
    if sf in ("pending", "unpaid", "due"):
        return (
            any(k in s for k in ("pending", "scheduled", "approved", "review", "due", "unpaid"))
            and ("paid" not in s or "unpaid" in s)
            and "overdue" not in s
            and not is_overdue
        )
    if sf == "overdue":
        return is_overdue or "overdue" in s
    if sf == "paid":
        return ("paid" in s and "unpaid" not in s and not is_overdue) or "settled" in s
    return sf in s


_DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%d %B %Y",
    "%d %b %Y",
    "%B %d, %Y",
    "%b %d, %Y",
    "%B %d %Y",
    "%b %d %Y",
    "%d-%m-%Y",
    "%d/%m/%Y",
    "%m/%d/%Y",
    "%m-%d-%Y",
)


def parse_flexible_date(raw: str | None) -> date | None:
    """Parse common ISO, numeric, and long-month date strings into a date object."""
    if not raw:
        return None
    cleaned = _clean_str(raw)
    if not cleaned:
        return None
    # Strip trailing time/timezone components such as 2026-10-31 00:00:00
    cleaned = re.sub(r"\s+\d{1,2}:\d{2}(?::\d{2})?.*$", "", cleaned).strip()
    cleaned = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", cleaned, flags=re.IGNORECASE)
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(cleaned, fmt).date()
        except ValueError:
            continue
    iso_m = re.search(r"\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b", cleaned)
    if iso_m:
        cand = iso_m.group(1).replace("/", "-")
        try:
            return datetime.strptime(cand, "%Y-%m-%d").date()
        except ValueError:
            pass
    return None


def _evaluate_invoice_dates_and_overdue(
    status: str,
    invoice_date_raw: str,
    due_date_raw: str,
    payment_terms_raw: str = "",
    reference_date: date | None = None,
) -> tuple[str, str, str, bool, int]:
    """Compute effective status, normalized dates, and overdue flag/days for an invoice."""
    today = reference_date or date.today()
    inv_dt = parse_flexible_date(invoice_date_raw)
    due_dt = parse_flexible_date(due_date_raw)
    terms_days: int | None = None
    if payment_terms_raw:
        net_m = re.search(r"\b(?:net\s*)?(\d{1,3})\s*days?\b", payment_terms_raw, re.IGNORECASE)
        if net_m:
            terms_days = int(net_m.group(1))
    if due_dt is None and inv_dt is not None and terms_days is not None:
        due_dt = inv_dt + timedelta(days=terms_days)

    norm_inv = inv_dt.isoformat() if inv_dt else _clean_str(invoice_date_raw)
    norm_due = due_dt.isoformat() if due_dt else _clean_str(due_date_raw)

    s_low = (status or "").strip().casefold()
    is_paid = ("paid" in s_low and "unpaid" not in s_low and "overdue" not in s_low) or "settled" in s_low
    days_overdue = 0
    if due_dt is not None and not is_paid and due_dt < today:
        days_overdue = (today - due_dt).days

    explicit_overdue = "overdue" in s_low
    is_overdue = explicit_overdue or (days_overdue > 0)
    eff_status = _clean_str(status) or "Pending"
    if is_overdue and "overdue" not in eff_status.casefold():
        eff_status = f"Overdue ({eff_status})" if eff_status.casefold() != "pending" else "Overdue"
    return eff_status, norm_inv, norm_due, is_overdue, days_overdue


def _clean_str(val: Any) -> str:
    if val is None:
        return ""
    s = str(val).strip()
    s = s.replace("\u25a0", "").replace("\xa0", " ").replace("\u2013", "-").replace("\u2014", "-")
    s = re.sub(r"[\r\n\t]+", " ", s)
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip()


def extract_invoice_records_from_files(
    indexed_files: dict[str, dict[str, Any]],
    is_folder_authorized: Callable[[UserAttributes, str], bool],
    user: UserAttributes,
    status_filter: str | None = None,
    entity_filter: str | None = None,
    limit: int = 50,
    year_filter: int | None = None,
) -> tuple[list[dict[str, Any]], list[SourceReference]]:
    """Extract structured invoice records from real company finance documents."""
    records: list[dict[str, Any]] = []
    sources: list[SourceReference] = []
    seen_ids: set[str] = set()
    seen_refs: set[str] = set()

    for rel_path, info in indexed_files.items():
        folder = info.get("folder", "General")
        if not is_folder_authorized(user, folder):
            continue
        filename = info["filename"]
        content = info.get("content", "")
        if (
            "invoice" not in filename.lower()
            and "invoice" not in content.lower()
            and "payment" not in filename.lower()
            and "billing" not in filename.lower()
        ):
            continue

        # 1. Check for tabular rows (e.g. CSV or spreadsheet schedules with pipe |)
        table_lines = [l.strip() for l in content.split("\n") if "|" in l]
        if len(table_lines) >= 2:
            header_line = table_lines[0].casefold()
            if "invoice" in header_line or "vendor" in header_line or "amount" in header_line:
                raw_headers = [h.strip().casefold() for h in table_lines[0].split("|")]
                for line in table_lines[1:]:
                    parts = [p.strip() for p in line.split("|")]
                    if len(parts) != len(raw_headers):
                        continue
                    row_dict = dict(zip(raw_headers, parts))
                    inv_id = None
                    amount = None
                    status = "Pending"
                    invoice_date = ""
                    due_date = ""
                    comp_name = ""
                    vendor = ""
                    for h, val in row_dict.items():
                        if "invoice id" in h or h == "inv" or (not inv_id and val.upper().startswith("INV-")):
                            inv_id = val
                        elif any(k in h for k in ("amount", "total", "cost", "price")):
                            amount = val
                        elif "status" in h:
                            status = val
                        elif "due" in h and "date" in h:
                            due_date = val
                        elif "invoice" in h and "date" in h:
                            invoice_date = val
                        elif "date" in h and not due_date and not invoice_date:
                            invoice_date = val
                        elif any(k in h for k in ("customer", "client", "account")):
                            comp_name = val
                        elif "vendor" in h:
                            vendor = val

                    if inv_id and amount:
                        if inv_id in seen_ids:
                            continue
                        eff_status, norm_inv_date, norm_due_date, is_overdue, days_overdue = _evaluate_invoice_dates_and_overdue(
                            status=status,
                            invoice_date_raw=invoice_date,
                            due_date_raw=due_date,
                        )
                        if not _matches_status(eff_status, status_filter, is_overdue=is_overdue):
                            continue
                        if year_filter is not None:
                            ref_dt = norm_inv_date or norm_due_date
                            if not ref_dt.startswith(f"{year_filter}-"):
                                continue
                        if entity_filter:
                            ef = entity_filter.casefold()
                            if ef not in comp_name.casefold() and ef not in vendor.casefold() and ef not in inv_id.casefold():
                                continue
                        seen_ids.add(inv_id)
                        display_comp = comp_name or vendor or "Enterprise Client"
                        records.append({
                            "id": _clean_str(inv_id),
                            "customer": _clean_str(display_comp),
                            "has_explicit_customer": bool(_clean_str(comp_name)),
                            "vendor": _clean_str(vendor),
                            "amount": _clean_str(amount),
                            "currency": "$" if "($)" in header_line or "$" in str(amount) else "INR",
                            "status": eff_status,
                            "raw_status": _clean_str(status),
                            "invoice_date": norm_inv_date,
                            "due_date": norm_due_date,
                            "is_overdue": is_overdue,
                            "days_overdue": days_overdue,
                            "file_path": rel_path,
                            "filename": filename,
                            "full_path": info.get("full_path") or info.get("file_path") or rel_path,
                        })
                        if rel_path not in seen_refs:
                            seen_refs.add(rel_path)
                            sources.append(SourceReference(
                                reference_id=f"ref-inv-{inv_id}",
                                source_type=SourceType.FILE,
                                display_name=f"[Finance] {filename}",
                                title=f"{filename} - {inv_id}",
                                location=info.get("full_path") or info.get("file_path", ""),
                            ))
                        if len(records) >= limit:
                            break

        if len(records) >= limit:
            break

        # 2. Key-value formatted documents (PDF, DOCX, TXT)
        inv_id_m = (
            re.search(r"(?:Invoice\s*(?:ID|#|No\.?|Number))\s*[:\n\-]\s*([A-Za-z0-9-]+)", content, re.IGNORECASE)
            or re.search(r"\b(INV-[A-Za-z0-9-]+)\b", content, re.IGNORECASE)
        )
        total_m = (
            re.search(r"\b(?:Grand\s*Total|Total\s*Amount|Amount\s*Due)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            or re.search(r"(?:^|\n)\s*(?:Total|Amount|Balance)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
        )
        if not inv_id_m or not total_m:
            continue

        inv_id = inv_id_m.group(1).strip()
        if inv_id in seen_ids:
            continue

        vendor_m = re.search(r"(?:Vendor\s*(?:Name)?|Provider|From|Billed\s*By)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
        customer_m = re.search(r"(?:Customer\s*(?:Name)?|Client|Bill\s*To|Billed\s*To|Company)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
        status_m = re.search(r"(?:Payment\s*Status|Status)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
        invoice_date_m = re.search(r"(?:Invoice\s*Date)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
        due_date_m = re.search(r"(?:Due\s*Date|Payment\s*Due)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
        terms_m = re.search(r"(?:Payment\s*Terms|Terms)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
        generic_date_m = (
            None
            if (invoice_date_m or due_date_m)
            else re.search(r"\bDate\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
        )

        vendor = vendor_m.group(1).strip() if vendor_m else ""
        if not vendor:
            # Fallback for vendor-header style PDFs (line right after INVOICE banner)
            header_vendor_m = re.search(r"^INVOICE\s*\n+([A-Z][^\n]{3,80})", content, re.IGNORECASE | re.MULTILINE)
            if header_vendor_m and "synthetic" not in header_vendor_m.group(1).casefold():
                vendor = header_vendor_m.group(1).strip()
        customer = customer_m.group(1).strip() if customer_m else ""
        raw_status = status_m.group(1).strip() if status_m else ("Overdue" if "overdue" in content.lower() else "Pending")
        raw_inv_date = invoice_date_m.group(1).strip() if invoice_date_m else (generic_date_m.group(1).strip() if generic_date_m else "")
        raw_due_date = due_date_m.group(1).strip() if due_date_m else ""
        raw_terms = terms_m.group(1).strip() if terms_m else ""
        total_raw = total_m.group(1).strip()

        eff_status, norm_inv_date, norm_due_date, is_overdue, days_overdue = _evaluate_invoice_dates_and_overdue(
            status=raw_status,
            invoice_date_raw=raw_inv_date,
            due_date_raw=raw_due_date,
            payment_terms_raw=raw_terms,
        )

        if not _matches_status(eff_status, status_filter, is_overdue=is_overdue):
            continue
        if year_filter is not None:
            ref_dt = norm_inv_date or norm_due_date
            if not ref_dt.startswith(f"{year_filter}-"):
                continue

        if entity_filter:
            ef = entity_filter.casefold()
            if ef not in customer.casefold() and ef not in vendor.casefold() and ef not in inv_id.casefold():
                continue

        seen_ids.add(inv_id)
        has_explicit_cust = bool(customer and customer.casefold() != "synthetic")
        comp_name = customer if has_explicit_cust else (vendor or "Enterprise Client")

        records.append({
            "id": _clean_str(inv_id),
            "customer": _clean_str(comp_name),
            "has_explicit_customer": has_explicit_cust,
            "vendor": _clean_str(vendor),
            "amount": _clean_str(total_raw),
            "currency": "INR" if "inr" in total_raw.lower() or "₹" in total_raw else ("$" if "$" in total_raw else "INR"),
            "status": eff_status,
            "raw_status": _clean_str(raw_status),
            "invoice_date": norm_inv_date,
            "due_date": norm_due_date,
            "payment_terms": _clean_str(raw_terms),
            "is_overdue": is_overdue,
            "days_overdue": days_overdue,
            "file_path": rel_path,
            "filename": filename,
            "full_path": info.get("full_path") or info.get("file_path") or rel_path,
        })

        if rel_path not in seen_refs:
            seen_refs.add(rel_path)
            sources.append(SourceReference(
                reference_id=f"ref-inv-{inv_id}",
                source_type=SourceType.FILE,
                display_name=f"[Finance] {filename}",
                title=f"{filename} - {inv_id}",
                location=info.get("full_path") or info.get("file_path", ""),
            ))

        if len(records) >= limit:
            break

    if not status_filter:
        records.sort(key=lambda r: (0 if r.get("is_overdue") else 1, -(r.get("days_overdue") or 0)))

    return records, sources


def _matches_invoice_entity(rec: dict[str, Any], entity_filter: str) -> bool:
    ef = (entity_filter or "").strip().casefold()
    if not ef:
        return True
    hay = f"{rec.get('customer') or ''} {rec.get('vendor') or ''} {rec.get('id') or ''}".casefold()
    if ef in hay:
        return True
    toks = [t for t in re.findall(r"[a-z0-9]+", ef) if len(t) >= 2]
    return bool(toks and all(re.search(rf"\b{re.escape(t)}", hay) for t in toks))


def _fmt_invoice_amount_display(raw: Any) -> str:
    s = str(raw or "").strip()
    if not s:
        return "—"
    if re.fullmatch(r"\d+(?:\.\d+)?", s):
        try:
            num = float(s)
            return f"{num:,.2f}" if "." in s else f"{int(num):,}"
        except ValueError:
            return s
    return s


def _sanitize_md_cell(val: Any) -> str:
    return re.sub(r"\s+", " ", str(val or "").replace("|", "/")).strip() or "—"


def _short_filename(raw_path: Any) -> str:
    s = str(raw_path or "").strip()
    if not s:
        return ""
    return s.replace("\\", "/").rsplit("/", 1)[-1]


def format_structured_invoice_analysis(
    records: list[dict[str, Any]],
    inv_filter: dict[str, Any] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Build deterministic markdown analysis & exact filtered record list for invoice status/date/customer queries.

    Returns (summary_markdown, filtered_records).
    """
    spec = inv_filter or {}
    status_filter = spec.get("status_filter")
    year_filter = spec.get("year")
    group_by = spec.get("group_by")
    entity_filter = str(spec.get("entity_filter") or "").strip()

    entity_records = [r for r in records if _matches_invoice_entity(r, entity_filter)] if entity_filter else list(records)
    filtered = list(entity_records)
    if status_filter:
        filtered = [
            r for r in filtered
            if _matches_status(str(r.get("status") or ""), status_filter, is_overdue=bool(r.get("is_overdue")))
        ]
    if year_filter is not None:
        yp = f"{int(year_filter)}-"
        filtered = [
            r for r in filtered
            if str(r.get("invoice_date") or r.get("due_date") or "").startswith(yp)
        ]

    if group_by == "customers":
        cust_rows = [r for r in filtered if r.get("has_explicit_customer")]
        if cust_rows:
            filtered = cust_rows

    if not filtered:
        parts = []
        if status_filter == "paid":
            parts.append("paid")
        elif status_filter == "unpaid_all":
            parts.append("unpaid / pending / overdue")
        elif status_filter:
            parts.append(str(status_filter))
        if year_filter:
            parts.append(f"year {year_filter}")
        desc = " ".join(parts) or "matching"
        ent_note = f" for **{entity_filter.title()}**" if entity_filter else ""
        msg = f"No {desc} invoice records{ent_note} were found in your authorized documents."
        if entity_filter and entity_records:
            st_counts: dict[str, int] = {}
            for er in entity_records:
                st = str(er.get("status") or "Unknown")
                st_counts[st] = st_counts.get(st, 0) + 1
            st_desc = ", ".join(f"{k}: {v}" for k, v in sorted(st_counts.items()))
            msg += f" *(Note: Found **{len(entity_records)}** other invoice(s) on file for **{entity_filter.title()}** — {st_desc}.)*"
        return msg, []

    if group_by == "customers":
        grouped: dict[str, list[dict[str, Any]]] = {}
        for r in filtered:
            key = str(r.get("customer") or r.get("vendor") or "Unknown Customer").strip()
            grouped.setdefault(key, []).append(r)

        status_label = "unpaid / overdue" if status_filter in ("unpaid_all", "pending", "overdue") else (status_filter or "")
        yr_note = f" in {year_filter}" if year_filter else ""
        yr_note = f" ({year_filter})" if year_filter else ""
        ent_note = f" matching **{entity_filter.title()}**" if entity_filter else ""
        lines = [
            f"Found **{len(grouped)} unique customer{'s' if len(grouped) != 1 else ''}** with {status_label} invoices{yr_note}{ent_note} (**{len(filtered)}** total invoice record{'s' if len(filtered) != 1 else ''}):\n"
            f"Found **{len(grouped)} customer{'s' if len(grouped) != 1 else ''}** with {status_label} invoices{yr_note}{ent_note} (**{len(filtered)}** invoice{'s' if len(filtered) != 1 else ''}):\n"
        ]
        for cust_name in sorted(grouped.keys()):
        for cust_name in sorted(grouped.keys())[:6]:
            items = grouped[cust_name]
            total_sum = 0.0
            cur_sym = ""
            inv_bits: list[str] = []
            for it in items:
                amt_num = _parse_numeric_amount(it.get("amount"))
                if amt_num is not None:
                    total_sum += amt_num
                if not cur_sym:
                    raw_a = str(it.get("amount") or "")
                    cur_sym = "INR " if ("INR" in raw_a.upper() or "₹" in raw_a) else ("$ " if "$" in raw_a else "")
                st = str(it.get("status") or "")
                dt = str(it.get("invoice_date") or "")
                inv_bits.append(f"`{it.get('id')}` ({st}{f', {dt}' if dt else ''}, {it.get('amount')})")
            sum_disp = f"{cur_sym}{total_sum:,.2f}" if total_sum > 0 else "N/A"
            inv_ids = ", ".join(f"`{it.get('id')}`" for it in items[:4])
            more_ids = f" +{len(items) - 4} more" if len(items) > 4 else ""
            lines.append(
                f"• **{cust_name}** — **{len(items)}** {status_label} invoice{'s' if len(items) != 1 else ''} · Total Due: **{sum_disp}**\n"
                f"  - Invoices: {', '.join(inv_bits[:8])}"
                + (f" *(+{len(inv_bits) - 8} more)*" if len(inv_bits) > 8 else "")
                f"• **{cust_name}** — **{len(items)}** invoice{'s' if len(items) != 1 else ''} · Total Due: **{sum_disp}** ({inv_ids}{more_ids})"
            )
        if len(grouped) > 6 or len(filtered) > 5:
            lines.extend([
                "",
                "| Customer | Invoice | Amount | Status | Date | Source |",
                "| --- | --- | --- | --- | --- | --- |",
            ])
            for r in filtered[:50]:
                cname = _sanitize_md_cell(r.get("customer") or r.get("vendor") or "Unknown")
                dt = _sanitize_md_cell(r.get("due_date") or r.get("invoice_date") or "—")
                src = _sanitize_md_cell(_short_filename(r.get("file_path") or r.get("filename")))
                lines.append(
                    f"| {cname} | {_sanitize_md_cell(r.get('id'))} | {_sanitize_md_cell(_fmt_invoice_amount_display(r.get('amount')))} | {_sanitize_md_cell(r.get('status') or '—')} | {dt} | {src} |"
                )
        return "\n".join(lines), filtered

    # Flat per-invoice structured summary
    desc_bits = []
    if status_filter == "paid":
        desc_bits.append("already **Paid**")
        desc_bits.append("paid")
    elif status_filter == "unpaid_all":
        desc_bits.append("**Unpaid / Overdue / Pending**")
        desc_bits.append("unpaid / overdue")
    elif status_filter == "overdue":
        desc_bits.append("**Overdue**")
        desc_bits.append("overdue")
    elif status_filter == "pending":
        desc_bits.append("**Pending / Unpaid**")
        desc_bits.append("pending")
    if year_filter:
        desc_bits.append(f"from **{year_filter}**")
    hdr_desc = " ".join(desc_bits) if desc_bits else "matching"
    ent_hdr = f" for **{entity_filter.title()}**" if entity_filter else ""

    unique_parties = {
        str(r.get("customer") or r.get("vendor") or "").strip().casefold()
        for r in filtered
        if str(r.get("customer") or r.get("vendor") or "").strip()
    }
    years = sorted({
        str(r.get("invoice_date") or r.get("due_date") or "")[:4]
        for r in filtered
        if len(str(r.get("invoice_date") or r.get("due_date") or "")) >= 4
        and str(r.get("invoice_date") or r.get("due_date") or "")[:4].isdigit()
    })
    year_span = ""
    if not year_filter and len(years) == 1:
        year_span = f" ({years[0]})"
    elif not year_filter and len(years) > 1:
        year_span = f" ({years[0]}–{years[-1]})"

    party_note = f" across **{len(unique_parties)}** vendors/customers" if len(unique_parties) > 1 and not entity_filter else ""
    lines = [
        f"Found **{len(filtered)}** verified {hdr_desc} invoice record{'s' if len(filtered) != 1 else ''}{ent_hdr}:\n"
        f"Found **{len(filtered)}** {hdr_desc} invoice{'s' if len(filtered) != 1 else ''}{ent_hdr}{party_note}{year_span}:\n"
    ]
    for r in filtered[:25]:
        party = r.get("customer") or r.get("vendor") or "Unknown"
        vend = r.get("vendor")
        party_str = f"{party} (Vendor: {vend})" if vend and vend != party else party
        dates = []
        if r.get("invoice_date"):
            dates.append(f"Inv Date: {r['invoice_date']}")
        if r.get("due_date"):
            due_bit = f"Due: {r['due_date']}"
            if r.get("days_overdue"):
                due_bit += f" ({r['days_overdue']}d overdue)"
            dates.append(due_bit)
        date_str = " · ".join(dates) if dates else "Date: N/A"
        lines.append(
            f"• **{r.get('id')}** — {party_str} · Amount: **{r.get('amount')}** · Status: **{r.get('status')}** · {date_str}"
            + (f" · File: `{r.get('file_path') or r.get('filename')}`" if (r.get("file_path") or r.get("filename")) else "")
        )
    if len(filtered) > 25:
        lines.append(f"\n*... and {len(filtered) - 25} more verified matching invoice records.*")
    if len(filtered) > 5:
        lines.append("**Key Highlights**")

    for r in filtered[:5]:
        party = str(r.get("customer") or r.get("vendor") or "Unknown").strip()
        amt_disp = _fmt_invoice_amount_display(r.get("amount"))
        st = str(r.get("status") or "").strip()
        if status_filter == "paid":
            date_disp = str(r.get("invoice_date") or (f"Due {r['due_date']}" if r.get("due_date") else "")).strip()
            status_note = ""
        else:
            if r.get("due_date"):
                date_disp = f"Due {r['due_date']}" + (f" ({r['days_overdue']}d late)" if r.get("days_overdue") else "")
            else:
                date_disp = str(r.get("invoice_date") or "").strip()
            status_note = f" · {st}" if st else ""
        src_name = _short_filename(r.get("file_path") or r.get("filename"))
        meta_bits = [b for b in (date_disp, f"`{src_name}`" if src_name else "") if b]
        meta_str = f" ({' · '.join(meta_bits)})" if meta_bits else ""
        lines.append(f"• **{r.get('id')}** — {party} · **{amt_disp}**{status_note}{meta_str}")

    if len(filtered) > 5:
        lines.append("")
        if status_filter == "paid":
            lines.extend([
                "| Invoice | Party | Amount | Date | Source |",
                "| --- | --- | --- | --- | --- |",
            ])
            for r in filtered[:50]:
                party = _sanitize_md_cell(r.get("customer") or r.get("vendor") or "Unknown")
                dt = _sanitize_md_cell(r.get("invoice_date") or r.get("due_date") or "—")
                src = _sanitize_md_cell(_short_filename(r.get("file_path") or r.get("filename")))
                lines.append(
                    f"| {_sanitize_md_cell(r.get('id'))} | {party} | {_sanitize_md_cell(_fmt_invoice_amount_display(r.get('amount')))} | {dt} | {src} |"
                )
        else:
            lines.extend([
                "| Invoice | Party | Amount | Status | Date | Source |",
                "| --- | --- | --- | --- | --- | --- |",
            ])
            for r in filtered[:50]:
                party = _sanitize_md_cell(r.get("customer") or r.get("vendor") or "Unknown")
                dt = _sanitize_md_cell(r.get("due_date") or r.get("invoice_date") or "—")
                src = _sanitize_md_cell(_short_filename(r.get("file_path") or r.get("filename")))
                lines.append(
                    f"| {_sanitize_md_cell(r.get('id'))} | {party} | {_sanitize_md_cell(_fmt_invoice_amount_display(r.get('amount')))} | {_sanitize_md_cell(r.get('status') or '—')} | {dt} | {src} |"
                )
    return "\n".join(lines), filtered


def _is_valid_entity_name(name: str) -> bool:
    if not name or len(name) < 2 or len(name) > 90:
        return False
    low = name.strip().casefold()
    if low in {"n/a", "na", "none", "null", "unknown", "value", "field", "synthetic", "tbd", "name"}:
        return False
    if low.startswith(("synthetic ", "not real")):
        return False
    return bool(re.search(r"[a-zA-Z]", name))


def _parse_numeric_amount(raw: Any) -> float | None:
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    cleaned = re.sub(r"[^\d.]", "", str(raw).replace(",", ""))
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _record_entity(
    bucket: dict[str, dict[str, Any]],
    key: str,
    payload: dict[str, Any],
    file_path: str,
) -> None:
    norm_key = key.strip().upper()
    if not norm_key:
        return
    existing = bucket.get(norm_key)
    if existing is None:
        item = dict(payload)
        item["files"] = [file_path] if file_path else []
        bucket[norm_key] = item
    else:
        for k, v in payload.items():
            if v and not existing.get(k):
                existing[k] = v
        if file_path and file_path not in existing["files"] and len(existing["files"]) < 8:
            existing["files"].append(file_path)


def aggregate_entities_from_documents(
    documents: Iterable[dict[str, Any]],
    entity_kind: str = "all",
    preview_limit: int = 100,
    include_all: bool = False,
) -> dict[str, Any]:
    """Scan all authorized documents to count and deduplicate employees, customers, and vendors."""
    want_emp = entity_kind in ("all", "employee", "employees")
    want_cust = entity_kind in ("all", "customer", "customers")
    want_vend = entity_kind in ("all", "vendor", "vendors")

    employees: dict[str, dict[str, Any]] = {}
    customers: dict[str, dict[str, Any]] = {}
    vendors: dict[str, dict[str, Any]] = {}
    emp_files: set[str] = set()
    cust_files: set[str] = set()
    vend_files: set[str] = set()
    scanned_files = 0

    for doc in documents:
        scanned_files += 1
        filename = str(doc.get("filename") or doc.get("name") or "")
        rel_path = str(doc.get("relative_path") or doc.get("file_path") or doc.get("display_path") or filename)
        content = str(doc.get("content") or doc.get("text") or "")
        if not content:
            continue
        fn_low = filename.casefold()
        path_low = rel_path.casefold()
        head_low = content[:500].casefold()

        # 1. Structured tabular lines (| separated from CSV/XLSX parsers or comma rows)
        lines = content.splitlines()
        pipe_groups: list[tuple[list[str], list[list[str]]]] = []
        cur_headers: list[str] | None = None
        cur_rows: list[list[str]] = []
        for raw_line in lines:
            s_line = raw_line.strip()
            if "|" in s_line:
                cells = [c.strip() for c in s_line.split("|")]
                if all((not c) or (set(c) <= {"-", ":", " "}) for c in cells):
                    continue
                if cur_headers is None:
                    if any(h in " | ".join(cells).casefold() for h in (
                        "employee", "emp_id", "customer", "client", "vendor", "merchant", "name", "department", "account"
                    )):
                        cur_headers = [c.casefold() for c in cells]
                        cur_rows = []
                elif len(cells) == len(cur_headers):
                    cur_rows.append(cells)
            else:
                if cur_headers and cur_rows:
                    pipe_groups.append((cur_headers, cur_rows))
                cur_headers = None
                cur_rows = []
        if cur_headers and cur_rows:
            pipe_groups.append((cur_headers, cur_rows))

        for headers, rows in pipe_groups:
            h_joined = " ".join(headers)
            is_emp_table = (
                "employee_id" in h_joined
                or "employee id" in h_joined
                or ("employee" in fn_low or "attendance" in fn_low or "hr_" in fn_low)
                and "name" in h_joined
            )
            is_cust_table = (
                "customer_id" in h_joined
                or "customer id" in h_joined
                or "customer name" in h_joined
                or ("customer" in fn_low or "orders" in fn_low) and "name" in h_joined
            )
            is_vend_table = "vendor" in h_joined or "merchant" in h_joined

            for row in rows:
                row_map = dict(zip(headers, row))
                if want_emp and is_emp_table:
                    eid = (row_map.get("employee_id") or row_map.get("employee id") or row_map.get("emp_id") or "").strip()
                    ename = _clean_str(row_map.get("name") or row_map.get("employee name") or "")
                    dept = _clean_str(row_map.get("department") or "")
                    role = _clean_str(row_map.get("role") or row_map.get("title") or "")
                    status = _clean_str(row_map.get("status") or "")
                    sal_raw = _clean_str(row_map.get("salary") or row_map.get("annual salary") or row_map.get("compensation") or row_map.get("ctc") or "")
                    salary_val = _parse_numeric_amount(sal_raw)
                    if eid or _is_valid_entity_name(ename):
                        emp_files.add(rel_path)
                        _record_entity(
                            employees,
                            eid or ename,
                            {
                                "id": eid,
                                "name": ename or eid,
                                "department": dept,
                                "role": role,
                                "status": status,
                                "salary": salary_val,
                                "salary_display": sal_raw,
                            },
                            rel_path,
                        )
                if want_cust and is_cust_table:
                    cid = (row_map.get("customer_id") or row_map.get("customer id") or "").strip()
                    cname = _clean_str(
                        row_map.get("customer name") or row_map.get("name") or row_map.get("account name") or ""
                    )
                    city = _clean_str(row_map.get("city") or "")
                    seg = _clean_str(row_map.get("segment") or row_map.get("tier") or row_map.get("customer_type") or "")
                    ind = _clean_str(row_map.get("industry") or "")
                    status = _clean_str(row_map.get("status") or row_map.get("account_status") or "")
                    val_raw = _clean_str(
                        row_map.get("annual_value")
                        or row_map.get("annual value")
                        or row_map.get("arr ($)")
                        or row_map.get("arr")
                        or row_map.get("annual_income")
                        or ""
                    )
                    ann_val = _parse_numeric_amount(val_raw)
                    if cid or _is_valid_entity_name(cname):
                        cust_files.add(rel_path)
                        _record_entity(
                            customers,
                            cid or cname,
                            {
                                "id": cid,
                                "name": cname or cid,
                                "city": city,
                                "segment": seg,
                                "industry": ind,
                                "status": status,
                                "annual_value": ann_val,
                                "value_display": val_raw,
                            },
                            rel_path,
                        )
                if want_vend and is_vend_table:
                    vname = _clean_str(
                        row_map.get("vendor name") or row_map.get("vendor") or row_map.get("merchant") or ""
                    )
                    if _is_valid_entity_name(vname):
                        vend_files.add(rel_path)
                        _record_entity(vendors, vname, {"name": vname}, rel_path)

        # 2. Key-value / Narrative documents (PDF, DOCX, TXT)
        if want_emp and (
            "employee" in fn_low or "emp-" in fn_low or "/hr/" in path_low or "\\hr\\" in path_low
            or "employee profile" in head_low or "employment agreement" in head_low
        ):
            eid_m = re.search(r"(?:Employee\s*ID|Contract\s*ID)\s*[:\n\-]\s*([A-Za-z0-9-]+)", content, re.IGNORECASE)
            ename_m = re.search(r"(?:^|\n)(?:Name|Employee)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            dept_m = re.search(r"Department\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            role_m = re.search(r"Role\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            status_m = re.search(r"(?:Employment\s*Status|Status)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            sal_m = re.search(r"(?:Annual\s*Salary|Annual\s*Compensation|Salary|Compensation|CTC)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            eid = eid_m.group(1).strip() if eid_m else ""
            ename = _clean_str(ename_m.group(1)) if ename_m else ""
            if ename.upper().startswith("EMP-"):
                eid = eid or ename.split(",")[0].strip()
                ename = ""
            sal_raw = _clean_str(sal_m.group(1)) if sal_m else ""
            if eid or _is_valid_entity_name(ename):
                emp_files.add(rel_path)
                _record_entity(
                    employees,
                    eid or ename,
                    {
                        "id": eid,
                        "name": ename or eid,
                        "department": _clean_str(dept_m.group(1)) if dept_m else "",
                        "role": _clean_str(role_m.group(1)) if role_m else "",
                        "status": _clean_str(status_m.group(1)) if status_m else "",
                        "salary": _parse_numeric_amount(sal_raw),
                        "salary_display": sal_raw,
                    },
                    rel_path,
                )

        if want_cust and (
            "customer" in fn_low or "invoice" in fn_low or "contract" in fn_low
            or "customer profile" in head_low or "customer record" in head_low
        ):
            cid_m = re.search(r"Customer\s*ID\s*[:\n\-]\s*([A-Za-z0-9-]+)", content, re.IGNORECASE)
            cname_m = re.search(r"(?:^|\n)(?:Customer\s*Name|Customer|Bill\s*To|Client|Name)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            city_m = re.search(r"City\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            seg_m = re.search(r"Segment\s*[:\n\-]\s*([^\n|;]+)", content, re.IGNORECASE)
            ind_m = re.search(r"Industry\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            status_m = re.search(r"(?:Account\s*Status|Status)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            val_m = re.search(r"(?:Annual\s*Value|ARR|Account\s*value)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            cid = cid_m.group(1).strip() if cid_m else ""
            cname = _clean_str(cname_m.group(1)) if cname_m else ""
            val_raw = _clean_str(val_m.group(1)) if val_m else ""
            if cid or _is_valid_entity_name(cname):
                cust_files.add(rel_path)
                key = cid or cname
                _record_entity(
                    customers,
                    key,
                    {
                        "id": cid,
                        "name": cname or cid,
                        "city": _clean_str(city_m.group(1)) if city_m else "",
                        "segment": _clean_str(seg_m.group(1)) if seg_m else "",
                        "industry": _clean_str(ind_m.group(1)) if ind_m else "",
                        "status": _clean_str(status_m.group(1)) if status_m else "",
                        "annual_value": _parse_numeric_amount(val_raw),
                        "value_display": val_raw,
                    },
                    rel_path,
                )

        if want_vend and ("vendor" in content.casefold() or "invoice" in fn_low):
            vend_m = re.search(r"(?:Vendor\s*(?:Name)?|Provider)\s*[:\n\-]\s*([^\n|]+)", content, re.IGNORECASE)
            if vend_m:
                vname = _clean_str(vend_m.group(1))
                if _is_valid_entity_name(vname):
                    vend_files.add(rel_path)
                    _record_entity(vendors, vname, {"name": vname}, rel_path)

    def _summarize(bucket: dict[str, dict[str, Any]], files_set: set[str], group_field: str | None = None) -> dict[str, Any]:
        vals = list(bucket.values())
        breakdown: dict[str, int] = {}
        named_samples: list[str] = []
        for item in vals:
            name_val = item.get("name") or item.get("id") or ""
            if name_val and len(named_samples) < 25:
                named_samples.append(name_val)
            if group_field:
                g = (item.get(group_field) or "Unspecified").strip()
                if g:
                    breakdown[g] = breakdown.get(g, 0) + 1
        res_bucket = {
            "total_count": len(vals),
            "source_file_count": len(files_set),
            "source_files": sorted(files_set)[:40],
            "breakdown": dict(sorted(breakdown.items(), key=lambda kv: (-kv[1], kv[0]))[:15]),
            "samples": vals[:preview_limit],
            "sample_names": named_samples,
        }
        if include_all:
            res_bucket["all_records"] = vals
        return res_bucket

    return {
        "scanned_files": scanned_files,
        "employees": _summarize(employees, emp_files, group_field="department"),
        "customers": _summarize(customers, cust_files, group_field="segment"),
        "vendors": _summarize(vendors, vend_files),
    }


def filter_entities_by_numeric_query(
    documents: Iterable[dict[str, Any]],
    numeric_spec: dict[str, Any],
    *,
    offset: int = 0,
    limit: int = 25,
) -> dict[str, Any]:
    """Filter extracted employees/customers across all documents using numeric threshold/range/rank."""
    domain = str(numeric_spec.get("domain") or "employees")
    field = str(numeric_spec.get("field") or "salary")
    op = str(numeric_spec.get("op") or "gt")
    min_val = numeric_spec.get("min_val")
    max_val = numeric_spec.get("max_val")
    sort_dir = str(numeric_spec.get("sort_dir") or "desc")
    top_n = numeric_spec.get("top_n")
    dept_filter = str(numeric_spec.get("dept_filter") or "").casefold()
    status_filter = str(numeric_spec.get("status_filter") or "").casefold()

    agg = aggregate_entities_from_documents(documents, entity_kind=domain, include_all=True)
    bucket = agg.get(domain) or {}
    all_records = list(bucket.get("all_records") or [])

    numeric_items: list[dict[str, Any]] = []
    max_observed: float | None = None
    for item in all_records:
        num_val = item.get(field)
        if not isinstance(num_val, (int, float)):
            continue
        if dept_filter:
            dept_low = str(item.get("department") or item.get("segment") or "").casefold()
            role_low = str(item.get("role") or "").casefold()
            if dept_filter not in dept_low and dept_filter not in role_low:
                continue
        if status_filter:
            st_low = str(item.get("status") or item.get("segment") or "").casefold()
            if status_filter not in st_low:
                continue
        if max_observed is None or num_val > max_observed:
            max_observed = float(num_val)

        keep = False
        if op == "gt" and min_val is not None:
            keep = num_val > float(min_val)
        elif op == "ge" and min_val is not None:
            keep = num_val >= float(min_val)
        elif op == "lt" and max_val is not None:
            keep = num_val < float(max_val)
        elif op == "le" and max_val is not None:
            keep = num_val <= float(max_val)
        elif op == "between" and min_val is not None and max_val is not None:
            keep = float(min_val) <= num_val <= float(max_val)
        elif op == "rank":
            keep = True
        if keep:
            numeric_items.append(item)

    numeric_items.sort(key=lambda r: float(r.get(field) or 0.0), reverse=(sort_dir != "asc"))
    if op == "rank" and isinstance(top_n, int) and top_n > 0:
        numeric_items = numeric_items[:top_n]

    breakdown: dict[str, int] = {}
    matched_files: list[str] = []
    seen_files: set[str] = set()
    group_key = "department" if domain == "employees" else "segment"
    for item in numeric_items:
        g = str(item.get(group_key) or "").strip()
        if g:
            breakdown[g] = breakdown.get(g, 0) + 1
        for fp in item.get("files") or []:
            if fp not in seen_files:
                seen_files.add(fp)
                matched_files.append(fp)

    total_matching = len(numeric_items)
    sliced = numeric_items[offset : offset + limit]
    return {
        "domain": domain,
        "field": field,
        "op": op,
        "min_val": min_val,
        "max_val": max_val,
        "dept_filter": dept_filter,
        "scanned_files": agg.get("scanned_files", 0),
        "total_scanned_records": len(all_records),
        "total_matching": total_matching,
        "max_observed": max_observed,
        "breakdown": dict(sorted(breakdown.items(), key=lambda kv: (-kv[1], kv[0]))[:12]),
        "records": sliced,
        "source_files": matched_files,
        "has_more": (offset + len(sliced)) < total_matching,
    }


def aggregate_workspace_entities(
    indexed_files: dict[str, dict[str, Any]],
    is_folder_authorized: Callable[[UserAttributes, str], bool],
    user: UserAttributes,
    entity_kind: str = "all",
    preview_limit: int = 100,
) -> dict[str, Any]:
    """Aggregate deduplicated employee/customer/vendor counts across authorized indexed files."""
    docs = []
    for rel_path, info in indexed_files.items():
        folder = info.get("folder", "General")
        if not is_folder_authorized(user, folder):
            continue
        docs.append({
            "filename": info.get("filename", ""),
            "relative_path": rel_path,
            "content": info.get("content", ""),
            "folder": folder,
        })
    return aggregate_entities_from_documents(docs, entity_kind=entity_kind, preview_limit=preview_limit)


def extract_contract_records_from_files(
    indexed_files: dict[str, dict[str, Any]],
    is_folder_authorized: Callable[[UserAttributes, str], bool],
    user: UserAttributes,
    entity_filter: str | None = None,
    limit: int = 50,
) -> tuple[list[dict[str, Any]], list[SourceReference]]:
    """Extract structured contract renewal and agreement records."""
    records: list[dict[str, Any]] = []
    sources: list[SourceReference] = []
    seen_ids: set[str] = set()

    for rel_path, info in indexed_files.items():
        folder = info.get("folder", "General")
        if not is_folder_authorized(user, folder):
            continue
        filename = info["filename"]
        content = info.get("content", "")

        if "renewal" in filename.lower() or "schedule" in filename.lower() or "register" in filename.lower():
            lines = [l.strip() for l in content.split("\n") if "|" in l]
            for line in lines:
                parts = [p.strip() for p in line.split("|")]
                if len(parts) >= 5 and parts[0].upper().startswith(("CNT-", "CTR-")):
                    cid = parts[0]
                    if cid in seen_ids:
                        continue
                    if entity_filter:
                        ef = entity_filter.casefold()
                        if not any(ef in p.casefold() for p in parts[:4]):
                            continue
                    seen_ids.add(cid)
                    records.append({
                        "id": _clean_str(cid),
                        "customer": _clean_str(parts[1] if len(parts) > 1 else ""),
                        "contract_type": _clean_str(parts[2] if len(parts) > 2 else "Standard Agreement"),
                        "annual_value": _clean_str(parts[3] if len(parts) > 3 else "N/A"),
                        "renewal_date": _clean_str(parts[4] if len(parts) > 4 else ""),
                        "status": _clean_str(parts[6] if len(parts) > 6 else "Active"),
                        "file_path": rel_path,
                    })

            if records:
                sources.append(SourceReference(
                    reference_id=f"ref-contract-{filename.split('.')[0]}",
                    source_type=SourceType.FILE,
                    display_name=f"[Contracts] {filename}",
                    title=f"{filename}",
                    location=info.get("full_path") or info.get("file_path", ""),
                ))
                break

    return records[:limit], sources

from __future__ import annotations

import re
from enum import StrEnum


class QueryIntent(StrEnum):
    FILE_SEARCH = "file_search"
    KNOWLEDGE_QA = "knowledge_qa"
    DIRECTORY_LISTING = "directory_listing"
    AMBIGUOUS_SEARCH = "ambiguous_search"


def classify_retrieval_intent(query: str) -> QueryIntent:
    """Classify user query into deterministic file search, directory listing, or knowledge Q&A."""
    from backend.retrieval.semantic import normalize_query_typos, parse_structured_invoice_filter

    clean = normalize_query_typos(query.strip())
    q_lower = clean.casefold()

    # 0. Structured status/date/customer-unpaid invoice Q&A should run analytical extraction, not raw file listing
    if parse_structured_invoice_filter(q_lower) is not None:
        return QueryIntent.KNOWLEDGE_QA

    # 1. Directory listing check
    listing_patterns = (
        "list all files", "list files", "show all files", "what files do i have",
        "show all documents", "files in companydata", "files in company data",
        "what files are present", "see files", "available files", "file list",
        "browse files", "list documents", "show documents", "all files",
        "what files are in my folder", "files in my folder", "files in folder",
        "what is in my folder", "what documents are in my folder", "show my files",
        "list my files", "list folder", "show folder", "what files do we have",
        "show connected files", "connected files", "local files", "list local files",
        "what is in the folder", "contents of my folder", "contents of folder",
    )
    if any(p in q_lower for p in listing_patterns):
        return QueryIntent.DIRECTORY_LISTING

    # 1b. Comprehension / analysis / Q&A queries (even if a filename like .pdf is mentioned)
    has_comprehension_intent = bool(re.search(
        r"\b(analyze|analyse|summarize|summarise|summary|explain|describe|review|extract|compare|"
        r"key\s+findings|key\s+points|takeaways|insights|"
        r"contents\s+of|what\s+does|tell\s+me\s+about|attached\s+document|details\s+(?:of|about|in))\b",
        q_lower,
    )) or bool(re.match(r"^(?:what|which|who|whom|whose|why|when|how)\b", q_lower))
    has_explicit_discovery = bool(re.search(
        r"^(?:can\s+you\s+)?(?:please\s+)?(?:find|locate|where\s+is|where\s+are|list|search\s+for|open|download)\b",
        q_lower,
    )) or bool(re.search(r"\b(?:what|which)\s+(?:file|files|document|documents|folder|folders)\b", q_lower))
    if has_comprehension_intent and not has_explicit_discovery:
        return QueryIntent.KNOWLEDGE_QA

    # 2. File extension check: e.g. "report.pdf", "data.xlsx", ".csv"
    if re.search(r"\b[\w.-]+\.(pdf|docx?|xlsx?|csv|txt|md|pptx|png|jpe?g|webp|bmp|tiff?|gif)\b", q_lower):
        return QueryIntent.FILE_SEARCH

    # 3. Document / invoice / record code check (e.g. INV-2026-0042, INV-00022, EMP-0001, NDA-0008, PUR-0001)
    if re.search(r"\b(?:inv|emp|nda|pur|po|prj|cust|cnt|ctr|doc|bill|tax|ref)[-_ ]?\d{1,8}(?:[-_][a-z0-9]+)*\b", q_lower):
        return QueryIntent.FILE_SEARCH
    if re.search(r"\binv[-_ ]?\d{4}[-_ ]?\d+\b", q_lower) or re.search(r"\binvoice[-_ ]?\d+\b", q_lower):
        return QueryIntent.FILE_SEARCH

    # 4. Explicit file search / discovery patterns
    file_discovery_prefixes = (
        "find the file", "find file", "find files", "find the files", "find the report", "find report",
        "find the document", "find document", "find documents", "find the documents", "find the spreadsheet",
        "find spreadsheet", "find the sheet", "find the pdf", "find the doc",
        "find the notes", "find the policy", "find the handbook",
        "where is the", "where are the", "where is our", "where can i find", "where are our",
        "show me the file", "show the file", "show me the files", "show the files",
        "show me files", "show files", "show me all files", "show all files",
        "show me the document", "show the document", "show me the documents", "show the documents",
        "show me documents", "show documents", "show me all documents", "show all documents",
        "show me the report", "show the report", "show me the spreadsheet", "show the spreadsheet",
        "show me the finance document", "show the finance document",
        "which document contains", "which file contains", "which spreadsheet contains",
        "which folder contains", "what document contains", "what file contains",
        "locate the file", "locate file", "locate files", "locate document", "locate documents", "locate the report",
        "search for the file", "search for file", "search for files", "search file", "search files", "search for document", "search for documents",
    )
    if any(q_lower.startswith(p) or f" {p}" in q_lower for p in file_discovery_prefixes):
        return QueryIntent.FILE_SEARCH

    # 4b. Category-level file search (e.g. "invoice files", "invoices", "show invoices", "contract files", "policy files", "pdf files")
    category_file_patterns = (
        r"\b(?:invoice|invoices|bill|bills|billing|contract|contracts|agreement|agreements|nda|ndas|quotation|quotations|receipt|receipts|po|purchase\s+order|purchase\s+orders|policy|policies|handbook|handbooks|resume|resumes|report|reports|statement|statements|spreadsheet|spreadsheets|drawing|drawings|specification|specifications)\s+(?:files?|documents?|docs?|pdfs?|sheets?)\b",
        r"\b(?:show|list|find|get|fetch|display|open|see|browse)\s+(?:all\s+)?(?:the\s+)?(?:invoices?|bills?|contracts?|agreements?|ndas?|quotations?|receipts?|pos?|purchase\s+orders?|policies|handbooks?|resumes?|reports?|drawings?|spreadsheets?|pdfs?)\b",
        r"^(?:invoices?|bills?|contracts?|agreements?|ndas?|quotations?|receipts?|policies|resumes?|reports?|drawings?|spreadsheets?|pdf\s+files?|excel\s+files?|csv\s+files?)$",
    )
    if any(re.search(pat, q_lower) for pat in category_file_patterns):
        return QueryIntent.FILE_SEARCH

    # Ambiguous search patterns like "find the latest report", "find the revenue report"
    if q_lower.startswith("find ") and any(k in q_lower for k in ("report", "document", "file", "spreadsheet", "sheet")):
        return QueryIntent.FILE_SEARCH

    return QueryIntent.KNOWLEDGE_QA

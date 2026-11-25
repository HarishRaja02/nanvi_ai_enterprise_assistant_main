"""Lightweight zero-bloat semantic concept, synonym, and hybrid similarity engine."""
from __future__ import annotations

import math
import re
from functools import lru_cache
from typing import Any, Iterable

_STOPWORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "under", "about",
    "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
    "all", "each", "every", "any", "few", "more", "most", "other", "some",
    "such", "no", "only", "own", "same", "than", "too", "very", "just",
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
    "they", "them", "their", "what", "which", "who", "whom", "this",
    "that", "these", "those", "there", "here", "where", "when", "why",
    "how", "give", "show", "find", "list", "get", "tell", "please",
    "need", "want", "looking", "connected", "folder", "files", "file",
    "document", "documents", "docs", "data",
})

SEMANTIC_CONCEPTS: dict[str, tuple[str, ...]] = {
    "__c_overdue__": (
        "overdue", "past due", "late", "unpaid", "delayed", "delinquent",
        "missed deadline", "defaulted", "outstanding", "arrears", "expired",
    ),
    "__c_invoice__": (
        "invoice", "invoices", "bill", "bills", "billing", "receipt",
        "payable", "receivable", "inv", "tax invoice", "payment schedule",
    ),
    "__c_due_date__": (
        "due date", "due", "deadline", "payment due", "maturity",
        "payable by", "expiry", "end date", "renewal date", "target date",
    ),
    "__c_employee__": (
        "employee", "employees", "staff", "worker", "workers", "personnel",
        "headcount", "workforce", "team member", "emp", "hr", "payroll",
        "attendance", "joining date", "probation", "salary",
    ),
    "__c_customer__": (
        "customer", "customers", "client", "clients", "buyer", "buyers",
        "account", "accounts", "consumer", "subscriber", "cust", "orders",
    ),
    "__c_vendor__": (
        "vendor", "vendors", "supplier", "suppliers", "merchant", "merchants",
        "provider", "contractor",
    ),
    "__c_contract__": (
        "contract", "contracts", "agreement", "agreements", "nda", "msa",
        "sla", "license", "renewal", "terms", "clause", "purchase agreement",
    ),
    "__c_project__": (
        "project", "projects", "sprint", "milestone", "deliverable", "task",
        "tasks", "roadmap", "initiative", "status report",
    ),
    "__c_finance__": (
        "finance", "financial", "revenue", "budget", "forecast", "expense",
        "transactions", "bank statement", "ledger", "cash flow", "p&l",
        "profit", "loss", "gst", "tax", "amount", "inr", "usd",
    ),
    "__c_resume__": (
        "resume", "resumes", "cv", "candidate", "applicant", "portfolio",
        "skills", "experience",
    ),
    "__c_support__": (
        "support", "ticket", "tickets", "case", "cases", "escalation",
        "incident", "csat",
    ),
    "__c_arr__": (
        "arr", "annual recurring revenue", "annual value", "annual contract value",
        "acv", "deal size", "contract value", "recurring revenue",
    ),
    "__c_runway__": (
        "runway", "cash runway", "cash burn", "burn rate", "operating runway",
        "operating cash", "reserves", "cash balance",
    ),
}

_PHRASE_TO_CONCEPTS: list[tuple[str, str]] = []
for _concept, _terms in SEMANTIC_CONCEPTS.items():
    for _term in _terms:
        _PHRASE_TO_CONCEPTS.append((_term, _concept))


def normalize_query_typos(text: str) -> str:
    """Normalize common enterprise search typos while preserving IDs and numbers."""
    if not text:
        return ""
    s = str(text)
    replacements: tuple[tuple[str, str], ...] = (
        (r"\b(?:did['’]?n['’]?t?|didn['’]?t|did\s+not|haven['’]?t|havent|have\s+not|not)\s+(?:pay|paid|payed)\b", "unpaid"),
        (r"\bmore\s+then\b", "more than"),
        (r"\bgreater\s+then\b", "greater than"),
        (r"\bhigher\s+then\b", "higher than"),
        (r"\bbigger\s+then\b", "bigger than"),
        (r"\blarger\s+then\b", "larger than"),
        (r"\bless\s+then\b", "less than"),
        (r"\bfewer\s+then\b", "fewer than"),
        (r"\blower\s+then\b", "lower than"),
        (r"\bsmaller\s+then\b", "smaller than"),
        (r"\b(?:invoics|invoces|invoic|invoce)\b", "invoice"),
        (r"\b(?:customres|customrs|customr|cutomers|cutomer|costomers|costomer)\b", "customers"),
        (r"\b(?:employes|employe|emplyees|emplyee|emploees|emploee)\b", "employees"),
        (r"\b(?:salry|salery|sallery|salries|saleries)\b", "salary"),
        (r"\b(?:agrement|agrements)\b", "agreement"),
        (r"\b(?:cntract|contrac|contrcts)\b", "contract"),
        (r"\bpayed\b", "paid"),
        (r"\bover\s+due\b", "overdue"),
        (r"\b(?:earnign|earngs)\b", "earning"),
        (r"\b(?:amout|ammount)\b", "amount"),
        (r"\b(?:budgt|budjet)\b", "budget"),
        (r"\b(?:revanue|revenu)\b", "revenue"),
    )
    for pat, repl in replacements:
        s = re.sub(pat, repl, s, flags=re.IGNORECASE)
    return s


@lru_cache(maxsize=4096)
def light_stem(word: str) -> str:
    w = word.casefold().strip()
    if len(w) <= 3:
        return w
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith("ves") and len(w) > 4:
        return w[:-3] + "f"
    if w.endswith(("ches", "shes", "sses", "xes", "zes")) and len(w) > 5:
        return w[:-2]
    if w.endswith("s") and not w.endswith("ss") and len(w) > 3:
        return w[:-1]
    if w.endswith("ing") and len(w) > 5:
        return w[:-3]
    if w.endswith("ed") and len(w) > 4:
        return w[:-2]
    return w


def tokenize_for_search(text: str, *, drop_stopwords: bool = True) -> list[str]:
    if not text:
        return []
    tokens = re.findall(r"[a-z0-9]+(?:[-_][a-z0-9]+)*", normalize_query_typos(text).casefold())
    out: list[str] = []
    for tok in tokens:
        if drop_stopwords and tok in _STOPWORDS:
            continue
        out.append(tok)
        if "-" in tok or "_" in tok:
            for part in re.split(r"[-_]", tok):
                if len(part) >= 2 and (not drop_stopwords or part not in _STOPWORDS):
                    out.append(part)
    return out


def extract_concepts(text: str) -> set[str]:
    norm_txt = normalize_query_typos(text or "")
    low = f" {re.sub(r'[^a-z0-9&/+]+', ' ', norm_txt.casefold())} "
    found: set[str] = set()
    for phrase, concept in _PHRASE_TO_CONCEPTS:
        if f" {phrase} " in low:
            found.add(concept)
    return found


def expand_semantic_tokens(text: str) -> set[str]:
    """Return stemmed tokens plus semantic concept tags & synonym siblings."""
    raw = tokenize_for_search(text, drop_stopwords=True)
    expanded: set[str] = set()
    for tok in raw:
        expanded.add(tok)
        expanded.add(light_stem(tok))
    concepts = extract_concepts(text)
    expanded.update(concepts)
    for concept in concepts:
        for syn in SEMANTIC_CONCEPTS[concept]:
            if " " not in syn:
                expanded.add(syn)
                expanded.add(light_stem(syn))
    return expanded


def build_sparse_semantic_vector(text: str, *, include_trigrams: bool = True) -> dict[str, float]:
    """Build a normalized sparse semantic feature vector for fast cosine similarity."""
    if not text:
        return {}
    vec: dict[str, float] = {}
    tokens = tokenize_for_search(text, drop_stopwords=True)
    for tok in tokens:
        stem = light_stem(tok)
        vec[f"w:{stem}"] = vec.get(f"w:{stem}", 0.0) + 1.0
        if include_trigrams and len(tok) >= 4:
            padded = f"^{tok}$"
            for i in range(len(padded) - 2):
                tri = padded[i : i + 3]
                vec[f"g:{tri}"] = vec.get(f"g:{tri}", 0.0) + 0.35

    for concept in extract_concepts(text):
        vec[f"c:{concept}"] = vec.get(f"c:{concept}", 0.0) + 1.6

    norm = math.sqrt(sum(v * v for v in vec.values()))
    if norm <= 0.0:
        return {}
    return {k: v / norm for k, v in vec.items()}


def sparse_cosine_similarity(vec_a: dict[str, float], vec_b: dict[str, float]) -> float:
    if not vec_a or not vec_b:
        return 0.0
    if len(vec_a) > len(vec_b):
        vec_a, vec_b = vec_b, vec_a
    score = 0.0
    for k, va in vec_a.items():
        vb = vec_b.get(k)
        if vb:
            score += va * vb
    return max(0.0, min(1.0, score))


def semantic_text_similarity(query: str, document_text: str) -> float:
    """Compute [0, 1] semantic + lexical similarity between a query and document snippet."""
    vq = build_sparse_semantic_vector(query)
    if not vq:
        return 0.0
    vd = build_sparse_semantic_vector(document_text[:6000])
    return sparse_cosine_similarity(vq, vd)


_PAGINATION_RE = re.compile(
    r"^(?:show\s+more|i\s+need\s+more|need\s+more|more\s+(?:files|results|invoices|customers|employees|contracts|records|items|plz|please)?|"
    r"next\s*(?:set|batch|page|10|ten|files|results)?|another\s+set|show\s+another(?:\s+set)?|"
    r"give\s+(?:me\s+)?more|load\s+more|keep\s+going|continue|what\s+else)$",
    re.IGNORECASE,
)


def is_pagination_followup(query: str) -> bool:
    cleaned = re.sub(r"[?!.,\s]+$", "", (query or "").strip())
    if not cleaned:
        return False
    if _PAGINATION_RE.match(cleaned):
        return True
    low = cleaned.casefold()
    return any(
        p in low
        for p in (
            "i need more",
            "need more files",
            "another set of",
            "show another set",
            "show next 10",
            "next 10 files",
            "more of those",
            "more files like that",
        )
    )


def detect_entity_aggregation_intent(query: str) -> str | None:
    """Return 'employees', 'customers', 'vendors', 'invoices', or None for cross-file count/list Q&A."""
    q = normalize_query_typos((query or "").strip()).casefold()
    if not q:
        return None
    # Unpaid/paid/overdue invoice-specific queries belong to parse_structured_invoice_filter
    inv_f = parse_structured_invoice_filter(q)
    if inv_f and (inv_f.get("status_filter") or inv_f.get("year") or inv_f.get("group_by")):
        return None
    asks_count_or_inventory = any(
        p in q
        for p in (
            "how many", "total number", "total ", "count of", "headcount",
            "what are the", "who are the", "list all", "all the", "do i have",
            "do we have", "how much", "all my", "every ",
        )
    )
    if not asks_count_or_inventory:
        return None
    if any(k in q for k in ("employee", "employees", "staff", "worker", "workers", "headcount")):
        return "employees"
    if any(k in q for k in ("customer", "customers", "client", "clients")):
        return "customers"
    if any(k in q for k in ("vendor", "vendors", "supplier", "suppliers")):
        return "vendors"
    if any(k in q for k in ("invoice", "invoices", "bill", "bills")):
        return "invoices"
    return None


_INVOICE_ENTITY_STOPWORDS = frozenset({
    "a", "an", "the", "all", "any", "some", "other", "another", "same", "such", "more", "most",
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "they", "them", "their",
    "this", "that", "these", "those", "which", "who", "whom", "whose", "what", "when", "where",
    "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "done",
    "have", "has", "had", "can", "could", "will", "would", "shall", "should", "may", "might",
    "find", "search", "show", "list", "get", "give", "tell", "look", "locate", "fetch", "bring",
    "please", "need", "want", "looking", "connected", "local", "storage", "folder", "folders",
    "companydata", "directory", "in", "on", "at", "by", "for", "from", "of", "to", "with", "about",
    "into", "and", "or", "not", "only", "already", "yet", "still", "like",
    "invoice", "invoices", "inv", "bill", "bills", "billing", "payment", "payments", "payable", "receivable",
    "file", "files", "document", "documents", "doc", "docs", "record", "records", "data",
    "customer", "customers", "client", "clients", "vendor", "vendors", "supplier", "suppliers",
    "status", "state", "created", "issued", "generated", "dated", "made", "date", "due", "year", "yr",
    "overdue", "unpaid", "paid", "settled", "cleared", "pending", "late", "past", "outstanding",
    "arrears", "delinquent", "expired", "missed",
})

_NON_ENTITY_DOC_TERMS = frozenset({
    "receipt", "receipts", "purchase", "order", "orders", "contract", "contracts", "agreement",
    "agreements", "nda", "msa", "sla", "po", "pur", "schedule", "register", "report", "reports",
    "budget", "forecast", "policy", "policies", "handbook", "summary", "statement", "sheet",
    "linked", "related", "associated", "referencing", "mentioning", "spreadsheet", "excel", "csv",
    "pdf", "docx", "xlsx", "tax", "gst",
})


def _extract_invoice_entity_filter(norm_query: str) -> str:
    """Extract residual customer/vendor/company name from an invoice query, or '' if generic/alternation."""
    if not norm_query:
        return ""
    ql = norm_query.casefold()
    # Do not invent a customer filter for OR-alternations, cross-doc link requests, or receipt/PO searches
    if re.search(r"\bor\b", ql):
        return ""
    raw_words = re.findall(r"[a-z0-9][a-z0-9&'.-]*", norm_query, flags=re.IGNORECASE)
    raw_lower = [w.casefold().strip("'.-") for w in raw_words]
    if any(w in _NON_ENTITY_DOC_TERMS for w in raw_lower):
        return ""

    kept: list[str] = []
    for raw_tok in raw_words:
        low = raw_tok.casefold().strip("'.-")
        if not low or low in _INVOICE_ENTITY_STOPWORDS or low in _NON_ENTITY_DOC_TERMS:
            continue
        if re.fullmatch(r"20\d{2}", low):
            continue
        if re.fullmatch(r"(?:inv|po|pur|cnt|ctr)[-_]?\d+", low):
            continue
        if re.fullmatch(r"\d+", low):
            continue
        if len(low) >= 2:
            kept.append(raw_tok.strip("'."))

    if not kept or not any(len(k) >= 3 for k in kept):
        return ""
    candidate = " ".join(kept[:5]).strip()
    if len(candidate) < 3:
        return ""
    return candidate


def parse_structured_invoice_filter(query: str) -> dict[str, Any] | None:
    """Parse structured invoice status/date/customer/entity queries (paid, unpaid, overdue, 2026, customer debtors).

    Distinguishes salary phrases ('highest paid') and leave policies ('paid leave') so those
    do not falsely trigger invoice status filters.
    """
    q_raw = (query or "").strip()
    if not q_raw:
        return None
    q = normalize_query_typos(q_raw).casefold()

    # Do not intercept employee compensation ("highest paid") or HR leave ("paid leave/holidays")
    if any(k in q for k in ("highest paid", "best paid", "lowest paid", "paid leave", "paid holiday", "paid time off", "salary", "salaries", "lpa", "lakh", "lakhs", "lack")):
        return None

    has_inv = bool(re.search(r"\b(?:invoice|invoices|bill|bills|billing|payment|payments|payable|receivable)\b", q))
    has_cust_entity = bool(re.search(r"\b(?:customer|customers|client|clients|vendor|vendors)\b", q))
    has_unpaid_word = bool(re.search(r"\b(?:unpaid|overdue|past\s+due|late|pending|delinquent|arrears|outstanding|not\s+settled)\b", q))
    has_paid_word = bool(re.search(r"\b(?:paid|settled|cleared)\b", q)) and not has_unpaid_word
    # Note normalize_query_typos maps "did'n paid" / "didn't pay" / "not paid" -> "unpaid"
    has_raw_neg_pay = bool(re.search(r"\b(?:did['’]?n['’]?t?|didn['’]?t|not|haven['’]?t|never)\s+(?:pay|paid|payed)\b", q_raw.casefold()))
    if has_raw_neg_pay:
        has_unpaid_word = True
        has_paid_word = False

    if not (has_inv or ((has_unpaid_word or "already paid" in q) and (has_cust_entity or "already paid" in q))):
        return None

    status_filter: str | None = None
    if re.search(r"\b(?:overdue|past\s+due|late|missed\s+due)\b", q):
        status_filter = "overdue"
    elif has_unpaid_word:
        status_filter = "unpaid_all" if ("unpaid" in q or has_raw_neg_pay or has_cust_entity) else "pending"
    elif has_paid_word and (has_inv or "already paid" in q):
        status_filter = "paid"

    year: int | None = None
    m_yr = re.search(r"(?<![A-Za-z0-9_-])(20\d{2})(?![_-]\d)", q)
    if m_yr:
        year = int(m_yr.group(1))

    group_by: str | None = None
    if has_cust_entity and (has_unpaid_word or has_paid_word or re.search(r"\b(?:which|who|list|show|what)\s+(?:all\s+)?(?:the\s+)?(?:customer|customers|client|clients|vendor|vendors)\b", q)):
        group_by = "vendors" if re.search(r"\b(?:vendor|vendors)\b", q) and not re.search(r"\b(?:customer|customers|client|clients)\b", q) else "customers"

    norm_raw = normalize_query_typos(q_raw)
    entity_filter = _extract_invoice_entity_filter(norm_raw) if has_inv else ""

    if status_filter is None and year is None and group_by is None and not entity_filter:
        return None

    return {
        "status_filter": status_filter,
        "year": year,
        "group_by": group_by,
        "entity_filter": entity_filter or None,
        "explicit_invoice_intent": has_inv or bool(status_filter),
    }


def is_overdue_invoice_query(query: str) -> bool:
    q = normalize_query_typos(query or "").casefold()
    if any(k in q for k in ("highest paid", "best paid", "paid leave", "paid holiday", "salary", "lpa")):
        return False
    has_inv = any(k in q for k in ("invoice", "invoices", "bill", "bills", "payment", "payable"))
    has_overdue = any(k in q for k in ("overdue", "over due", "past due", "late", "unpaid", "expired", "missed due"))
    return has_inv and has_overdue


_UNIT_MULTIPLIERS = {
    "k": 1_000.0,
    "kpa": 1_000.0,
    "thousand": 1_000.0,
    "thousands": 1_000.0,
    "l": 100_000.0,
    "lk": 100_000.0,
    "lac": 100_000.0,
    "lacs": 100_000.0,
    "lack": 100_000.0,
    "lacks": 100_000.0,
    "lakh": 100_000.0,
    "lakhs": 100_000.0,
    "lpa": 100_000.0,
    "lpam": 100_000.0,
    "cr": 10_000_000.0,
    "cpa": 10_000_000.0,
    "crore": 10_000_000.0,
    "crores": 10_000_000.0,
    "m": 1_000_000.0,
    "mn": 1_000_000.0,
    "million": 1_000_000.0,
    "millions": 1_000_000.0,
    "b": 1_000_000_000.0,
    "bn": 1_000_000_000.0,
    "billion": 1_000_000_000.0,
}

_NUM_UNIT_FRAGMENT = (
    r"(?:₹|inr|rs\.?|\$|usd|eur)?\s*"
    r"(\d[\d,]*(?:\.\d+)?)\s*"
    r"(lakhs?\s+per\s+annum|lacs?\s+per\s+annum|lakhs?|lacks?|lacs?|lpa|lpam|lk|crores?|cpa|cr|millions?|mn|thousands?|kpa|k|m|bn|b)?\b"
)


def parse_human_number(num_str: str | float | int, unit_str: str | None = None) -> float | None:
    """Convert raw numeric text with optional Indian/English units (lakh/lack/lpa/crore/k/m) into float."""
    if num_str is None:
        return None
    if isinstance(num_str, (int, float)):
        base = float(num_str)
    else:
        cleaned = re.sub(r"[^\d.]", "", str(num_str).replace(",", ""))
        if not cleaned:
            return None
        try:
            base = float(cleaned)
        except ValueError:
            return None
    mult = 1.0
    if unit_str:
        u_clean = re.sub(r"\s+", " ", unit_str.strip().casefold())
        if "per annum" in u_clean:
            mult = 100_000.0
        else:
            mult = _UNIT_MULTIPLIERS.get(u_clean, 1.0)
    return base * mult


def parse_numeric_filter_query(query: str) -> dict[str, Any] | None:
    """Parse natural-language numeric filters on salary, revenue/ARR, invoice amount, or budget.

    Handles typos & Indian units such as:
      "list the employees that they are salary was more then 10 lacks" -> domain='employees', field='salary', op='gt', min_val=1000000
      "employee salary more then 30lpa" -> domain='employees', field='salary', op='gt', min_val=3000000
    """
    q = normalize_query_typos((query or "").strip())
    if not q:
        return None
    ql = q.casefold()

    domain = ""
    field = ""
    is_paid_comp_phrase = any(p in ql for p in ("highest paid", "best paid", "lowest paid", "top paid", "well paid"))
    if any(k in ql for k in ("employee", "employees", "staff", "worker", "workers", "personnel", "salary", "salaries", "compensation", "ctc", "wage", "wages", "earning", "earnings", "earns", "lpa")) or is_paid_comp_phrase:
        domain = "employees"
        field = "salary"
    elif any(k in ql for k in ("customer", "customers", "client", "clients", "arr", "annual value", "annual_value")):
        domain = "customers"
        field = "annual_value"
    elif any(k in ql for k in ("invoice", "invoices", "bill", "bills", "billing", "amount", "total")):
        domain = "invoices"
        field = "amount"
    elif any(k in ql for k in ("project", "projects", "budget")):
        domain = "projects"
        field = "budget"
    else:
        return None

    op: str | None = None
    min_val: float | None = None
    max_val: float | None = None
    sort_dir = "desc"
    top_n: int | None = None

    between_m = re.search(
        rf"\bbetween\s+{_NUM_UNIT_FRAGMENT}\s*(?:and|to|-)\s*{_NUM_UNIT_FRAGMENT}",
        ql,
        re.IGNORECASE,
    )
    if between_m:
        v1 = parse_human_number(between_m.group(1), between_m.group(2))
        v2 = parse_human_number(between_m.group(3), between_m.group(4))
        if v1 is not None and v2 is not None:
            op = "between"
            min_val, max_val = (min(v1, v2), max(v1, v2))

    if op is None:
        gt_m = re.search(
            rf"(?:\b(?:more\s+th[ae]n|greater\s+th[ae]n|higher\s+th[ae]n|bigger\s+th[ae]n|larger\s+th[ae]n|exceed(?:s|ing)?|above|over|at\s+least|min(?:imum)?)|>=?)\s*{_NUM_UNIT_FRAGMENT}",
            ql,
            re.IGNORECASE,
        )
        if gt_m:
            v = parse_human_number(gt_m.group(1), gt_m.group(2))
            if v is not None:
                op = "ge" if ("at least" in gt_m.group(0) or "min" in gt_m.group(0) or ">=" in gt_m.group(0)) else "gt"
                min_val = v

    if op is None:
        lt_m = re.search(
            rf"(?:\b(?:less\s+th[ae]n|fewer\s+th[ae]n|lower\s+th[ae]n|smaller\s+th[ae]n|under|below|up\s+to|at\s+most|max(?:imum)?)|<=?)\s*{_NUM_UNIT_FRAGMENT}",
            ql,
            re.IGNORECASE,
        )
        if lt_m:
            v = parse_human_number(lt_m.group(1), lt_m.group(2))
            if v is not None:
                op = "le" if ("up to" in lt_m.group(0) or "at most" in lt_m.group(0) or "max" in lt_m.group(0) or "<=" in lt_m.group(0)) else "lt"
                max_val = v
                sort_dir = "asc"

    rank_m = re.search(r"\b(?:top\s+(\d+)\s+)?(?:highest|top|largest|biggest|maximum|lowest|smallest|minimum)\b", ql)
    if op is None and rank_m:
        is_rank_domain = any(k in ql for k in ("salary", "salaries", "paid", "compensation", "ctc", "arr", "annual value", "budget", "amount"))
        if is_rank_domain:
            op = "rank"
            sort_dir = "asc" if any(w in ql for w in ("lowest", "smallest", "minimum")) else "desc"
            if rank_m.group(1):
                top_n = max(1, min(100, int(rank_m.group(1))))
            else:
                top_m2 = re.search(r"\btop\s+(\d+)\b", ql)
                top_n = max(1, min(100, int(top_m2.group(1)))) if top_m2 else 20

    if op is None:
        return None

    # Optional text qualifiers (department/role/status)
    dept_filter = ""
    for d in ("engineering", "finance", "sales", "hr", "ai", "operations", "marketing", "product", "architect", "manager", "developer", "analyst", "director", "engineer"):
        if re.search(rf"\b{d}\b", ql):
            dept_filter = d
            break

    status_filter = ""
    for st in ("on leave", "active", "inactive", "terminated", "resigned", "probation", "enterprise", "mid-market", "smb"):
        if re.search(rf"\b{re.escape(st)}\b", ql):
            status_filter = st
            break

    return {
        "domain": domain,
        "field": field,
        "op": op,
        "min_val": min_val,
        "max_val": max_val,
        "sort_dir": sort_dir,
        "top_n": top_n,
        "dept_filter": dept_filter,
        "status_filter": status_filter,
    }


_QUERY_VALIDATION_NOISE = frozenset({
    "can", "i", "you", "me", "we", "our", "my", "please", "find", "search", "show",
    "get", "give", "list", "look", "locate", "fetch", "bring", "another", "other",
    "more", "some", "any", "all", "the", "a", "an", "that", "this", "these", "those",
    "they", "them", "their", "was", "were", "is", "are", "be", "been", "being",
    "do", "does", "did", "have", "has", "had", "already", "just", "only", "like",
    "with", "for", "from", "in", "on", "at", "by", "to", "of", "and", "or",
    "file", "files", "document", "documents", "doc", "docs", "record", "records",
    "data", "folder", "folders", "directory", "created", "linked", "related",
    "associated", "regarding", "concerning", "referencing", "mentioning", "available",
    "present", "existing", "matching", "local", "storage", "companydata", "company",
})

_TERM_ALIAS_GROUPS: tuple[frozenset[str], ...] = (
    frozenset({"contract", "contracts", "agreement", "agreements", "msa", "sla"}),
    frozenset({"invoice", "invoices", "inv", "bill", "bills", "billing"}),
    frozenset({"customer", "customers", "client", "clients"}),
    frozenset({"vendor", "vendors", "supplier", "suppliers", "merchant", "merchants"}),
    frozenset({"employee", "employees", "staff", "worker", "workers", "personnel"}),
    frozenset({"resume", "resumes", "cv", "cvs"}),
    frozenset({"report", "reports", "reporting"}),
    frozenset({"receipt", "receipts", "voucher", "vouchers", "acknowledgement"}),
)


def _aliases_for_term(term: str, branch_terms: set[str] | frozenset[str] = ()) -> frozenset[str]:
    tl = term.casefold()
    out = {tl, light_stem(tl)}
    # Context-aware alias: "purchase order" often maps to "Purchase Agreement PUR-xxxx" / "PO-"
    if tl == "order" and "purchase" in branch_terms:
        out.update({"orders", "agreement", "agreements", "pur-", "po-"})
    for grp in _TERM_ALIAS_GROUPS:
        if tl in grp or light_stem(tl) in grp:
            out.update(grp)
    if tl in {"hr", "human"}:
        out.update({"hr", "human resources", "employee", "employees", "payroll", "leave"})
    if tl in {"pdf", "csv", "xlsx", "docx", "txt", "pptx"}:
        out.update({f".{tl}", tl})
    return frozenset(out)


def _extract_branch_terms(text: str) -> list[str]:
    toks = re.findall(r"[a-z0-9]+(?:[-_][a-z0-9]+)*", normalize_query_typos(text).casefold())
    terms = [t for t in toks if len(t) >= 2 and t not in _QUERY_VALIDATION_NOISE]
    return list(dict.fromkeys(terms))


def parse_query_constraints(query: str) -> dict[str, Any]:
    """Parse explicit OR alternations and required constraint groups for strict pre-output validation."""
    norm_q = normalize_query_typos((query or "").strip())
    low_q = norm_q.casefold()

    # Check explicit "A or B" alternation (e.g. "Find payment receipt or purchase order files")
    has_or = bool(re.search(r"\s+\bor\b\s+", low_q))
    raw_branches = re.split(r"\s+\bor\b\s+", low_q) if has_or else [low_q]

    branches: list[list[dict[str, Any]]] = []
    branch_labels: list[str] = []
    for raw_b in raw_branches:
        b_terms = _extract_branch_terms(raw_b)
        if not b_terms:
            continue
        b_set = set(b_terms)
        groups: list[dict[str, Any]] = []
        used_idx: set[int] = set()
        for i, term in enumerate(b_terms):
            if i in used_idx:
                continue
            aliases = set(_aliases_for_term(term, b_set))
            merged_label = [term]
            # Merge synonymous words in the same branch so "contract agreement" does not require both literals
            for j in range(i + 1, len(b_terms)):
                if j in used_idx:
                    continue
                other = b_terms[j]
                if other in aliases or light_stem(other) in aliases:
                    used_idx.add(j)
                    aliases.update(_aliases_for_term(other, b_set))
                    merged_label.append(other)
            groups.append({"term": merged_label[0], "label": " / ".join(merged_label), "aliases": frozenset(aliases)})
        if groups:
            branches.append(groups)
            branch_labels.append(" ".join(b_terms))

    return {
        "is_alternation": has_or and len(branches) >= 2,
        "branches": branches,
        "branch_labels": branch_labels,
        "core_terms": _extract_branch_terms(low_q),
    }


_SOFT_MODIFIER_TERMS = frozenset({
    "policy", "policies", "guideline", "guidelines", "detail", "details", "info",
    "information", "overview", "note", "notes", "spec", "specs", "specification",
    "manual", "guide",
})


def _edit_dist_le1(a: str, b: str) -> bool:
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la == lb:
        return sum(1 for ca, cb in zip(a, b) if ca != cb) <= 1
    if la > lb:
        a, b = b, a
        la, lb = lb, la
    # la + 1 == lb (single insertion)
    i = j = diffs = 0
    while i < la and j < lb:
        if a[i] == b[j]:
            i += 1
            j += 1
        else:
            diffs += 1
            if diffs > 1:
                return False
            j += 1
    return True


def _alias_in_haystack(alias: str, hay_low: str, hay_spaced: str, hay_words: set[str] | None = None) -> bool:
    if len(alias) <= 3 and alias.isalpha():
        return bool(re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", hay_spaced))
    if alias.startswith("."):
        return alias in hay_low
    if alias in hay_low or alias in hay_spaced:
        return True
    if hay_words and len(alias) >= 6 and alias.isalpha():
        prefix = alias[:2]
        for w in hay_words:
            if len(w) >= 5 and w.startswith(prefix) and _edit_dist_le1(alias, w):
                return True
    return False


def validate_text_against_constraints(
    filename: str,
    rel_path: str,
    content: str,
    constraints: dict[str, Any],
) -> dict[str, Any]:
    """Validate whether a document satisfies at least one complete OR branch (or all required hard constraints)."""
    branches: list[list[dict[str, Any]]] = constraints.get("branches") or []
    if not branches:
        return {"valid": True, "matched_branches": [], "best_coverage": 1.0, "matched_groups": []}

    is_alt = bool(constraints.get("is_alternation"))
    hay_low = f"{filename} {rel_path} {content}".casefold()
    hay_spaced = re.sub(r"[_/\\-]+", " ", hay_low)
    hay_words = set(re.findall(r"[a-z]{5,}", hay_spaced))

    matched_branches: list[int] = []
    best_coverage = 0.0
    best_matched_groups: list[str] = []

    for b_idx, groups in enumerate(branches):
        hard_groups = (
            groups
            if is_alt
            else ([g for g in groups if g["term"] not in _SOFT_MODIFIER_TERMS] or groups)
        )
        hit_terms: list[str] = []
        hard_hits = 0
        for grp in groups:
            is_hit = any(_alias_in_haystack(al, hay_low, hay_spaced, hay_words) for al in grp["aliases"])
            if is_hit:
                hit_terms.append(grp["term"])
                if grp in hard_groups:
                    hard_hits += 1
        cov = hard_hits / len(hard_groups) if hard_groups else 1.0
        if cov > best_coverage:
            best_coverage = cov
            best_matched_groups = hit_terms
        if hard_hits == len(hard_groups):
            matched_branches.append(b_idx)

    return {
        "valid": len(matched_branches) > 0,
        "matched_branches": matched_branches,
        "best_coverage": best_coverage,
        "matched_groups": best_matched_groups,
    }


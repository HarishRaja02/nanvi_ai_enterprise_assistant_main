"""Precision Query Refine Layer for Chat & Voice.

Safely auto-corrects speech mishearings and clear typing errors (e.g. "hi nandi" -> "hi Nanvi",
"proposl" -> "proposal") ONLY when confident — protecting real entity names, filenames, codes,
URLs, quoted spans, and competing valid English/domain words.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Sequence

from backend.chat.vocabulary_biasing import apply_phonetic_corrections

# Protected spans that must never be rewritten by auto-correction.
_PROTECTED_SPAN_RE = re.compile(
    r"(`[^`]+`|\"[^\"]+\"|https?://\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}"
    r"|(?:[A-Za-z]:)?[\\/][^\s]+|\b[\w-]+\.(?:pdf|docx?|xlsx?|csv|tsv|pptx?|txt|md|json|xml|html?|png|jpe?g|webp|zip)\b"
    r"|\b[A-Z]{2,8}[-_]\d{1,8}(?:[-_]\d{1,8})?\b)"
)

# Real surname / company / geographic indicators where "Nandi" is almost certainly intentional.
_NANDI_ENTITY_FOLLOWERS = frozenset({
    "hills", "hill", "road", "street", "nagar", "Colony".lower(), "temple", "statue",
    "traders", "trading", "enterprises", "enterprise", "logistics", "motors", "foods",
    "industries", "builders", "Constructions".lower(), "solutions", "technologies", "tech",
    "systems", "group", "corp", "corporation", "ltd", "limited", "pvt", "inc", "llc",
    "vendors", "vendor", "suppliers", "supplier", "stores", "store", "mart", "pharmacy",
    "hotel", "hospital", "school", "college", "station", "junction", "circle", "park",
    "sharma", "patel", "reddy", "kumar", "verma", "rao", "singh", "das", "nair", "menon",
})

_NANDI_ENTITY_PREFIXES = frozenset({
    "mr", "mrs", "ms", "dr", "prof", "shri", "smt", "from", "vendor", "client",
    "customer", "supplier", "company", "visit", "visited", "at", "near", "in",
})

_NANVI_GREETINGS_OR_PREFIXES = frozenset({
    "hi", "hii", "hiii", "hello", "hey", "heyy", "ok", "okay", "dear",
    "thanks", "thank", "bye", "goodbye", "goodmorning", "morning",
    "afternoon", "evening", "please", "pls", "plz", "ask", "tell",
    "excuse", "sorry", "yo", "hola", "namaste", "help",
})

_NANVI_FOLLOWING_TRIGGERS = frozenset({
    "ai", "assistant", "copilot", "bot", "app", "enterprise", "platform", "system",
    "search", "find", "show", "get", "list", "check", "open", "give", "tell",
    "summarize", "summary", "explain", "read", "fetch", "pull", "help", "can",
    "could", "would", "please", "pls", "plz", "do", "does", "did", "is", "are",
    "how", "what", "where", "when", "why", "which", "who",
})

_NANVI_AMBIGUOUS_TOKENS = frozenset({"nandi", "nandy", "nani", "nanbi"})

# High-confidence unambiguous misspellings / voice splits (safe in both chat & voice).
_SAFE_TYPO_MAP: dict[str, str] = {
    "nanbi": "Nanvi",
    "nanbhi": "Nanvi",
    "nanvee": "Nanvi",
    "nanvy": "Nanvi",
    "nanwi": "Nanvi",
    "nanvhi": "Nanvi",
    "nonvi": "Nanvi",
    "namvi": "Nanvi",
    "nenvi": "Nanvi",
    "invoics": "invoices",
    "invoces": "invoices",
    "invoic": "invoice",
    "invoce": "invoice",
    "invoicing": "invoicing",
    "customres": "customers",
    "customrs": "customers",
    "cutomers": "customers",
    "costomers": "customers",
    "customr": "customer",
    "cutomer": "customer",
    "costomer": "customer",
    "employes": "employees",
    "emplyees": "employees",
    "emploees": "employees",
    "employe": "employee",
    "emplyee": "employee",
    "emploee": "employee",
    "salry": "salary",
    "salery": "salary",
    "sallery": "salary",
    "salries": "salaries",
    "saleries": "salaries",
    "contrct": "contract",
    "contraxt": "contract",
    "contarct": "contract",
    "cntract": "contract",
    "contrac": "contract",
    "contrcts": "contracts",
    "agreemnt": "agreement",
    "aggrement": "agreement",
    "agrement": "agreement",
    "agrements": "agreements",
    "warenty": "warranty",
    "warrenty": "warranty",
    "waranty": "warranty",
    "liabilty": "liability",
    "liabelity": "liability",
    "liablity": "liability",
    "procument": "procurement",
    "procuremnt": "procurement",
    "procurment": "procurement",
    "proposl": "proposal",
    "propasal": "proposal",
    "proposla": "proposal",
    "proposls": "proposals",
    "propasals": "proposals",
    "documnt": "document",
    "documet": "document",
    "docuemnt": "document",
    "documnts": "documents",
    "documets": "documents",
    "docuemnts": "documents",
    "summery": "summary",
    "sumary": "summary",
    "sumarize": "summarize",
    "summariz": "summarize",
    "revanue": "revenue",
    "revenu": "revenue",
    "revnue": "revenue",
    "budgt": "budget",
    "budjet": "budget",
    "buget": "budget",
    "amout": "amount",
    "ammount": "amount",
    "earnign": "earning",
    "earngs": "earnings",
    "vender": "vendor",
    "vendr": "vendor",
    "venders": "vendors",
    "assitant": "assistant",
    "assisant": "assistant",
    "assistent": "assistant",
    "ebidta": "EBITDA",
    "payed": "paid",
}

# Multi-word safe corrections (e.g. STT splits) applied outside protected spans.
_SAFE_PHRASE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(?:in\s+voice)\b", re.IGNORECASE), "invoice"),
    (re.compile(r"\b(?:in\s+voices)\b", re.IGNORECASE), "invoices"),
    (re.compile(r"\b(?:ageing|aging)\s*(?:brakdown|break\s*down)\b", re.IGNORECASE), "aging breakdown"),
    (re.compile(r"\b(?:over\s+due)\b", re.IGNORECASE), "overdue"),
    (re.compile(r"\b(?:ebit\s+da)\b", re.IGNORECASE), "EBITDA"),
    (re.compile(r"\b(?:p\s+d\s+f)\b", re.IGNORECASE), "PDF"),
    (re.compile(r"\b(?:c\s+s\s+v)\b", re.IGNORECASE), "CSV"),
    (re.compile(r"\b(?:n\s+d\s+a)\b", re.IGNORECASE), "NDA"),
    (re.compile(r"\b(?:s\s+l\s+a)\b", re.IGNORECASE), "SLA"),
]

# Common domain & English words we must NEVER "auto-correct" into something else via edit distance.
_TRUSTED_WORDS = frozenset({
    "nanvi", "about", "above", "access", "account", "accounts", "action", "actions", "active",
    "after", "again", "against", "agent", "agree", "agreement", "agreements", "ahead",
    "amount", "amounts", "analysis", "annual", "answer", "anyone", "anything", "apple",
    "apply", "april", "archive", "around", "aside", "assets", "assist", "assistant",
    "attach", "audit", "august", "author", "available", "average", "avoid", "award",
    "balance", "balances", "before", "behind", "below", "between", "bigger", "billing",
    "bills", "budget", "budgets", "build", "business", "buyer", "buyers", "called",
    "cancel", "cannot", "cases", "category", "cause", "center", "change", "check",
    "checked", "client", "clients", "close", "closed", "cloud", "company", "compare",
    "complete", "completed", "confirm", "connected", "contact", "contacts", "contain",
    "contains", "content", "contents", "continue", "contract", "contracts", "control",
    "copied", "copilot", "correct", "costs", "could", "count", "create", "created",
    "credit", "critical", "current", "customer", "customers", "daily", "dated", "dates",
    "deadline", "debit", "december", "default", "delete", "deliverable", "department",
    "departments", "detail", "details", "direct", "directory", "display", "document",
    "documents", "doing", "dollar", "dollars", "download", "draft", "drive", "during",
    "earlier", "early", "earning", "earnings", "either", "email", "emails", "employee",
    "employees", "empty", "enable", "enabled", "ending", "energy", "engine", "enough",
    "enter", "enterprise", "entity", "entries", "error", "every", "exact", "example",
    "excel", "except", "existing", "expect", "expense", "expenses", "expired", "expiry",
    "explain", "export", "extract", "failed", "february", "fetch", "fewer", "field",
    "fields", "files", "filter", "final", "finance", "financial", "finding", "finds",
    "first", "folder", "folders", "follow", "forecast", "format", "found", "friday",
    "front", "future", "general", "generate", "given", "gives", "global", "gmail",
    "going", "google", "granted", "greater", "gross", "group", "groups", "growth",
    "guide", "handbook", "having", "headcount", "hello", "helps", "higher", "history",
    "hours", "house", "human", "ignore", "image", "images", "import", "inbox", "include",
    "income", "index", "indexed", "india", "indian", "inline", "input", "inside",
    "install", "instead", "internal", "invoice", "invoices", "issue", "issues", "items",
    "january", "joining", "journal", "july", "june", "keeps", "known", "knows", "large",
    "larger", "latest", "later", "leads", "leave", "ledger", "legal", "less", "letter",
    "level", "liability", "liabilities", "license", "limit", "limits", "lines", "links",
    "listed", "listen", "listening", "lists", "local", "locate", "location", "logged",
    "login", "looking", "looks", "lower", "mails", "major", "makes", "making", "manage",
    "manager", "march", "margin", "market", "match", "matched", "matches", "matching",
    "maybe", "means", "meant", "media", "member", "members", "memory", "merchant",
    "message", "messages", "metric", "metrics", "might", "milestone", "million", "minus",
    "missed", "missing", "modal", "model", "models", "monday", "money", "month",
    "monthly", "months", "morning", "mostly", "multiple", "names", "nandi", "needed",
    "needs", "neither", "never", "newer", "newest", "night", "normal", "notes", "notice",
    "november", "number", "numbers", "october", "offer", "office", "often", "online",
    "opened", "opening", "opens", "option", "options", "order", "orders", "other",
    "others", "outlook", "output", "outside", "overall", "overdue", "owner", "pages",
    "panel", "paper", "parent", "parse", "parts", "party", "passed", "past", "paths",
    "paying", "payment", "payments", "payroll", "pending", "people", "percent", "period",
    "periods", "person", "personal", "personnel", "phone", "place", "plain", "plans",
    "please", "point", "points", "policy", "policies", "portfolio", "possible", "power",
    "preset", "preview", "previous", "price", "prices", "prior", "priority", "privacy",
    "private", "problem", "process", "procurement", "product", "products", "profile",
    "profit", "project", "projects", "prompt", "prompts", "proposal", "proposals",
    "provide", "provider", "public", "pulled", "pulls", "purchase", "quarter", "queries",
    "query", "question", "questions", "quick", "quiet", "quite", "quote", "quotes",
    "range", "rates", "rather", "reached", "react", "reading", "reads", "ready",
    "reason", "receipt", "receipts", "recent", "record", "records", "reduce", "refer",
    "refine", "refined", "register", "rejected", "related", "relative", "release",
    "remain", "remaining", "remember", "remove", "renewal", "renewals", "repeat",
    "replace", "reply", "report", "reports", "request", "requested", "requests",
    "require", "required", "requires", "reset", "resolve", "response", "result",
    "results", "resume", "resumes", "return", "returns", "revenue", "review", "right",
    "rights", "roadmap", "roles", "route", "routes", "running", "salary", "salaries",
    "sales", "sample", "samples", "saturday", "saved", "saving", "savings", "scanned",
    "schedule", "schema", "school", "scope", "score", "screen", "script", "search",
    "searched", "searches", "searching", "second", "section", "sections", "secure",
    "security", "seems", "segment", "segments", "select", "selected", "sender", "sending",
    "sends", "sense", "september", "server", "service", "services", "session", "settings",
    "several", "share", "shared", "sheet", "sheets", "shift", "short", "should", "showing",
    "shows", "signed", "silent", "similar", "simple", "since", "single", "sites",
    "skills", "small", "smaller", "smart", "snippet", "software", "somehow", "someone",
    "something", "sometimes", "sorry", "sorted", "source", "sources", "speak", "speaking",
    "special", "specific", "spent", "split", "spoken", "sprint", "staff", "stage",
    "start", "started", "starting", "state", "statement", "statements", "states", "status",
    "steps", "still", "stock", "stopped", "storage", "store", "stored", "stores",
    "stream", "street", "strict", "string", "stripe", "structured", "study", "style",
    "subject", "submit", "summary", "summaries", "summarize", "sunday", "supplier",
    "suppliers", "support", "supported", "suppose", "switch", "system", "systems",
    "table", "tables", "taken", "takes", "taking", "target", "tasks", "taxes", "teams",
    "technical", "terms", "testing", "tests", "thank", "thanks", "their", "there",
    "these", "thing", "things", "think", "third", "those", "though", "thought", "three",
    "through", "thursday", "ticket", "tickets", "times", "title", "today", "together",
    "token", "tokens", "tomorrow", "topic", "topics", "total", "totals", "track",
    "tracking", "trade", "traders", "training", "transaction", "transactions", "travel",
    "tried", "tries", "trigger", "true", "truth", "trying", "tuesday", "turns", "twice",
    "under", "understand", "unique", "units", "unless", "unlike", "unpaid", "until",
    "update", "updated", "updates", "upload", "uploaded", "urgent", "usage", "users",
    "using", "usually", "valid", "value", "values", "vendor", "vendors", "verify",
    "version", "versus", "video", "videos", "viewed", "viewer", "views", "vision",
    "visit", "voice", "voices", "volume", "wants", "warning", "warranty", "watch",
    "watching", "water", "wednesday", "weeks", "welcome", "where", "whether", "which",
    "while", "white", "whole", "whose", "within", "without", "words", "worked", "worker",
    "workers", "working", "works", "world", "worth", "would", "write", "writing",
    "written", "wrong", "wrote", "yearly", "years", "yesterday", "yield", "young",
})

# High-confidence enterprise vocabulary eligible for single-typo distance-1 correction.
_DEFAULT_ENTERPRISE_TARGETS = frozenset({
    "invoice", "invoices", "contract", "contracts", "agreement", "agreements",
    "proposal", "proposals", "document", "documents", "customer", "customers",
    "employee", "employees", "vendor", "vendors", "supplier", "suppliers",
    "payment", "payments", "summary", "summarize", "warranty", "liability",
    "procurement", "receipt", "receipts", "statement", "statements", "department",
    "departments", "milestone", "deliverable", "portfolio", "schedule", "analytics",
    "transactions", "forecast", "expenses", "revenue", "budget", "overdue",
})


@dataclass(frozen=True)
class RefineChange:
    original: str
    corrected: str
    reason: str


@dataclass(frozen=True)
class QueryRefineResult:
    original_query: str
    refined_query: str
    is_corrected: bool
    changes: tuple[RefineChange, ...] = ()

    @property
    def changes_summary(self) -> str:
        return ", ".join(f"{c.original} -> {c.corrected}" for c in self.changes)


def _match_casing(source: str, target: str) -> str:
    if target[:1].isupper():
        # Preserve canonical casing for proper nouns/acronyms/brands like Nanvi, EBITDA, CloudNova
        return target
    if source.isupper() and len(source) > 1:
        return target.upper()
    if source[:1].isupper():
        return target[:1].upper() + target[1:]
    return target.lower()


def _damerau_levenshtein_1(a: str, b: str) -> int:
    """Fast bounded edit distance checking exact 0, 1, or >=2 edits (including adjacent transpose)."""
    la, lb = len(a), len(b)
    if a == b:
        return 0
    if abs(la - lb) > 1:
        return 2
    if la == lb:
        diffs = [i for i in range(la) if a[i] != b[i]]
        if len(diffs) == 1:
            return 1
        if (
            len(diffs) == 2
            and diffs[1] == diffs[0] + 1
            and a[diffs[0]] == b[diffs[1]]
            and a[diffs[1]] == b[diffs[0]]
        ):
            return 1
        return 2
    # Length difference == 1
    shorter, longer = (a, b) if la < lb else (b, a)
    i = j = 0
    skipped = False
    while i < len(shorter) and j < len(longer):
        if shorter[i] == longer[j]:
            i += 1
            j += 1
        elif not skipped:
            skipped = True
            j += 1
        else:
            return 2
    return 1


def _collect_protected_terms(
    known_terms: Iterable[str] | None,
    local_context: dict | None,
) -> tuple[set[str], set[str]]:
    """Collect workspace filenames/terms so real files/entities named e.g. 'Nandi' are never altered."""
    protected_lower: set[str] = set()
    workspace_targets: set[str] = set()

    def _ingest_text(raw: str) -> None:
        for tok in re.findall(r"[A-Za-z]{4,}", raw or ""):
            low = tok.casefold()
            if len(low) >= 4:
                workspace_targets.add(low)
                if low == "nandi":
                    protected_lower.add("nandi")

    if known_terms:
        for term in known_terms:
            _ingest_text(str(term))

    if isinstance(local_context, dict):
        for f in local_context.get("files") or ():
            if isinstance(f, dict):
                _ingest_text(str(f.get("name") or ""))
                _ingest_text(str(f.get("path") or f.get("full_path") or ""))
        for ch in local_context.get("chunks") or ():
            if isinstance(ch, dict):
                _ingest_text(str(ch.get("filename") or ""))
                _ingest_text(str(ch.get("relative_path") or ""))

    return protected_lower, workspace_targets


def _should_correct_nandi_to_nanvi(
    tokens: list[str],
    word_idx: int,
    full_text: str,
    protected_words: set[str],
    mode: str,
) -> bool:
    """Return True ONLY when 'nandi' clearly refers to the Nanvi assistant rather than a real entity."""
    if "nandi" in protected_words:
        return False

    prev_tok = tokens[word_idx - 1].casefold() if word_idx > 0 else ""
    next_tok = tokens[word_idx + 1].casefold() if word_idx + 1 < len(tokens) else ""
    prev2_tok = tokens[word_idx - 2].casefold() if word_idx > 1 else ""

    # Never alter genuine places, surnames, vendors, or companies named Nandi.
    if next_tok in _NANDI_ENTITY_FOLLOWERS or prev_tok in _NANDI_ENTITY_PREFIXES:
        return False
    # Never alter if preceded by "for/of/to Nandi <proper>" or "invoice/contract for Nandi"
    if prev_tok in {"for", "of", "from"} and (next_tok in _NANDI_ENTITY_FOLLOWERS or not next_tok):
        return False

    # Clear positive signals that the user meant Nanvi:
    if prev_tok in _NANVI_GREETINGS_OR_PREFIXES:
        return True
    if prev2_tok in {"thank", "excuse"} and prev_tok in {"you", "me"}:
        return True
    if next_tok in _NANVI_FOLLOWING_TRIGGERS:
        return True
    if word_idx == 0 and (len(tokens) == 1 or next_tok in _NANVI_FOLLOWING_TRIGGERS):
        return True
    if re.search(r"\b(?:what|who|about|is|meet|using|via|in|with)\s+nandi\b", full_text, re.IGNORECASE):
        if next_tok not in _NANDI_ENTITY_FOLLOWERS and prev_tok not in _NANDI_ENTITY_PREFIXES:
            return True
    # Comma-vocative addressing: "Nandi, ..." or "..., Nandi"
    if re.search(r"(?:^|,\s*)nandi\s*,|,\s*nandi(?:[.!?]|$)", full_text, re.IGNORECASE):
        return True
    # In pure speech-to-text voice mode, standalone/sentence-final vocative is commonly Nanvi
    if mode == "voice" and word_idx == len(tokens) - 1 and prev_tok not in {"for", "from", "at", "near", "in", "mr", "ms", "mrs", "dr"}:
        return True

    return False


def refine_query(
    query: str,
    *,
    mode: str = "chat",
    known_terms: Sequence[str] | None = None,
    local_context: dict | None = None,
) -> QueryRefineResult:
    """Refine a chat or voice query with high precision, updating only confident errors."""
    raw = str(query or "").strip()
    if not raw:
        return QueryRefineResult(original_query="", refined_query="", is_corrected=False)

    protected_words, workspace_targets = _collect_protected_terms(known_terms, local_context)
    candidate_targets = sorted(_DEFAULT_ENTERPRISE_TARGETS | (workspace_targets - {"nandi"}))

    changes: list[RefineChange] = []

    def _refine_unprotected_segment(segment: str) -> str:
        if not segment.strip():
            return segment

        # 1. Existing canonical enterprise phrase phonetics (brand/acronyms like CloudNova, EBITDA)
        text = apply_phonetic_corrections(segment)
        for pat, rep in _SAFE_PHRASE_PATTERNS:
            def _phrase_sub(m: re.Match[str], repl: str = rep) -> str:
                orig = m.group(0)
                if orig != repl:
                    changes.append(RefineChange(orig, repl, "phrase_correction"))
                return repl
            text = pat.sub(_phrase_sub, text)

        # 2. Token-level precision check
        word_matches = list(re.finditer(r"\b[A-Za-z][A-Za-z']*\b", text))
        if not word_matches:
            return text

        tokens = [m.group(0) for m in word_matches]
        rebuilt: list[str] = []
        cursor = 0

        for idx, m in enumerate(word_matches):
            rebuilt.append(text[cursor : m.start()])
            cursor = m.end()
            tok = m.group(0)
            low = tok.casefold()

            if "'" in tok or low in protected_words:
                rebuilt.append(tok)
                continue

            replacement: str | None = None
            reason = ""

            # Context-aware check for Nandi vs Nanvi
            if low in _NANVI_AMBIGUOUS_TOKENS:
                if _should_correct_nandi_to_nanvi(tokens, idx, text, protected_words, mode):
                    replacement = "Nanvi"
                    reason = "brand_phonetic_match"
            elif low in _SAFE_TYPO_MAP:
                candidate = _match_casing(tok, _SAFE_TYPO_MAP[low])
                if candidate != tok:
                    replacement = candidate
                    reason = "known_typo"
            elif (
                len(low) >= 5
                and low not in _TRUSTED_WORDS
                and not tok.isupper()
            ):
                # Strict single-edit check against trusted enterprise/workspace terms:
                # only correct when there is ONE unique unambiguous distance-1 match sharing first letter.
                first_char = low[0]
                exact_matches = [
                    t for t in candidate_targets
                    if len(t) >= 5 and t[0] == first_char and _damerau_levenshtein_1(low, t) == 1
                ]
                if len(exact_matches) == 1:
                    target_word = _match_casing(tok, exact_matches[0])
                    if target_word != tok:
                        replacement = target_word
                        reason = "unique_edit_match"

            if replacement is not None:
                changes.append(RefineChange(tok, replacement, reason))
                rebuilt.append(replacement)
            else:
                rebuilt.append(tok)

        rebuilt.append(text[cursor:])
        return "".join(rebuilt)

    # Process only unprotected parts, keeping paths/IDs/URLs/backticks/quotes verbatim
    parts: list[str] = []
    pos = 0
    for pm in _PROTECTED_SPAN_RE.finditer(raw):
        parts.append(_refine_unprotected_segment(raw[pos : pm.start()]))
        parts.append(pm.group(0))
        pos = pm.end()
    parts.append(_refine_unprotected_segment(raw[pos:]))

    refined = "".join(parts).strip()
    is_corrected = refined != raw
    return QueryRefineResult(
        original_query=raw,
        refined_query=refined,
        is_corrected=is_corrected,
        changes=tuple(changes),
    )


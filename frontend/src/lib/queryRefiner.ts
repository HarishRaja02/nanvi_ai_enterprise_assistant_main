/**
 * Precision Chat & Voice Query Refine Layer.
 *
 * Detects and auto-corrects confident mishearings and clear typing errors
 * (e.g. "hi nandi" -> "hi Nanvi", "proposl" -> "proposal") while protecting
 * legitimate entities ("Nandi Traders", "Nandi Hills"), filenames, paths,
 * URLs, codes, quoted text, and ordinary English words ("detect correct one only").
 */

export interface RefineChange {
  original: string;
  corrected: string;
  reason: string;
}

export interface QueryRefineResult {
  originalQuery: string;
  refinedQuery: string;
  isCorrected: boolean;
  changes: RefineChange[];
  changesSummary: string;
}

export interface RefineOptions {
  mode?: "chat" | "voice";
  knownTerms?: string[];
}

const PROTECTED_SPAN_RE =
  /(`[^`]+`|"[^"]+"|https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:[A-Za-z]:)?[\\/][^\s]+|\b[\w-]+\.(?:pdf|docx?|xlsx?|csv|tsv|pptx?|txt|md|json|xml|html?|png|jpe?g|webp|zip)\b|\b[A-Z]{2,8}[-_]\d{1,8}(?:[-_]\d{1,8})?\b)/g;

const NANDI_ENTITY_FOLLOWERS = new Set([
  "hills", "hill", "road", "street", "nagar", "colony", "temple", "statue",
  "traders", "trading", "enterprises", "enterprise", "logistics", "motors", "foods",
  "industries", "builders", "constructions", "solutions", "technologies", "tech",
  "systems", "group", "corp", "corporation", "ltd", "limited", "pvt", "inc", "llc",
  "vendors", "vendor", "suppliers", "supplier", "stores", "store", "mart", "pharmacy",
  "hotel", "hospital", "school", "college", "station", "junction", "circle", "park",
  "sharma", "patel", "reddy", "kumar", "verma", "rao", "singh", "das", "nair", "menon",
]);

const NANDI_ENTITY_PREFIXES = new Set([
  "mr", "mrs", "ms", "dr", "prof", "shri", "smt", "from", "vendor", "client",
  "customer", "supplier", "company", "visit", "visited", "at", "near", "in",
]);

const NANVI_GREETINGS_OR_PREFIXES = new Set([
  "hi", "hii", "hiii", "hello", "hey", "heyy", "ok", "okay", "dear",
  "thanks", "thank", "bye", "goodbye", "goodmorning", "morning",
  "afternoon", "evening", "please", "pls", "plz", "ask", "tell",
  "excuse", "sorry", "yo", "hola", "namaste", "help",
]);

const NANVI_FOLLOWING_TRIGGERS = new Set([
  "ai", "assistant", "copilot", "bot", "app", "enterprise", "platform", "system",
  "search", "find", "show", "get", "list", "check", "open", "give", "tell",
  "summarize", "summary", "explain", "read", "fetch", "pull", "help", "can",
  "could", "would", "please", "pls", "plz", "do", "does", "did", "is", "are",
  "how", "what", "where", "when", "why", "which", "who",
]);

const NANVI_AMBIGUOUS_TOKENS = new Set(["nandi", "nandy", "nani"]);

const SAFE_TYPO_MAP: Record<string, string> = {
  nanbi: "Nanvi",
  nanbhi: "Nanvi",
  nanvee: "Nanvi",
  nanvy: "Nanvi",
  nanwi: "Nanvi",
  nanvhi: "Nanvi",
  nonvi: "Nanvi",
  namvi: "Nanvi",
  nenvi: "Nanvi",
  nanvi: "Nanvi",
  invoics: "invoices",
  invoces: "invoices",
  invoic: "invoice",
  invoce: "invoice",
  customres: "customers",
  customrs: "customers",
  cutomers: "customers",
  costomers: "customers",
  customr: "customer",
  cutomer: "customer",
  costomer: "customer",
  employes: "employees",
  emplyees: "employees",
  emploees: "employees",
  employe: "employee",
  emplyee: "employee",
  emploee: "employee",
  salry: "salary",
  salery: "salary",
  sallery: "salary",
  salries: "salaries",
  saleries: "salaries",
  contrct: "contract",
  contraxt: "contract",
  contarct: "contract",
  cntract: "contract",
  contrac: "contract",
  contrcts: "contracts",
  agreemnt: "agreement",
  aggrement: "agreement",
  agrement: "agreement",
  agrements: "agreements",
  warenty: "warranty",
  warrenty: "warranty",
  waranty: "warranty",
  liabilty: "liability",
  liabelity: "liability",
  liablity: "liability",
  procument: "procurement",
  procuremnt: "procurement",
  procurment: "procurement",
  proposl: "proposal",
  propasal: "proposal",
  proposla: "proposal",
  proposls: "proposals",
  propasals: "proposals",
  documnt: "document",
  documet: "document",
  docuemnt: "document",
  documnts: "documents",
  documets: "documents",
  docuemnts: "documents",
  summery: "summary",
  sumary: "summary",
  sumarize: "summarize",
  summariz: "summarize",
  revanue: "revenue",
  revenu: "revenue",
  revnue: "revenue",
  budgt: "budget",
  budjet: "budget",
  buget: "budget",
  amout: "amount",
  ammount: "amount",
  earnign: "earning",
  earngs: "earnings",
  vender: "vendor",
  vendr: "vendor",
  venders: "vendors",
  assitant: "assistant",
  assisant: "assistant",
  assistent: "assistant",
  ebidta: "EBITDA",
  payed: "paid",
};

const CANONICAL_PHRASE_PATTERNS: Array<[RegExp, string]> = [
  [/\baster\s*on(?:\s*tech(?:nologies)?)?\b/gi, "Asteron Technologies"],
  [/\bcloud\s+nova\b/gi, "CloudNova"],
  [/\bblue\s+peak\b/gi, "BluePeak"],
  [/\bnexa\s*corp\b/gi, "NexaCorp"],
  [/\bhorizon\s+dynamics?\b/gi, "Horizon Dynamics"],
  [/\bquantum\s*tech\b/gi, "QuantumTech"],
  [/\bproject\s+f(?:e|he)nix\b/gi, "Project Phoenix"],
  [/\bebit\s*da\b/gi, "EBITDA"],
  [/\bg\s+s\s+t\b/gi, "GST"],
  [/\bt\s+d\s+s\b/gi, "TDS"],
  [/\bc\s+t\s+c\b/gi, "CTC"],
  [/\bp\s+d\s+f\b/gi, "PDF"],
  [/\bc\s+s\s+v\b/gi, "CSV"],
  [/\bn\s+d\s+a\b/gi, "NDA"],
  [/\bs\s+l\s+a\b/gi, "SLA"],
  [/\bin\s+voices\b/gi, "invoices"],
  [/\bin\s+voice\b/gi, "invoice"],
  [/\b(?:ageing|aging)\s*(?:brakdown|break\s*down)\b/gi, "aging breakdown"],
  [/\bover\s+due\b/gi, "overdue"],
  [/\b(?:(?:sri|shri)\s+ganesh?(?:\s+(?:ready\s*mix|redymix|radymix))?|ganesh?\s+(?:ready\s*mix|redymix|radymix))\b/gi, "Sri Ganesh ReadyMix"],
];

const VOICE_ONLY_PHRASE_PATTERNS: Array<[RegExp, string]> = [
  [/\bfind\s+in\s+voice\b/gi, "find invoice"],
  [/\b(\d+(?:\.\d+)?)\s*lacs?\b/gi, "$1 lakh"],
  [/\b(\d+(?:\.\d+)?)\s*crs?\b/gi, "$1 crore"],
  [/\bp\s+o\b/gi, "PO"],
];

const TRUSTED_WORDS = new Set([
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
]);

const DEFAULT_ENTERPRISE_TARGETS = [
  "invoice", "invoices", "contract", "contracts", "agreement", "agreements",
  "proposal", "proposals", "document", "documents", "customer", "customers",
  "employee", "employees", "vendor", "vendors", "supplier", "suppliers",
  "payment", "payments", "summary", "summarize", "warranty", "liability",
  "procurement", "receipt", "receipts", "statement", "statements", "department",
  "departments", "milestone", "deliverable", "portfolio", "schedule", "analytics",
  "transactions", "forecast", "expenses", "revenue", "budget", "overdue",
];

function matchCasing(source: string, target: string): string {
  if (target[0] && target[0] === target[0].toUpperCase()) {
    return target;
  }
  if (source.length > 1 && source === source.toUpperCase()) {
    return target.toUpperCase();
  }
  if (source[0] && source[0] === source[0].toUpperCase()) {
    return target[0].toUpperCase() + target.slice(1);
  }
  return target.toLowerCase();
}

function damerauLevenshteinBounded1(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (a === b) return 0;
  if (Math.abs(la - lb) > 1) return 2;
  if (la === lb) {
    const diffs: number[] = [];
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) diffs.push(i);
    }
    if (diffs.length === 1) return 1;
    if (
      diffs.length === 2 &&
      diffs[1] === diffs[0] + 1 &&
      a[diffs[0]] === b[diffs[1]] &&
      a[diffs[1]] === b[diffs[0]]
    ) {
      return 1;
    }
    return 2;
  }
  const shorter = la < lb ? a : b;
  const longer = la < lb ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else if (!skipped) {
      skipped = true;
      j++;
    } else {
      return 2;
    }
  }
  return 1;
}

function collectProtectedAndTargets(knownTerms?: string[]): {
  protectedWords: Set<string>;
  candidateTargets: string[];
} {
  const protectedWords = new Set<string>();
  const targetSet = new Set<string>(DEFAULT_ENTERPRISE_TARGETS);

  for (const term of knownTerms || []) {
    const matches = String(term || "").match(/[A-Za-z]{4,}/g) || [];
    for (const rawTok of matches) {
      const low = rawTok.toLowerCase();
      if (low === "nandi") {
        protectedWords.add("nandi");
      } else {
        targetSet.add(low);
      }
    }
  }

  return {
    protectedWords,
    candidateTargets: Array.from(targetSet),
  };
}

function shouldCorrectNandiToNanvi(
  tokens: string[],
  idx: number,
  fullText: string,
  protectedWords: Set<string>,
  mode: "chat" | "voice",
): boolean {
  if (protectedWords.has("nandi")) return false;

  const prev = idx > 0 ? tokens[idx - 1].toLowerCase() : "";
  const next = idx + 1 < tokens.length ? tokens[idx + 1].toLowerCase() : "";
  const prev2 = idx > 1 ? tokens[idx - 2].toLowerCase() : "";

  if (NANDI_ENTITY_FOLLOWERS.has(next) || NANDI_ENTITY_PREFIXES.has(prev)) {
    return false;
  }
  if ((prev === "for" || prev === "of" || prev === "from") && (NANDI_ENTITY_FOLLOWERS.has(next) || !next)) {
    return false;
  }

  if (NANVI_GREETINGS_OR_PREFIXES.has(prev)) return true;
  if ((prev2 === "thank" || prev2 === "excuse") && (prev === "you" || prev === "me")) return true;
  if (NANVI_FOLLOWING_TRIGGERS.has(next)) return true;
  if (idx === 0 && (tokens.length === 1 || NANVI_FOLLOWING_TRIGGERS.has(next))) return true;
  if (
    /\b(?:what|who|about|is|meet|using|via|in|with)\s+nandi\b/i.test(fullText) &&
    !NANDI_ENTITY_FOLLOWERS.has(next) &&
    !NANDI_ENTITY_PREFIXES.has(prev)
  ) {
    return true;
  }
  if (/(?:^|,\s*)nandi\s*,|,\s*nandi(?:[.!?]|$)/i.test(fullText)) {
    return true;
  }
  if (
    mode === "voice" &&
    idx === tokens.length - 1 &&
    !["for", "from", "at", "near", "in", "mr", "ms", "mrs", "dr"].includes(prev)
  ) {
    return true;
  }
  return false;
}

/**
 * Refines a chat or voice query with high precision ("detect correct one only").
 */
export function refineChatQuery(query: string, options: RefineOptions = {}): QueryRefineResult {
  const mode = options.mode || "chat";
  const raw = String(query || "").trim();
  if (!raw) {
    return {
      originalQuery: "",
      refinedQuery: "",
      isCorrected: false,
      changes: [],
      changesSummary: "",
    };
  }

  const { protectedWords, candidateTargets } = collectProtectedAndTargets(options.knownTerms);
  const changes: RefineChange[] = [];

  const refineSegment = (segment: string): string => {
    if (!segment.trim()) return segment;

    let text = segment;
    const patterns =
      mode === "voice"
        ? [...CANONICAL_PHRASE_PATTERNS, ...VOICE_ONLY_PHRASE_PATTERNS]
        : CANONICAL_PHRASE_PATTERNS;

    for (const [pat, rep] of patterns) {
      text = text.replace(pat, (matched, ...args) => {
        const resolved = rep.includes("$")
          ? rep.replace(/\$(\d+)/g, (_, n) => String(args[Number(n) - 1] ?? ""))
          : rep;
        if (matched !== resolved) {
          changes.push({ original: matched, corrected: resolved, reason: "phrase_correction" });
        }
        return resolved;
      });
    }

    const wordRegex = /\b[A-Za-z][A-Za-z']*\b/g;
    const wordMatches = Array.from(text.matchAll(wordRegex));
    if (wordMatches.length === 0) return text;

    const tokens = wordMatches.map((m) => m[0]);
    let out = "";
    let cursor = 0;

    for (let idx = 0; idx < wordMatches.length; idx++) {
      const m = wordMatches[idx];
      const start = m.index ?? 0;
      const tok = m[0];
      const end = start + tok.length;

      out += text.slice(cursor, start);
      cursor = end;

      const low = tok.toLowerCase();
      if (tok.includes("'") || protectedWords.has(low)) {
        out += tok;
        continue;
      }

      let replacement: string | null = null;
      let reason = "";

      if (NANVI_AMBIGUOUS_TOKENS.has(low)) {
        if (shouldCorrectNandiToNanvi(tokens, idx, text, protectedWords, mode)) {
          replacement = "Nanvi";
          reason = "brand_phonetic_match";
        }
      } else if (Object.prototype.hasOwnProperty.call(SAFE_TYPO_MAP, low)) {
        const candidate = matchCasing(tok, SAFE_TYPO_MAP[low]);
        if (candidate !== tok) {
          replacement = candidate;
          reason = "known_typo";
        }
      } else if (low.length >= 5 && !TRUSTED_WORDS.has(low) && tok !== tok.toUpperCase()) {
        const firstChar = low[0];
        const exactMatches = candidateTargets.filter(
          (t) => t.length >= 5 && t[0] === firstChar && damerauLevenshteinBounded1(low, t) === 1,
        );
        if (exactMatches.length === 1) {
          const candidate = matchCasing(tok, exactMatches[0]);
          if (candidate !== tok) {
            replacement = candidate;
            reason = "unique_edit_match";
          }
        }
      }

      if (replacement !== null) {
        changes.push({ original: tok, corrected: replacement, reason });
        out += replacement;
      } else {
        out += tok;
      }
    }

    out += text.slice(cursor);
    return out;
  };

  let refined = "";
  let pos = 0;
  for (const pm of raw.matchAll(PROTECTED_SPAN_RE)) {
    const start = pm.index ?? 0;
    refined += refineSegment(raw.slice(pos, start));
    refined += pm[0];
    pos = start + pm[0].length;
  }
  refined += refineSegment(raw.slice(pos));
  refined = refined.trim();

  const changesSummary = changes.map((c) => `${c.original} → ${c.corrected}`).join(", ");
  return {
    originalQuery: raw,
    refinedQuery: refined,
    isCorrected: refined !== raw,
    changes,
    changesSummary,
  };
}


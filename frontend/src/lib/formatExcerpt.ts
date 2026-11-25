export interface ParsedExcerptItem {
  filename: string;
  extBadge: string;
  locationLabel?: string;
  text: string;
}

export interface ParsedSummarySections {
  proseBefore: string;
  excerptsHeading?: string;
  excerpts: ParsedExcerptItem[];
  proseAfter: string;
}

const TECH_TAG_RE = /^\[(?:CSV|TSV|PDF|DOCX|XLSX|PPTX|Body|Metadata|Rows[^\]]*)\]\s*/i;
const LOC_TAG_RE = /\[((?:Page|Sheet|Slide)\s+[^\]]+)\]/i;

function humanizeColumnKey(raw: string): string {
  const cleaned = raw.trim().replace(/^Columns:\s*/i, "");
  if (!cleaned) return "";
  return cleaned
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => {
      const lw = w.toLowerCase();
      if (lw === "id") return "ID";
      if (lw === "url" || lw === "api" || lw === "ai" || lw === "hr" || lw === "qa") return lw.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function truncateAtWordBoundary(text: string, maxLen: number): string {
  const s = text.trim();
  if (s.length <= maxLen) return s;
  const slice = s.slice(0, maxLen);
  const lastBreak = Math.max(
    slice.lastIndexOf(" "),
    slice.lastIndexOf(","),
    slice.lastIndexOf(";"),
  );
  const cut = lastBreak > Math.floor(maxLen * 0.55) ? slice.slice(0, lastBreak) : slice;
  return cut.replace(/[\s,;:·\-–—]+$/, "").trim() + "…";
}

function tryFormatFlattenedCsvPipes(body: string): string | null {
  if (!body.includes("|")) return null;
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Case A: Explicit multi-line CSV / Sheet table snippet
  if (lines.length >= 2 && lines[0].includes("|") && lines[1].includes("|")) {
    const headers = lines[0].split("|").map((h) => h.trim()).filter(Boolean);
    const rowCells = lines[1].split("|").map((c) => c.trim());
    if (headers.length >= 2 && headers.length <= 10 && rowCells.length >= 2) {
      const pairs: string[] = [];
      const count = Math.min(headers.length, rowCells.length);
      for (let i = 0; i < count; i++) {
        if (rowCells[i]) pairs.push(`${humanizeColumnKey(headers[i])}: ${rowCells[i]}`);
      }
      if (pairs.length >= 2) return pairs.join(" · ");
    }
  }

  // Case B: Flattened single-line pipe string produced when newlines became spaces, e.g.:
  // "task_id | project_id | task | owner | status | priority | due_date T-011-000 | P-011-000 | API development | ..."
  const parts = body.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 4) {
    // Check if one part contains "<last_header> <first_row_value>" (e.g. "due_date T-011-000")
    const headerRowIdx = parts.findIndex((p, idx) => idx >= 1 && idx <= 8 && /^[a-z][a-z0-9_]{1,24}\s+[A-Z0-9]/.test(p));
    if (headerRowIdx !== -1) {
      const splitM = parts[headerRowIdx].match(/^([a-z][a-z0-9_]{1,24})\s+(.+)$/);
      if (splitM) {
        const headers = [...parts.slice(0, headerRowIdx), splitM[1]];
        const values = [splitM[2], ...parts.slice(headerRowIdx + 1)];
        const pairs: string[] = [];
        const count = Math.min(headers.length, values.length);
        for (let i = 0; i < count; i++) {
          const val = values[i];
          // If the next record starts inside the last cell (e.g. "2026-12-07 T-011-001"), trim the second record cleanly
          const cleanVal =
            i === headers.length - 1
              ? val.replace(/\s+[A-Z]{1,4}-\d{2,}.*$/, "").trim()
              : val;
          if (cleanVal) {
            pairs.push(`${humanizeColumnKey(headers[i])}: ${cleanVal}`);
          }
        }
        if (pairs.length >= 2) return pairs.join(" · ");
      }
    }
  }

  return parts.join(" · ");
}

/**
 * Strip technical extraction noise ([CSV], [Page 2], outer quotes, raw pipes, mid-word cutoffs)
 * to produce a crisp, executive-readable document excerpt.
 */
export function formatCleanExcerpt(raw: string, maxLen = 220): { locationLabel?: string; text: string } {
  let s = String(raw || "").trim();
  // Strip wrapping markdown emphasis or double/curly quotes
  s = s.replace(/^[*_"`“”']+|[*_"`“”']+$/g, "").trim();

  let locationLabel: string | undefined;
  const locM = s.match(LOC_TAG_RE);
  if (locM && locM[1]) {
    locationLabel = locM[1].replace(/\s+/g, " ").trim();
  }

  s = s
    .replace(TECH_TAG_RE, "")
    .replace(/\[(?:Page|Sheet|Slide|Rows)\s+[^\]]+\]/gi, " ")
    .replace(/\[(?:CSV|TSV|PDF|DOCX|XLSX|PPTX|Body|Metadata)\]/gi, " ")
    .replace(/Synthetic vendor invoice created for document-ingestion and RAG testing\.?/gi, " ")
    .replace(/^Columns:\s*/i, "")
    .replace(/\u25a0/g, "")
    .trim();

  // Remove duplicated "Page 2 Attribute Value" PDF table artifacts & fix broken INR "I13.9 lakh" glyph
  if (locationLabel) {
    const escapedLoc = locationLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`\\b${escapedLoc}\\b`, "gi"), " ");
  }
  s = s
    .replace(/\bAttribute\s+Value\b/gi, " ")
    .replace(/\bField\s+Value\b/gi, " ")
    .replace(/(?:^|\s)I(\d[\d,.]*\s*(?:lakhs?|crores?))\b/gi, " ₹$1");

  const csvClean = tryFormatFlattenedCsvPipes(s);
  if (csvClean) {
    s = csvClean;
  }

  // Collapse excess whitespace while removing dangling incomplete trailing ellipsis fragment before re-truncating cleanly
  s = s.replace(/\s+/g, " ").replace(/^[\s·|:,-]+/, "").trim();
  if (/(?:\.\.\.|…)$/.test(s)) {
    const withoutDots = s.replace(/(?:\.\.\.|…)+$/, "").trim();
    const lastSpace = withoutDots.lastIndexOf(" ");
    const endsCleanWord = /[a-zA-Z0-9.)%]$/.test(withoutDots) && !/-\d$| [a-zA-Z]$/.test(withoutDots);
    if (!endsCleanWord && lastSpace > Math.floor(withoutDots.length * 0.5)) {
      s = withoutDots.slice(0, lastSpace).replace(/[\s,;:·\-–—]+$/, "").trim() + "…";
    } else {
      s = withoutDots.replace(/[\s,;:·\-–—]+$/, "").trim() + "…";
    }
  }

  s = truncateAtWordBoundary(s, maxLen);
  return { locationLabel, text: s };
}

function getExtensionBadge(filename: string): string {
  const m = filename.trim().match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toUpperCase() : "FILE";
}

/**
 * Parse Summary & Explanation markdown into clean prose sections plus structured document excerpt cards.
 */
export function parseSummaryAndExcerpts(cleanedText: string): ParsedSummarySections {
  const src = String(cleanedText || "").replace(/\r\n?/g, "\n").trim();
  if (!src) return { proseBefore: "", excerpts: [], proseAfter: "" };

  const lines = src.split("\n");
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  const excerpts: ParsedExcerptItem[] = [];
  let excerptsHeading: string | undefined;
  let inExcerpts = false;
  let passedExcerpts = false;

  const excerptLineRe = /^\s*(?:[-•*]|\d+\.)\s+(?:\*\*|`|)?([^:*`]+?)(?:\*\*|`|)?\s*[:—-]\s*(.+)$/;
  const headingRe = /^\s*(?:\*\*|#+\s*)?(Relevant Document Excerpts|Document Highlights|Key Excerpts)\s*:?\s*(?:\*\*)?\s*$/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inExcerpts && !passedExcerpts && headingRe.test(trimmed)) {
      inExcerpts = true;
      excerptsHeading = "Relevant Document Excerpts";
      continue;
    }

    if (inExcerpts) {
      if (!trimmed) continue;
      const m = trimmed.match(excerptLineRe);
      if (m) {
        const fn = m[1].trim();
        const cleaned = formatCleanExcerpt(m[2].trim(), 220);
        if (cleaned.text) {
          excerpts.push({
            filename: fn,
            extBadge: getExtensionBadge(fn),
            locationLabel: cleaned.locationLabel,
            text: cleaned.text,
          });
        }
        continue;
      }
      // First non-excerpt line ends the excerpts block
      inExcerpts = false;
      passedExcerpts = true;
      afterLines.push(line);
      continue;
    }

    if (passedExcerpts) {
      afterLines.push(line);
    } else {
      beforeLines.push(line);
    }
  }

  let proseBefore = beforeLines.join("\n").trim();
  if (excerpts.length > 0 && proseBefore.endsWith(":")) {
    proseBefore = proseBefore.slice(0, -1).trim();
  }
  const proseAfter = afterLines.join("\n").trim();

  return { proseBefore, excerptsHeading, excerpts, proseAfter };
}


import { cleanBrowserDisplayPath } from "./browserFolderSync";
import type { FileResultItem } from "../types";

const FILE_EXT_RE =
  /\.(?:pdf|docx?|xlsx?|csv|tsv|pptx?|txt|md|rtf|json|xml|html?|log|yaml|yml|png|jpe?g|webp|bmp|tiff?|gif|svg)$/i;

const NON_FILE_TABLE_HEADER_RE =
  /\b(?:amount|price|cost|salary|revenue|total|balance|status|customer|vendor|party|invoice\s*(?:id|no|number)?|subject|from|sender|department|date|metric|kpi|quarter|year|margin|profit)\b/i;

const FILE_HEADER_RE = /\b(?:file\s*name|document\s*(?:name)?|proposal|report|filename|file)\b/i;
const PATH_HEADER_RE = /\b(?:file\s*path|folder\s*path|relative\s*path|path|location|folder|directory|source|link|url)\b/i;

function stripCellDecorations(cell: string): string {
  return cell
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/^\*|\*$/g, "")
    .trim();
}

function parsePipeRow(line: string): string[] {
  let clean = line.trim();
  if (clean.startsWith("|")) clean = clean.slice(1);
  if (clean.endsWith("|")) clean = clean.slice(0, -1);
  return clean.split("|").map((c) => c.trim());
}

function isSeparatorLine(line: string): boolean {
  const clean = line.trim().replace(/^\|/, "").replace(/\|$/, "").trim();
  if (!clean) return false;
  return /^[\s:\-|]+$/.test(clean) && clean.includes("-");
}

function isPathLikeValue(val: string): boolean {
  const s = stripCellDecorations(val);
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return false;
  if (s.includes("/") || s.includes("\\")) return true;
  if (/^[a-z]:/i.test(s)) return true;
  return false;
}

function isFilenameLikeValue(val: string): boolean {
  const s = stripCellDecorations(val).replace(/^\[[^\]]+\]\s*/, "").trim();
  if (!s || isPathLikeValue(s)) return false;
  return FILE_EXT_RE.test(s);
}

/**
 * Extracts a FileResultItem (filename + path) from a table row if it represents a file reference.
 */
export function extractFileFromTableRow(headers: string[], row: string[]): FileResultItem | null {
  if (!row || row.length === 0) return null;

  let filename = "";
  let filePath = "";
  let openUrl = "";

  for (let i = 0; i < row.length; i++) {
    const raw = (row[i] || "").trim();
    if (!raw) continue;

    const mdLink = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (mdLink) {
      const linkTarget = stripCellDecorations(mdLink[2]);
      const linkLabel = stripCellDecorations(mdLink[1]);
      if (isPathLikeValue(linkTarget) || FILE_EXT_RE.test(linkTarget) || /^https?:\/\//i.test(linkTarget)) {
        if (/^https?:\/\//i.test(linkTarget)) {
          openUrl = linkTarget;
        } else if (!filePath) {
          filePath = linkTarget;
        }
        if (!filename && isFilenameLikeValue(linkLabel)) {
          filename = linkLabel;
        }
        continue;
      }
    }

    const cleaned = stripCellDecorations(raw);
    const hdr = (headers[i] || "").toLowerCase();

    if (isPathLikeValue(cleaned)) {
      if (!filePath || PATH_HEADER_RE.test(hdr)) {
        filePath = cleaned;
      }
      continue;
    }

    if (isFilenameLikeValue(cleaned)) {
      if (!filename || FILE_HEADER_RE.test(hdr)) {
        filename = cleaned;
      }
    }
  }

  if (!filename && filePath) {
    const baseName = filePath.split(/[\\/]/).pop()?.trim() || "";
    if (FILE_EXT_RE.test(baseName)) {
      filename = baseName;
    }
  }

  if (!filename) return null;
  const resolvedPath = cleanBrowserDisplayPath(filePath || openUrl || filename);
  const hasRealPath = Boolean(
    resolvedPath &&
      (resolvedPath.includes("/") ||
        resolvedPath.includes("\\") ||
        /^https?:\/\//i.test(resolvedPath)),
  );
  if (!hasRealPath && !filePath) {
    return null;
  }

  const ext = filename.split(".").pop()?.toLowerCase() || "file";
  return {
    name: filename,
    path: resolvedPath,
    full_path: resolvedPath,
    display_path: resolvedPath,
    type: ext,
    open_url: openUrl || resolvedPath,
    source: "knowledge",
    match_type: "name",
  };
}

/**
 * Returns true if a parsed markdown table is primarily a file-listing directory table
 * (e.g. File Name | Folder Path) rather than an analytics/metrics table.
 */
export function isFileListingMarkdownTable(headers: string[], rows: string[][]): boolean {
  if (!headers || headers.length < 2 || headers.length > 4 || !rows || rows.length === 0) {
    return false;
  }

  const nonActionHeaders = headers.filter((h) => !/^(?:#|no\.?|action|actions|open|preview)$/i.test(h.trim()));
  if (nonActionHeaders.some((h) => NON_FILE_TABLE_HEADER_RE.test(h))) {
    return false;
  }

  const hasFileHeader = headers.some((h) => FILE_HEADER_RE.test(h));
  const hasPathHeader = headers.some((h) => PATH_HEADER_RE.test(h));

  let matchedFileRows = 0;
  for (const row of rows) {
    if (extractFileFromTableRow(headers, row)) {
      matchedFileRows += 1;
    }
  }

  if (matchedFileRows === 0) return false;
  if (hasFileHeader && hasPathHeader) return true;
  return matchedFileRows / rows.length >= 0.6;
}

/**
 * Scans markdown text for pipe tables listing files (even with varied header names like
 * "File Name | Folder Path" or "Document | Path") and extracts structured FileResultItem entries.
 */
export function extractFileResultsFromMarkdownTables(markdownText: string): FileResultItem[] {
  if (!markdownText || !markdownText.includes("|")) return [];
  const lines = markdownText.replace(/\r\n?/g, "\n").split("\n");
  const results: FileResultItem[] = [];
  const seen = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : "";
    if (line.includes("|") && !isSeparatorLine(line) && (isSeparatorLine(nextLine) || (line.startsWith("|") && nextLine.startsWith("|")))) {
      const tableLines: string[] = [];
      while (i < lines.length) {
        const tl = lines[i].trim();
        if (!tl || (!tl.includes("|") && !isSeparatorLine(tl))) break;
        tableLines.push(tl);
        i++;
      }
      if (tableLines.length >= 2) {
        const headers = parsePipeRow(tableLines[0]);
        const rowStart = isSeparatorLine(tableLines[1]) ? 2 : 1;
        const rows = tableLines
          .slice(rowStart)
          .map(parsePipeRow)
          .filter((cells) => cells.some((c) => c.length > 0));
        if (isFileListingMarkdownTable(headers, rows)) {
          for (const row of rows) {
            const item = extractFileFromTableRow(headers, row);
            if (!item) continue;
            const key = (item.full_path || item.path || item.name).replace(/\\/g, "/").toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              results.push(item);
            }
          }
        }
      }
      continue;
    }
    i++;
  }

  return results;
}

/**
 * Removes redundant file-listing markdown tables from summary text once FileResultsTable
 * renders them with Preview/Open actions, while preserving non-file data/analytics tables.
 */
export function stripRedundantFileListingTables(markdownText: string): string {
  if (!markdownText || !markdownText.includes("|")) return markdownText;
  const lines = markdownText.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : "";
    if (line.includes("|") && !isSeparatorLine(line) && (isSeparatorLine(nextLine) || (line.startsWith("|") && nextLine.startsWith("|")))) {
      const start = i;
      const tableLines: string[] = [];
      while (i < lines.length) {
        const tl = lines[i].trim();
        if (!tl || (!tl.includes("|") && !isSeparatorLine(tl))) break;
        tableLines.push(tl);
        i++;
      }
      if (tableLines.length >= 2) {
        const headers = parsePipeRow(tableLines[0]);
        const rowStart = isSeparatorLine(tableLines[1]) ? 2 : 1;
        const rows = tableLines
          .slice(rowStart)
          .map(parsePipeRow)
          .filter((cells) => cells.some((c) => c.length > 0));
        if (isFileListingMarkdownTable(headers, rows)) {
          continue;
        }
      }
      out.push(...lines.slice(start, i));
      continue;
    }
    out.push(lines[i]);
    i++;
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}


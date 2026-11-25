/**
 * Browser Direct Folder Access via the File System Access API + IndexedDB.
 *
 * Allows browser and Electron desktop users to connect any Windows/macOS folder
 * directly without legacy scripts or standalone connectors:
 * - Opens the native OS folder picker (window.showDirectoryPicker)
 * - Persists the DirectoryHandle in IndexedDB for 1-click reconnect across visits
 * - Extracts text client-side (plain text, CSV/JSON/HTML/XML, DOCX/XLSX/PPTX via ZIP+DecompressionStream,
 *   and PDFs with stateless backend text-extraction fallback for complex PDFs)
 * - Syncs searchable chunks to /api/local-agent/sync using a scoped pairing token
 * - Serves real local File blobs from browser handle for instant previews & downloads
 * - Watches modified timestamps & sends heartbeats while the browser tab remains open
 */
import type { NanviApiClient } from "../api";
import { isEmailQuery } from "./isEmailQuery";
import * as XLSX from "xlsx";
import Papa from "papaparse";

// Type augmentation for File System Access API (Chrome / Edge / Opera / Brave)
export interface BrowserPermissionDescriptor {
  mode?: "read" | "readwrite";
}

export interface BrowserDirectoryHandle extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
  queryPermission(desc?: BrowserPermissionDescriptor): Promise<PermissionState>;
  requestPermission(desc?: BrowserPermissionDescriptor): Promise<PermissionState>;
}

export type BrowserSyncProgress = {
  phase: "scanning" | "extracting" | "syncing" | "done" | "error";
  scannedFiles: number;
  indexedFiles: number;
  cachedFiles?: number;
  totalFiles: number;
  totalChunks: number;
  currentFile?: string;
  message: string;
};

export type BrowserSyncResult = {
  folderName: string;
  folderId: string;
  fileCount: number;
  chunkCount: number;
  reusedCachedCount?: number;
  backgroundSyncing?: boolean;
};

export type BrowserSyncOptions = {
  skipIfBackendMatches?: boolean;
  forceFullReindex?: boolean;
  /** Register folder metadata immediately and stream file chunks silently in the background. */
  background?: boolean;
  /** Desktop Zero-Upload mode: index & search strictly on-device without uploading chunks to cloud DB. */
  localOnly?: boolean;
};

export type DesktopLocalFolderMeta = {
  folderId: string;
  folderPath: string;
  folderName: string;
  fileCount: number;
  chunkCount: number;
  lastSyncedAt: string;
};

export type DesktopLocalQueryContext = {
  folder_path: string;
  files: Array<{
    name: string;
    path: string;
    full_path: string;
    display_path: string;
    type: string;
    open_url: string;
    source: string;
    content_snippet?: string;
  }>;
  chunks: Array<{
    chunk_id: string;
    folder_path: string;
    relative_path: string;
    filename: string;
    citation: string;
    text: string;
  }>;
};

export type BrowserFileMeta = {
  relative_path: string;
  filename: string;
  folder_name: string;
  file_type: string;
  size_bytes: number;
  chunk_count: number;
  modified_at?: string;
};

export type BrowserChunkRecord = {
  chunk_id: string;
  relative_path: string;
  filename: string;
  folder_name: string;
  chunk_index: number;
  text: string;
  char_count: number;
  modified_at?: string;
  metadata?: Record<string, unknown>;
};

type CachedFileEntry = {
  lastModified: number;
  size: number;
  fileRecord: BrowserFileMeta;
  chunks: BrowserChunkRecord[];
};

type CachedFolderIndex = {
  folderName: string;
  updatedAt: number;
  uploadedChunks?: number;
  entries: Record<string, CachedFileEntry>;
};

const IDB_NAME = "nanvi-local-folders";
const IDB_VERSION = 2;
const IDB_STORE = "handles";
const IDB_CACHE_STORE = "indexCache";
const IDB_PRIMARY_KEY = "primary-company-folder";
const IDB_LAST_FOLDER_KEY = "__last_folder_name__";

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACT_FALLBACK_BYTES = 14 * 1024 * 1024;
const CHUNK_SIZE_CHARS = 1000;
const CHUNK_OVERLAP_CHARS = 150;
const BATCH_SIZE = 800;
const MAX_BATCH_BYTES = 900_000;
const FILE_META_BATCH_SIZE = 1500;
const EXTRACTION_CONCURRENCY = 12;
const MAX_REMOTE_EXTRACT_CONCURRENCY = 4;
const DIR_WALK_CONCURRENCY = 12;
const META_BATCH_SIZE = 256;
const STREAM_CHUNK_BATCH_SIZE = 160;
const STREAM_FLUSH_INTERVAL_MS = 1200;
const MAX_CHUNKS_PER_FILE = 120;
const BACKEND_MAX_CHUNKS = 12000;

function getEffectiveMaxChunksPerFile(totalFiles: number): number {
  if (totalFiles > 5000) return 4;
  if (totalFiles > 1500) return 8;
  if (totalFiles > 300) return 24;
  return MAX_CHUNKS_PER_FILE;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  "venv",
  ".venv",
  "$recycle.bin",
  "system volume information",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".log",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".rtf",
]);

const MARKUP_EXTENSIONS = new Set([".html", ".htm", ".xml"]);
const OFFICE_ZIP_EXTENSIONS = new Set([".docx", ".xlsx", ".xlsm", ".pptx"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"]);
const SUPPORTED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...MARKUP_EXTENSIONS,
  ...OFFICE_ZIP_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ".pdf",
]);

// Module-level active session state so watcher survives route/tab changes
let activeDirectoryHandle: BrowserDirectoryHandle | null = null;
let sessionFileMap = new Map<string, File>();
let desktopAbsPathMap = new Map<string, string>();
let sessionFolderName = "";
let knownRelativePaths = new Set<string>();
let watcherTimer: number | null = null;
let lastFileSnapshot = new Map<string, number>();
const folderFileSnapshots = new Map<string, Map<string, number>>();
let isSyncInProgress = false;
let isBackgroundIndexing = false;
let syncGeneration = 0;
const folderSyncGenerations = new Map<string, number>();

function getNextFolderSyncGeneration(folderName: string): number {
  const next = (folderSyncGenerations.get(folderName) || 0) + 1;
  folderSyncGenerations.set(folderName, next);
  syncGeneration++;
  return next;
}

function isFolderSyncActive(folderName: string, gen: number): boolean {
  return folderSyncGenerations.get(folderName) === gen;
}
let activeSyncPromise: Promise<BrowserSyncResult | null> | null = null;
let activeBackgroundSyncPromise: Promise<void> | null = null;
const memoryIndexCache = new Map<string, CachedFolderIndex>();
const REAL_PATH_STORAGE_KEY = "nanvi:browser_folder_real_paths";
const DESKTOP_FOLDER_STORAGE_KEY = "nanvi:desktop_local_folder";

let activeFolderScope = "default";
let desktopLocalMeta: DesktopLocalFolderMeta | null = null;
let desktopLocalCacheSnapshot: Record<string, CachedFileEntry> = {};

function getScopedPrimaryKey(): string {
  return activeFolderScope === "default" ? IDB_PRIMARY_KEY : `user:${activeFolderScope}:${IDB_PRIMARY_KEY}`;
}

function getScopedLastFolderKey(): string {
  return activeFolderScope === "default" ? IDB_LAST_FOLDER_KEY : `user:${activeFolderScope}:${IDB_LAST_FOLDER_KEY}`;
}

function getScopedCachePrefix(): string {
  return activeFolderScope === "default" ? "cache:" : `user:${activeFolderScope}:cache:`;
}

function getScopedCacheKey(folderName: string): string {
  return `${getScopedCachePrefix()}${folderName}`;
}

function getScopedRealPathStorageKey(): string {
  return activeFolderScope === "default" ? REAL_PATH_STORAGE_KEY : `${REAL_PATH_STORAGE_KEY}:${activeFolderScope}`;
}

function getScopedDesktopFolderStorageKey(): string {
  return activeFolderScope === "default" ? DESKTOP_FOLDER_STORAGE_KEY : `${DESKTOP_FOLDER_STORAGE_KEY}:${activeFolderScope}`;
}

export function getActiveFolderStorageScope(): string {
  return activeFolderScope;
}

export type ActiveSessionIdentity = {
  userId?: string;
  role?: string;
  roles?: string[];
  department?: string | null;
  tenantId?: string;
};

let activeSessionIdentity: ActiveSessionIdentity | null = null;

export function setActiveSessionIdentity(identity: any): void {
  if (!identity) {
    activeSessionIdentity = null;
    return;
  }
  const rawRoles = Array.isArray(identity.roles)
    ? identity.roles
    : (identity.role ? [identity.role] : []);
  const normalizedRoles = rawRoles.length > 0 ? rawRoles : ["Superior", "CEO"];
  const isPrivileged = normalizedRoles.some((r: string) =>
    ["CEO", "Superior", "Supervisor", "Finance", "Manager", "Admin", "IT Admin"].includes(r)
  );
  activeSessionIdentity = {
    userId: identity.subject || identity.user_id || identity.sub || "desktop-user",
    role: identity.role || (isPrivileged ? "Superior" : normalizedRoles[0]) || "Superior",
    roles: isPrivileged && !normalizedRoles.includes("Superior") ? [...normalizedRoles, "Superior"] : normalizedRoles,
    department: identity.department || null,
    tenantId: identity.tenant_id || "default-tenant",
  };
}

export function getActiveSessionIdentity(): ActiveSessionIdentity | null {
  return activeSessionIdentity;
}

export function setActiveFolderStorageScope(scopeKey: string | null | undefined): void {
  const nextScope = scopeKey && scopeKey.trim() ? scopeKey.trim() : "default";
  if (nextScope === activeFolderScope) return;
  abortBackgroundFolderSync();
  stopBrowserFolderWatcher();
  activeDirectoryHandle = null;
  sessionFileMap.clear();
  desktopAbsPathMap.clear();
  sessionFolderName = "";
  knownRelativePaths.clear();
  lastFileSnapshot.clear();
  folderFileSnapshots.clear();
  folderSyncGenerations.clear();
  memoryIndexCache.clear();
  desktopLocalMeta = null;
  desktopLocalMetaList = [];
  desktopLocalCacheSnapshot = {};
  _desktopAutoRestorePromise = null;
  _lastDesktopRestoreResult = null;
  activeFolderScope = nextScope;
}

let desktopLocalMetaList: DesktopLocalFolderMeta[] = [];

function readStoredDesktopFolderMetaList(): DesktopLocalFolderMeta[] {
  if (desktopLocalMetaList.length > 0) return desktopLocalMetaList;
  if (typeof window === "undefined" || !window.localStorage) {
    return [];
  }
  const parseRaw = (raw: string | null): DesktopLocalFolderMeta[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is DesktopLocalFolderMeta => Boolean(item && item.folderPath && item.folderName));
      } else if (parsed && parsed.folderPath && parsed.folderName) {
        return [parsed as DesktopLocalFolderMeta];
      }
    } catch {}
    return [];
  };

  const key = getScopedDesktopFolderStorageKey();
  let list = parseRaw(window.localStorage.getItem(key));
  if (list.length === 0 && activeFolderScope === "default") {
    list = parseRaw(window.localStorage.getItem("nanvi:desktop_persisted_folder"));
  }
  desktopLocalMetaList = list;
  return list;
}

function readStoredDesktopFolderMeta(): DesktopLocalFolderMeta | null {
  const list = readStoredDesktopFolderMetaList();
  return list.length > 0 ? list[0] : null;
}

function normalizeDesktopFolderPath(p: string): string {
  const trimmed = (p || "").trim();
  if (/^[A-Za-z]:[/\\]*$/.test(trimmed)) {
    return `${trimmed[0].toUpperCase()}:\\`;
  }
  return trimmed.replace(/[/\\]+$/, "");
}

function saveDesktopFolderMeta(meta: DesktopLocalFolderMeta | null, removeFolderId?: string): void {
  const list = readStoredDesktopFolderMetaList();
  let nextList: DesktopLocalFolderMeta[] = [];
  if (removeFolderId) {
    const norm = normalizeDesktopFolderPath(removeFolderId).toLowerCase();
    nextList = list.filter(
      (f) =>
        normalizeDesktopFolderPath(f.folderId).toLowerCase() !== norm &&
        normalizeDesktopFolderPath(f.folderPath).toLowerCase() !== norm,
    );
  } else if (meta) {
    const norm = normalizeDesktopFolderPath(meta.folderId).toLowerCase();
    nextList = list.filter(
      (f) =>
        normalizeDesktopFolderPath(f.folderId).toLowerCase() !== norm &&
        normalizeDesktopFolderPath(f.folderPath).toLowerCase() !== norm,
    );
    nextList.push(meta);
  } else {
    nextList = [];
  }
  desktopLocalMetaList = nextList;
  desktopLocalMeta = nextList.length > 0 ? nextList[0] : null;

  if (typeof window === "undefined" || !window.localStorage) return;
  const key = getScopedDesktopFolderStorageKey();
  try {
    if (nextList.length > 0) {
      const serialized = JSON.stringify(nextList);
      window.localStorage.setItem(key, serialized);
      window.localStorage.setItem("nanvi:desktop_persisted_folder", serialized);
      if (window.electronAPI?.savePersistedDesktopFolder) {
        void window.electronAPI.savePersistedDesktopFolder(nextList[0]);
      }
    } else {
      window.localStorage.removeItem(key);
      window.localStorage.removeItem("nanvi:desktop_persisted_folder");
      if (window.electronAPI?.savePersistedDesktopFolder) {
        void window.electronAPI.savePersistedDesktopFolder(null);
      }
    }
  } catch {
    // ignore quota error
  }
}

export function getDesktopLocalStatus() {
  const folders = readStoredDesktopFolderMetaList();
  if (!folders || folders.length === 0) return null;
  const totalFiles = folders.reduce((sum, f) => sum + (f.fileCount || 0), 0);
  const totalChunks = folders.reduce((sum, f) => sum + (f.chunkCount || 0), 0);
  return {
    is_online: true,
    last_heartbeat: folders[0].lastSyncedAt,
    agent_version: "desktop-local-only",
    connected_folders: folders.map((f) => ({
      folder_id: f.folderId,
      folder_path: f.folderPath,
      display_name: f.folderName,
      file_count: f.fileCount,
      chunk_count: f.chunkCount,
      status: "synced" as const,
      last_synced_at: f.lastSyncedAt,
    })),
    total_files: totalFiles,
    total_chunks: totalChunks,
  };
}

export function connectDesktopFolderDirect(folderPath: string, fileCount = 0): BrowserSyncResult {
  const cleaned = normalizeDesktopFolderPath(folderPath);
  const folderName = /^[A-Za-z]:\\$/.test(cleaned)
    ? cleaned
    : (cleaned.split(/[/\\]/).pop() || cleaned || "Local Folder");
  sessionFolderName = folderName;
  setBrowserFolderRealPath(folderName, cleaned);

  saveDesktopFolderMeta({
    folderId: cleaned,
    folderPath: cleaned,
    folderName,
    fileCount,
    chunkCount: 0,
    lastSyncedAt: new Date().toISOString(),
  });

  const status = getDesktopLocalStatus();
  const folderCount = status?.connected_folders?.length || 1;
  const totalFiles = status?.total_files || fileCount;

  window.dispatchEvent(
    new CustomEvent("nanvi:company-folder-updated", {
      detail: {
        path: cleaned,
        exists: true,
        folder_count: folderCount,
        file_count: totalFiles,
      },
    }),
  );

  return {
    folderName,
    folderId: cleaned,
    fileCount,
    chunkCount: 0,
  };
}

export function updateDesktopFolderFileCount(folderPath: string, fileCount: number): void {
  if (!folderPath || !Number.isFinite(fileCount)) return;
  const norm = normalizeDesktopFolderPath(folderPath);
  const folders = readStoredDesktopFolderMetaList();
  const target = folders.find(
    (f) => normalizeDesktopFolderPath(f.folderPath).toLowerCase() === norm.toLowerCase(),
  );
  if (!target || target.fileCount === fileCount) return;

  saveDesktopFolderMeta({
    ...target,
    folderPath: norm,
    fileCount,
    lastSyncedAt: new Date().toISOString(),
  });

  const status = getDesktopLocalStatus();
  const folderCount = status?.connected_folders?.length || 1;
  const totalFiles = status?.total_files || fileCount;
  window.dispatchEvent(
    new CustomEvent("nanvi:company-folder-updated", {
      detail: {
        path: norm,
        exists: true,
        folder_count: folderCount,
        file_count: totalFiles,
      },
    }),
  );
}

export async function clearDesktopLocalFolder(folderId?: string): Promise<void> {
  if (folderId) {
    saveDesktopFolderMeta(null, folderId);
    if (typeof window !== "undefined") {
      const revoker = (window.electronAPI as (typeof window.electronAPI & { revokeApprovedFolder?: (p?: string) => Promise<unknown> }) | undefined)
        ?.revokeApprovedFolder;
      if (revoker) {
        try {
          await revoker(folderId);
        } catch {
          // ignore IPC revoke error
        }
      }
    }
  } else {
    const prevPath = readStoredDesktopFolderMeta()?.folderPath;
    desktopLocalCacheSnapshot = {};
    saveDesktopFolderMeta(null);
    if (typeof window !== "undefined") {
      const revoker = (window.electronAPI as (typeof window.electronAPI & { revokeApprovedFolder?: (p?: string) => Promise<unknown> }) | undefined)
        ?.revokeApprovedFolder;
      if (revoker) {
        try {
          await revoker(prevPath);
        } catch {
          // ignore IPC revoke error
        }
      }
    }
    await clearSavedBrowserDirectoryHandle();
  }
}

const desktopSearchCursorByConv = new Map<string, { query: string; offset: number; pageSize: number }>();

function isConversationalSkip(query: string): boolean {
  const cleaned = String(query || "").trim().toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");
  if (!cleaned) return true;
  return [
    "hi", "hello", "hey", "hola", "namaste", "thanks", "thank you", "thx", "ok", "okay",
    "good morning", "good afternoon", "good evening", "bye", "goodbye", "who are you",
    "what can you do", "how are you",
  ].includes(cleaned);
}

function isPaginationFollowupQuery(query: string): boolean {
  const cleaned = String(query || "").trim().toLowerCase().replace(/[?!.,\s]+$/g, "");
  if (!cleaned) return false;
  return (
    /^(?:show\s+more|i\s+need\s+more|need\s+more|more\s+(?:files|results|invoices|customers|employees|contracts|records|items|please)?|next\s*(?:set|batch|page|10|ten|files|results)?|another\s+set|show\s+another(?:\s+set)?|give\s+(?:me\s+)?more|load\s+more|keep\s+going|continue|what\s+else)$/.test(cleaned) ||
    /(?:i need more|need more files|another set of|show another set|show next 10|next 10 files)/.test(cleaned)
  );
}

function getQueryTopicBucket(query: string): string {
  const q = String(query || "").toLowerCase();
  if (/\b(?:invoice|invoic|bill|payment|overdue|paid|unpaid)\b/.test(q)) return "invoice";
  if (/\b(?:contract|agreement|nda|msa|pur|renewal)\b/.test(q)) return "contract";
  if (/\b(?:employee|employees|hr|salary|salaries|staff|lpa)\b/.test(q)) return "hr";
  if (/\b(?:sheet|excel|csv|xlsx|financial|budget)\b/.test(q)) return "spreadsheet";
  return "";
}

function isAnotherSuggestionFollowup(query: string, prevQuery: string): boolean {
  const cleaned = String(query || "").trim().toLowerCase();
  if (!/^(?:can i find (?:an)?other|find (?:more|other))\b/.test(cleaned)) return false;
  const curTopic = getQueryTopicBucket(cleaned);
  const prevTopic = getQueryTopicBucket(prevQuery);
  return Boolean(curTopic && prevTopic && curTopic === prevTopic);
}

export async function queryDesktopLocalContext(
  query: string,
  topChunksLimit = 8,
  topFilesLimit = 10,
  conversationId = "__default__",
): Promise<DesktopLocalQueryContext | null> {
  if (isEmailQuery(query) || isConversationalSkip(query)) {
    return null;
  }
  const meta = readStoredDesktopFolderMeta();
  if (!meta) return null;

  const cursorKey = conversationId || "__default__";
  const prevCursor = desktopSearchCursorByConv.get(cursorKey);
  const isPag = isPaginationFollowupQuery(query) || Boolean(prevCursor && isAnotherSuggestionFollowup(query, prevCursor.query));
  const activeUser = getActiveSessionIdentity();
  const userOpts = activeUser ? {
    userId: activeUser.userId,
    role: activeUser.role,
    roles: activeUser.roles,
    department: activeUser.department,
    tenantId: activeUser.tenantId,
  } : {
    userId: "desktop-user",
    role: "Superior",
    roles: ["Superior", "CEO"],
    tenantId: "default-tenant",
  };

  if (typeof window !== "undefined" && window.electronAPI?.searchDesktopFolder) {
    try {
      if (isPag && prevCursor) {
        const nextOffset = prevCursor.offset + topFilesLimit;
        const pageHit = await window.electronAPI.searchDesktopFolder(
          meta.folderPath,
          prevCursor.query,
          topChunksLimit,
          topFilesLimit,
          { offset: nextOffset, ...userOpts },
        );
        if (pageHit && ((pageHit.files && pageHit.files.length > 0) || (pageHit as { structured_summary?: string }).structured_summary)) {
          desktopSearchCursorByConv.set(cursorKey, {
            query: prevCursor.query,
            offset: nextOffset,
            pageSize: topFilesLimit,
          });
          return pageHit;
        }
      }

      const liveHit = await window.electronAPI.searchDesktopFolder(
        meta.folderPath,
        query,
        topChunksLimit,
        topFilesLimit,
        userOpts,
      );
      if (liveHit && (liveHit.chunks.length > 0 || liveHit.files.length > 0 || (liveHit as { zero_match?: boolean }).zero_match || (liveHit as { structured_summary?: string }).structured_summary)) {
        if ((liveHit as { total_matches?: number }).total_matches && (liveHit as { total_matches?: number }).total_matches! > 0) {
          desktopSearchCursorByConv.set(cursorKey, {
            query,
            offset: 0,
            pageSize: topFilesLimit,
          });
        }
        return liveHit;
      }
    } catch {
      // fall through to cached index lookup if present
    }
  }

  let entriesMap = desktopLocalCacheSnapshot;
  if (Object.keys(entriesMap).length === 0) {
    const cached = await getCachedFolderIndex(meta.folderName);
    if (cached?.entries) {
      entriesMap = cached.entries;
      desktopLocalCacheSnapshot = cached.entries;
    }
  }
  const allEntries = Object.values(entriesMap);
  if (allEntries.length === 0) return null;

  const qClean = String(query || "").trim().toLowerCase();
  const qSpaced = qClean.replace(/[_-]+/g, " ");
  const rawTerms = (qSpaced.match(/\w+/g) || []).filter((t) => t.length > 1);
  const stopWords = new Set([
    "what", "is", "are", "in", "the", "my", "our", "folder", "folders",
    "file", "files", "document", "documents", "tell", "me", "about",
    "can", "you", "summarize", "summary", "explain", "describe", "show",
    "give", "please", "contents", "inside", "do", "we", "have", "there",
    "any", "this", "that", "these", "those", "from", "with", "and", "for",
    "find", "locate", "search", "look",
    "contain", "contains", "containing", "content", "which", "whose", "who",
    "having", "has", "had", "named", "name", "called", "titled",
    "related", "regarding", "bring", "fetch", "records", "record", "item", "items",
  ]);
  const contentTerms = rawTerms.filter((t) => !stopWords.has(t));
  const queryTerms = contentTerms.length > 0 ? contentTerms : rawTerms;
  const cleanPhrase = queryTerms.join(" ");
  const codeTokens = (qClean.match(/[a-z0-9]+(?:[-_][a-z0-9]+)+/g) || []).filter(
    (ct) => /[a-z]/.test(ct) && /\d/.test(ct),
  );

  const toWindowsAbsPath = (relPath: string): string => {
    const knownAbs = desktopAbsPathMap.get(relPath);
    if (knownAbs) return knownAbs;
    const base = meta.folderPath.replace(/[\\/]+$/, "");
    const sep = base.includes("/") && !base.includes("\\") ? "/" : "\\";
    return `${base}${sep}${relPath.replace(/[/\\]+/g, sep).replace(/^[/\\]+/, "")}`;
  };

  type ScoredChunk = {
    score: number;
    entry: CachedFileEntry;
    chunk: BrowserChunkRecord;
  };
  type ScoredFile = {
    score: number;
    entry: CachedFileEntry;
    snippet: string;
  };

  const highCovChunks: ScoredChunk[] = [];
  const partialChunks: ScoredChunk[] = [];
  const highCovFiles: ScoredFile[] = [];
  const partialFiles: ScoredFile[] = [];

  if (contentTerms.length === 0) {
    // General overview query ("what files are in my folder?" / "summarize my folder")
    for (const entry of allEntries.slice(0, Math.max(topChunksLimit, topFilesLimit))) {
      if (entry.chunks[0]) {
        highCovChunks.push({ score: 100, entry, chunk: entry.chunks[0] });
      }
      highCovFiles.push({
        score: 100,
        entry,
        snippet: entry.chunks[0]?.text?.slice(0, 220) || "",
      });
    }
  } else {
    for (const entry of allEntries) {
      const relLower = entry.fileRecord.relative_path.toLowerCase();
      const fnLower = entry.fileRecord.filename.toLowerCase();
      const fnStem = fnLower.includes(".") ? fnLower.slice(0, fnLower.lastIndexOf(".")) : fnLower;
      const fnSpaced = fnStem.replace(/[_-]+/g, " ");
      const relSpaced = relLower.replace(/[_-]+/g, " ");

      // Also score file entry overall against metadata + best chunk
      let fileBestScore = 0;
      let fileBestExact = false;
      let fileBestCov = 0;
      let fileSnippet = entry.chunks[0]?.text?.slice(0, 220) || "";

      const scoreTextTarget = (textLower: string) => {
        const textSpaced = textLower.replace(/[_-]+/g, " ");
        let score = 0;
        const matched = new Set<string>();
        let exactHit = false;

        for (const ct of codeTokens) {
          const ctSpaced = ct.replace(/[_-]+/g, " ");
          if (textLower.includes(ct) || textSpaced.includes(ctSpaced)) {
            score += 600;
            exactHit = true;
            for (const qt of queryTerms) matched.add(qt);
          }
          if (relLower.includes(ct) || relSpaced.includes(ctSpaced)) {
            score += 750;
            exactHit = true;
            for (const qt of queryTerms) matched.add(qt);
          }
          if (fnLower.includes(ct) || fnSpaced.includes(ctSpaced)) {
            score += 800;
            exactHit = true;
            for (const qt of queryTerms) matched.add(qt);
          }
        }

        const isStemExact =
          fnSpaced.length >= 3 &&
          (new RegExp(`\\b${fnSpaced.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(qSpaced) ||
            (cleanPhrase && fnSpaced === cleanPhrase));
        if (isStemExact) {
          score += 400;
          exactHit = true;
          for (const qt of queryTerms) matched.add(qt);
        }

        if (queryTerms.length > 1 && cleanPhrase) {
          if (textLower.includes(cleanPhrase) || textSpaced.includes(cleanPhrase)) {
            score += 250;
            exactHit = true;
            for (const qt of queryTerms) matched.add(qt);
          }
          if (relLower.includes(cleanPhrase) || relSpaced.includes(cleanPhrase)) {
            score += 350;
            exactHit = true;
            for (const qt of queryTerms) matched.add(qt);
          }
        }

        for (const term of queryTerms) {
          const cText = textLower.split(term).length - 1 || textSpaced.split(term).length - 1;
          const cPath = relLower.split(term).length - 1 || relSpaced.split(term).length - 1;
          const cFn = fnLower.split(term).length - 1 || fnSpaced.split(term).length - 1;
          if (cText > 0 || cPath > 0 || cFn > 0) {
            matched.add(term);
            score += Math.min(cText, 10) * 1.5 + Math.min(cPath, 5) * 10 + Math.min(cFn, 3) * 25;
          }
        }

        if (codeTokens.length > 0 && !exactHit) {
          const hasAlphaTerm = Array.from(matched).some((t) => /[a-z]/.test(t));
          if (!hasAlphaTerm) return null;
        }

        if (matched.size === 0) return null;
        const coverage = matched.size / queryTerms.length;
        return { finalScore: score * (1 + coverage), exactHit, coverage };
      };

      const targetChunks =
        entry.chunks.length > 0
          ? entry.chunks
          : [
              {
                chunk_id: `meta-${entry.fileRecord.relative_path}`,
                relative_path: entry.fileRecord.relative_path,
                filename: entry.fileRecord.filename,
                folder_name: meta.folderName,
                chunk_index: 0,
                text: `File: ${entry.fileRecord.filename} Path: ${entry.fileRecord.relative_path}`,
                char_count: 0,
              } as BrowserChunkRecord,
            ];

      for (const ch of targetChunks) {
        const res = scoreTextTarget((ch.text || "").toLowerCase());
        if (!res) continue;
        const isMetaStub = ch.chunk_id.startsWith("meta-");
        const rankScore = res.finalScore + (isMetaStub ? 0 : 25);
        if (!isMetaStub) {
          const rec: ScoredChunk = { score: rankScore, entry, chunk: ch };
          if (res.exactHit || res.coverage >= 1) {
            highCovChunks.push(rec);
          } else {
            partialChunks.push(rec);
          }
        }
        if (rankScore > fileBestScore) {
          fileBestScore = rankScore;
          fileBestExact = res.exactHit;
          fileBestCov = res.coverage;
          if (!isMetaStub) fileSnippet = ch.text.slice(0, 220);
        }
      }

      if (fileBestScore > 0) {
        const fRec: ScoredFile = { score: fileBestScore, entry, snippet: fileSnippet };
        if (fileBestExact || fileBestCov >= 1) {
          highCovFiles.push(fRec);
        } else {
          partialFiles.push(fRec);
        }
      }
    }
  }

  const seenChunkKeys = new Set<string>();
  const chosenChunks = [...highCovChunks, ...partialChunks]
    .sort((a, b) => b.score - a.score)
    .filter((c) => {
      const k = c.chunk.chunk_id;
      if (seenChunkKeys.has(k)) return false;
      seenChunkKeys.add(k);
      return true;
    })
    .slice(0, topChunksLimit);

  const seenFileKeys = new Set<string>();
  const chosenFiles = [...highCovFiles, ...partialFiles]
    .sort((a, b) => b.score - a.score)
    .filter((f) => {
      const k = f.entry.fileRecord.relative_path.toLowerCase();
      if (seenFileKeys.has(k)) return false;
      seenFileKeys.add(k);
      return true;
    })
    .slice(0, topFilesLimit);

  return {
    folder_path: meta.folderPath,
    files: chosenFiles.map(({ entry, snippet }) => {
      const absPath = toWindowsAbsPath(entry.fileRecord.relative_path);
      return {
        name: entry.fileRecord.filename,
        path: absPath,
        full_path: absPath,
        display_path: absPath,
        type: entry.fileRecord.file_type || "file",
        open_url: absPath,
        source: "local",
        content_snippet: snippet,
      };
    }),
    chunks: chosenChunks.map(({ entry, chunk }) => {
      const absPath = toWindowsAbsPath(chunk.relative_path);
      return {
        chunk_id: chunk.chunk_id,
        folder_path: meta.folderPath,
        relative_path: chunk.relative_path,
        filename: chunk.filename,
        citation: absPath,
        text: chunk.text,
      };
    }),
  };
}

export function abortBackgroundFolderSync(folderName?: string): void {
  if (folderName) {
    folderSyncGenerations.set(folderName, (folderSyncGenerations.get(folderName) || 0) + 1);
  } else {
    syncGeneration++;
    for (const k of Array.from(folderSyncGenerations.keys())) {
      folderSyncGenerations.set(k, (folderSyncGenerations.get(k) || 0) + 1);
    }
  }
  isBackgroundIndexing = false;
}

export async function waitForBackgroundFolderSync(): Promise<void> {
  if (activeBackgroundSyncPromise) {
    await activeBackgroundSyncPromise;
  }
}

function readStoredRealPathsMap(): Record<string, string> {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(getScopedRealPathStorageKey());
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function getBrowserFolderRealPath(folderName: string): string {
  const clean = folderName.trim();
  if (!clean) return "";
  const map = readStoredRealPathsMap();
  return map[clean] || "";
}

export function setBrowserFolderRealPath(folderName: string, realPath: string): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  const cleanName = folderName.trim();
  if (!cleanName) return;
  const cleanPath = realPath.trim().replace(/^['"]|['"]$/g, "");
  const map = readStoredRealPathsMap();
  if (cleanPath) {
    map[cleanName] = cleanPath;
  } else {
    delete map[cleanName];
  }
  try {
    window.localStorage.setItem(getScopedRealPathStorageKey(), JSON.stringify(map));
  } catch {
    // ignore storage quota errors
  }
}

export function resolveEffectiveFolderPath(folderName: string): string {
  const custom = getBrowserFolderRealPath(folderName);
  return custom || folderName;
}

async function runExclusiveSync(task: () => Promise<BrowserSyncResult | null>): Promise<BrowserSyncResult | null> {
  if (activeSyncPromise) {
    return await activeSyncPromise;
  }
  isSyncInProgress = true;
  const run = (async () => {
    try {
      return await task();
    } finally {
      isSyncInProgress = false;
      activeSyncPromise = null;
    }
  })();
  activeSyncPromise = run;
  return await run;
}

function splitChunkBatches(chunks: BrowserChunkRecord[]): BrowserChunkRecord[][] {
  const batches: BrowserChunkRecord[][] = [];
  let current: BrowserChunkRecord[] = [];
  let currentBytes = 0;

  for (const chunk of chunks) {
    const estBytes = (chunk.text?.length || 0) + (chunk.relative_path?.length || 0) + 256;
    if (current.length > 0 && (current.length >= BATCH_SIZE || currentBytes + estBytes > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(chunk);
    currentBytes += estBytes;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
  );
}

export function isDirectoryInputSupported(): boolean {
  if (typeof document === "undefined") return false;
  const input = document.createElement("input");
  return "webkitdirectory" in input;
}

export function getBrowserFolderMode(): "fs-access" | "webkitdirectory" | "file-picker" | "unsupported" {
  if (isFileSystemAccessSupported()) return "fs-access";
  if (isDirectoryInputSupported()) return "webkitdirectory";
  if (typeof document !== "undefined") return "file-picker";
  return "unsupported";
}

// ---------------------------------------------------------------------------
// IndexedDB Persistence for FileSystemDirectoryHandle & Extracted Chunk Cache
// ---------------------------------------------------------------------------

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
      if (!db.objectStoreNames.contains(IDB_CACHE_STORE)) {
        db.createObjectStore(IDB_CACHE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB"));
  });
}

async function getCachedFolderIndex(folderName: string): Promise<CachedFolderIndex | null> {
  const key = getScopedCacheKey(folderName);
  const mem = memoryIndexCache.get(key);
  if (mem) return mem;
  try {
    const db = await openHandleDb();
    const cached = await new Promise<CachedFolderIndex | null>((resolve, reject) => {
      const tx = db.transaction(IDB_CACHE_STORE, "readonly");
      const req = tx.objectStore(IDB_CACHE_STORE).get(key);
      req.onsuccess = () => resolve((req.result as CachedFolderIndex) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (cached && cached.entries) {
      memoryIndexCache.set(key, cached);
      return cached;
    }
    return null;
  } catch {
    return null;
  }
}

function getScopedCachedFolderNamesKey(): string {
  return activeFolderScope === "default" ? "__cached_folder_names__" : `user:${activeFolderScope}:__cached_folder_names__`;
}

const cachedFolderNamesMemory = new Set<string>();

export async function getAllCachedFolderNames(): Promise<string[]> {
  const names = new Set<string>(cachedFolderNamesMemory);
  const cachePrefix = getScopedCachePrefix();
  const cachedNamesKey = getScopedCachedFolderNamesKey();

  for (const k of memoryIndexCache.keys()) {
    if (k.startsWith(cachePrefix)) {
      const fn = k.slice(cachePrefix.length);
      if (fn && !fn.startsWith("__")) {
        names.add(fn);
        cachedFolderNamesMemory.add(fn);
      }
    }
  }

  try {
    const db = await openHandleDb();
    const stored = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(IDB_CACHE_STORE, "readonly");
      const req = tx.objectStore(IDB_CACHE_STORE).get(cachedNamesKey);
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    for (const n of stored) {
      if (n && typeof n === "string") {
        names.add(n);
        cachedFolderNamesMemory.add(n);
      }
    }
  } catch {
    // Keep memory cache fallback
  }

  const lastName = await getLastCachedFolderName();
  if (lastName) {
    names.add(lastName);
    cachedFolderNamesMemory.add(lastName);
  }

  return Array.from(names);
}

function getCurrentTotalBrowserFolderCount(): number {
  return Math.max(1, watcherHandlesMap.size, savedBrowserHandlesMap.size, cachedFolderNamesMemory.size);
}

async function saveCachedFolderIndex(cache: CachedFolderIndex): Promise<void> {
  const key = getScopedCacheKey(cache.folderName);
  const lastFolderKey = getScopedLastFolderKey();
  const cachedNamesKey = getScopedCachedFolderNamesKey();
  memoryIndexCache.set(key, cache);
  cachedFolderNamesMemory.add(cache.folderName);
  sessionFolderName = cache.folderName;
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_CACHE_STORE, "readwrite");
      const store = tx.objectStore(IDB_CACHE_STORE);
      store.put(cache, key);
      store.put(cache.folderName, lastFolderKey);

      const namesReq = store.get(cachedNamesKey);
      namesReq.onsuccess = () => {
        const existing = Array.isArray(namesReq.result) ? namesReq.result : [];
        if (!existing.includes(cache.folderName)) {
          existing.push(cache.folderName);
          store.put(existing, cachedNamesKey);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Failed to save cache"));
    });
    db.close();
  } catch {
    // Keep memory cache even if IndexedDB write fails
  }
}

export async function getLastCachedFolderName(): Promise<string | null> {
  if (sessionFolderName) return sessionFolderName;
  const lastFolderKey = getScopedLastFolderKey();
  const cachePrefix = getScopedCachePrefix();
  try {
    const db = await openHandleDb();
    const name = await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(IDB_CACHE_STORE, "readonly");
      const req = tx.objectStore(IDB_CACHE_STORE).get(lastFolderKey);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (name) sessionFolderName = name;
    return name;
  } catch {
    for (const key of memoryIndexCache.keys()) {
      if (key.startsWith(cachePrefix)) return key.slice(cachePrefix.length);
    }
    return null;
  }
}

export async function getCachedBrowserIndexSummary(
  folderName: string,
): Promise<{ fileCount: number; chunkCount: number; updatedAt: number } | null> {
  const cached = await getCachedFolderIndex(folderName);
  if (!cached) return null;
  const entries = Object.values(cached.entries || {});
  const fileCount = entries.length;
  const chunkCount = entries.reduce((sum, e) => sum + (e.chunks?.length || 0), 0);
  if (fileCount === 0) return null;
  return { fileCount, chunkCount, updatedAt: cached.updatedAt };
}

const savedBrowserHandlesMap = new Map<string, BrowserDirectoryHandle>();

function getScopedHandleNamesKey(): string {
  return activeFolderScope === "default" ? "__saved_handle_names__" : `user:${activeFolderScope}:__saved_handle_names__`;
}

function getScopedFolderHandleKey(folderName: string): string {
  return activeFolderScope === "default" ? `handle:${folderName}` : `user:${activeFolderScope}:handle:${folderName}`;
}

export async function saveBrowserDirectoryHandle(handle: BrowserDirectoryHandle): Promise<void> {
  activeDirectoryHandle = handle;
  if (handle.name) {
    savedBrowserHandlesMap.set(handle.name, handle);
  }
  const primaryKey = getScopedPrimaryKey();
  const folderKey = handle.name ? getScopedFolderHandleKey(handle.name) : primaryKey;
  const namesKey = getScopedHandleNamesKey();
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      store.put(handle, primaryKey);
      if (handle.name) {
        store.put(handle, folderKey);
        const namesReq = store.get(namesKey);
        namesReq.onsuccess = () => {
          const names = Array.isArray(namesReq.result) ? namesReq.result : [];
          if (!names.includes(handle.name)) {
            names.push(handle.name);
            store.put(names, namesKey);
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Failed to save handle"));
    });
    db.close();
  } catch {
    // Keep memory reference even if IndexedDB is blocked in private browsing
  }
}

export async function getSavedBrowserDirectoryHandle(folderName?: string): Promise<BrowserDirectoryHandle | null> {
  if (folderName && savedBrowserHandlesMap.has(folderName)) {
    return savedBrowserHandlesMap.get(folderName) || null;
  }
  if (!folderName && activeDirectoryHandle) return activeDirectoryHandle;
  const primaryKey = folderName ? getScopedFolderHandleKey(folderName) : getScopedPrimaryKey();
  try {
    const db = await openHandleDb();
    const handle = await new Promise<BrowserDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(primaryKey);
      req.onsuccess = () => resolve((req.result as BrowserDirectoryHandle) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (handle) {
      if (!activeDirectoryHandle) activeDirectoryHandle = handle;
      if (handle.name) savedBrowserHandlesMap.set(handle.name, handle);
    }
    return handle;
  } catch {
    return null;
  }
}

export async function getAllSavedBrowserHandles(): Promise<Array<{ name: string; handle: BrowserDirectoryHandle }>> {
  const namesKey = getScopedHandleNamesKey();
  const results: Array<{ name: string; handle: BrowserDirectoryHandle }> = [];
  try {
    const db = await openHandleDb();
    const names = await new Promise<string[]>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(namesKey);
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
    for (const name of names) {
      if (savedBrowserHandlesMap.has(name)) {
        results.push({ name, handle: savedBrowserHandlesMap.get(name)! });
        continue;
      }
      const handle = await new Promise<BrowserDirectoryHandle | null>((resolve) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(getScopedFolderHandleKey(name));
        req.onsuccess = () => resolve((req.result as BrowserDirectoryHandle) || null);
        req.onerror = () => resolve(null);
      });
      if (handle) {
        savedBrowserHandlesMap.set(name, handle);
        results.push({ name, handle });
      }
    }
    if (results.length === 0) {
      const primary = await getSavedBrowserDirectoryHandle();
      if (primary && primary.name) {
        results.push({ name: primary.name, handle: primary });
      }
    }
    db.close();
  } catch {}
  if (results.length === 0 && savedBrowserHandlesMap.size > 0) {
    for (const [name, handle] of Array.from(savedBrowserHandlesMap.entries())) {
      results.push({ name, handle });
    }
  }
  return results;
}

export async function clearSavedBrowserDirectoryHandle(folderName?: string): Promise<void> {
  if (folderName) {
    savedBrowserHandlesMap.delete(folderName);
    cachedFolderNamesMemory.delete(folderName);
    folderFileSnapshots.delete(folderName);
    folderSyncGenerations.delete(folderName);
    if (activeDirectoryHandle?.name === folderName) {
      activeDirectoryHandle = savedBrowserHandlesMap.values().next().value || null;
    }
    if (sessionFolderName === folderName) {
      sessionFolderName = activeDirectoryHandle?.name || "";
    }
    const folderKey = getScopedFolderHandleKey(folderName);
    const namesKey = getScopedHandleNamesKey();
    const cacheKey = getScopedCacheKey(folderName);
    const cachedNamesKey = getScopedCachedFolderNamesKey();
    memoryIndexCache.delete(cacheKey);

    // Clean up sessionFileMap for this folder
    const prefix = `${folderName}/`.toLowerCase();
    const backslashPrefix = `${folderName}\\`.toLowerCase();
    for (const [k] of Array.from(sessionFileMap.entries())) {
      const lower = k.toLowerCase();
      if (lower.startsWith(prefix) || lower.startsWith(backslashPrefix) || lower === folderName.toLowerCase()) {
        sessionFileMap.delete(k);
      }
    }

    try {
      const db = await openHandleDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([IDB_STORE, IDB_CACHE_STORE], "readwrite");
        const hStore = tx.objectStore(IDB_STORE);
        hStore.delete(folderKey);
        const namesReq = hStore.get(namesKey);
        namesReq.onsuccess = () => {
          const names = Array.isArray(namesReq.result) ? namesReq.result : [];
          const updated = names.filter((n: string) => n !== folderName);
          hStore.put(updated, namesKey);
          if (updated.length === 0) {
            hStore.delete(getScopedPrimaryKey());
          }
        };

        const cStore = tx.objectStore(IDB_CACHE_STORE);
        cStore.delete(cacheKey);
        const cNamesReq = cStore.get(cachedNamesKey);
        cNamesReq.onsuccess = () => {
          const cNames = Array.isArray(cNamesReq.result) ? cNamesReq.result : [];
          const updated = cNames.filter((n: string) => n !== folderName);
          cStore.put(updated, cachedNamesKey);
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {}
    if (savedBrowserHandlesMap.size === 0) {
      abortBackgroundFolderSync();
      stopBrowserFolderWatcher(folderName);
    }
    return;
  }

  abortBackgroundFolderSync();
  stopBrowserFolderWatcher();
  savedBrowserHandlesMap.clear();
  cachedFolderNamesMemory.clear();
  activeDirectoryHandle = null;
  sessionFolderName = "";
  sessionFileMap.clear();
  desktopAbsPathMap.clear();
  knownRelativePaths.clear();
  lastFileSnapshot.clear();
  folderFileSnapshots.clear();
  folderSyncGenerations.clear();
  memoryIndexCache.clear();
  const primaryKey = getScopedPrimaryKey();
  const namesKey = getScopedHandleNamesKey();
  const lastFolderKey = getScopedLastFolderKey();
  const cachedNamesKey = getScopedCachedFolderNamesKey();
  const cachePrefix = getScopedCachePrefix();
  const isDefaultScope = activeFolderScope === "default";
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([IDB_STORE, IDB_CACHE_STORE], "readwrite");
      const hStore = tx.objectStore(IDB_STORE);
      hStore.delete(primaryKey);
      hStore.delete(namesKey);
      const cacheStore = tx.objectStore(IDB_CACHE_STORE);
      cacheStore.delete(cachedNamesKey);
      if (isDefaultScope && typeof cacheStore.getAllKeys !== "function") {
        cacheStore.clear();
      } else {
        cacheStore.delete(lastFolderKey);
        if (typeof cacheStore.getAllKeys === "function") {
          const keysReq = cacheStore.getAllKeys();
          keysReq.onsuccess = () => {
            const keys = (keysReq.result || []) as IDBValidKey[];
            for (const k of keys) {
              if (typeof k === "string" && k.startsWith(cachePrefix)) {
                cacheStore.delete(k);
              }
            }
          };
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore storage errors on disconnect
  }
}

export async function verifyDirectoryPermission(
  handle: BrowserDirectoryHandle,
  askUser: boolean,
): Promise<boolean> {
  try {
    if (typeof handle.queryPermission !== "function") return true;
    const state = await handle.queryPermission({ mode: "read" });
    if (state === "granted") return true;
    if (!askUser || typeof handle.requestPermission !== "function") return false;
    return (await handle.requestPermission({ mode: "read" })) === "granted";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Native ZIP / OOXML + Text Extraction (Zero external npm dependencies)
// ---------------------------------------------------------------------------

function getExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

async function decompressRaw(bytes: Uint8Array, format: "deflate-raw" | "deflate"): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream unavailable");
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream(format));
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

export async function readZipEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const entries = new Map<string, Uint8Array>();
  if (bytes.length < 22) return entries;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: false });

  // Locate End of Central Directory (0x06054b50)
  const minPos = Math.max(0, bytes.length - 65557);
  let eocdPos = -1;
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) return entries;

  const totalEntries = view.getUint16(eocdPos + 10, true);
  let offset = view.getUint32(eocdPos + 16, true);

  for (let idx = 0; idx < totalEntries && offset + 46 <= bytes.length; idx++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;

    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/") || localHeaderOffset + 30 > bytes.length) continue;
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) continue;

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > bytes.length) continue;

    const compressed = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      entries.set(name, compressed);
    } else if (method === 8) {
      try {
        entries.set(name, await decompressRaw(compressed, "deflate-raw"));
      } catch {
        // skip unreadable compressed entry
      }
    }
  }

  return entries;
}

function stripXmlTags(xml: string): string {
  return xml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6]|si)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseXmlDom(xml: string): Document | null {
  if (typeof DOMParser === "undefined") return null;
  try {
    return new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    return null;
  }
}

export async function extractOfficeTextFromBytes(ext: string, bytes: Uint8Array): Promise<string> {
  const entries = await readZipEntries(bytes);
  const lowerEntries = new Map<string, Uint8Array>();
  for (const [k, v] of entries.entries()) {
    lowerEntries.set(k.toLowerCase(), v);
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });

  if (ext === ".docx") {
    const raw = lowerEntries.get("word/document.xml");
    if (!raw) return "";
    const xml = decoder.decode(raw);
    const doc = parseXmlDom(xml);
    if (!doc) return stripXmlTags(xml);
    const paragraphs = Array.from(doc.getElementsByTagName("*"))
      .filter((el) => el.localName === "p")
      .map((p) => (p.textContent || "").trim())
      .filter(Boolean);
    return paragraphs.length > 0 ? paragraphs.join("\n") : stripXmlTags(xml);
  }

  if (ext === ".xlsx" || ext === ".xlsm") {
    const sharedStrings: string[] = [];
    const ssRaw = lowerEntries.get("xl/sharedstrings.xml");
    if (ssRaw) {
      const ssXml = decoder.decode(ssRaw);
      const ssDoc = parseXmlDom(ssXml);
      if (ssDoc) {
        const siNodes = Array.from(ssDoc.getElementsByTagName("*")).filter((el) => el.localName === "si");
        for (const si of siNodes) {
          sharedStrings.push((si.textContent || "").trim());
        }
      }
    }

    const sheetNames = Array.from(entries.keys())
      .filter((n) => /^xl\/worksheets\/sheet.*\.xml$/i.test(n))
      .sort();

    const lines: string[] = [];
    for (const sName of sheetNames.slice(0, 20)) {
      const shortName = sName.split("/").pop()?.replace(/\.xml$/i, "") || sName;
      lines.push(`--- Sheet: ${shortName} ---`);
      const sRaw = entries.get(sName);
      if (!sRaw) continue;
      const sXml = decoder.decode(sRaw);
      const sDoc = parseXmlDom(sXml);
      if (!sDoc) {
        lines.push(stripXmlTags(sXml));
        continue;
      }
      const rows = Array.from(sDoc.getElementsByTagName("*")).filter((el) => el.localName === "row");
      for (const row of rows.slice(0, 1000)) {
        const vals: string[] = [];
        const cells = Array.from(row.children).filter((el) => el.localName === "c");
        for (const c of cells) {
          const cType = c.getAttribute("t") || "";
          const vNode = Array.from(c.children).find((el) => el.localName === "v");
          const isNode = Array.from(c.children).find((el) => el.localName === "is");
          const rawVal = (vNode?.textContent ?? isNode?.textContent ?? "").trim();
          if (!rawVal) continue;
          if (cType === "s") {
            const idx = Number.parseInt(rawVal, 10);
            vals.push(Number.isFinite(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : rawVal);
          } else {
            vals.push(rawVal);
          }
        }
        if (vals.length > 0) lines.push(vals.join(" | "));
      }
    }
    return lines.join("\n").trim();
  }

  if (ext === ".pptx") {
    const slides = Array.from(entries.keys())
      .filter((n) => /^ppt\/slides\/slide(\d+)\.xml$/i.test(n))
      .sort((a, b) => {
        const numA = Number.parseInt((a.match(/slide(\d+)\.xml/i) || [])[1] || "0", 10);
        const numB = Number.parseInt((b.match(/slide(\d+)\.xml/i) || [])[1] || "0", 10);
        return numA - numB;
      });
    const out: string[] = [];
    for (let idx = 0; idx < slides.length; idx++) {
      const slideName = slides[idx];
      const sRaw = entries.get(slideName);
      if (sRaw) {
        const txt = stripXmlTags(decoder.decode(sRaw));
        if (txt.trim()) {
          out.push(`--- Slide ${idx + 1} ---\n${txt.trim()}`);
        }
      }
    }
    return out.filter(Boolean).join("\n\n");
  }

  return "";
}

async function extractPdfTextSimple(bytes: Uint8Array): Promise<string> {
  const latin = new TextDecoder("latin1", { fatal: false }).decode(bytes);
  const textParts: string[] = [];

  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match: RegExpExecArray | null;
  let checked = 0;

  while ((match = streamRegex.exec(latin)) !== null && checked < 250) {
    checked++;
    const rawStr = match[1];
    const streamBytes = new Uint8Array(rawStr.length);
    for (let i = 0; i < rawStr.length; i++) {
      streamBytes[i] = rawStr.charCodeAt(i) & 0xff;
    }

    let decodedText = rawStr;
    try {
      const inflated = await decompressRaw(streamBytes, "deflate");
      decodedText = new TextDecoder("latin1", { fatal: false }).decode(inflated);
    } catch {
      // Not zlib-compressed; scan literal operators directly
    }

    const literalMatches = decodedText.match(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g);
    if (literalMatches) {
      const lineWords: string[] = [];
      for (const lit of literalMatches) {
        const inner = lit
          .slice(1, -1)
          .replace(/\\\(/g, "(")
          .replace(/\\\)/g, ")")
          .replace(/\\\\/g, "\\")
          .replace(/\\n|\\r|\\t/g, " ");
        if (/[A-Za-z0-9]/.test(inner)) {
          lineWords.push(inner);
        }
      }
      if (lineWords.length > 0) {
        textParts.push(lineWords.join(" "));
      }
    }
  }

  return textParts.join("\n").trim();
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

async function readBrowserFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return await file.text();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read text"));
    reader.readAsText(file);
  });
}

async function readBrowserFileBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return await file.arrayBuffer();
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as ArrayBuffer) || new ArrayBuffer(0));
    reader.onerror = () => reject(reader.error || new Error("Failed to read buffer"));
    reader.readAsArrayBuffer(file);
  });
}

let activeRemoteExtractions = 0;
const remoteExtractWaiters: Array<() => void> = [];

async function withRemoteExtractSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeRemoteExtractions >= MAX_REMOTE_EXTRACT_CONCURRENCY) {
    await new Promise<void>((resolve) => remoteExtractWaiters.push(resolve));
  }
  activeRemoteExtractions++;
  try {
    return await fn();
  } finally {
    activeRemoteExtractions--;
    const next = remoteExtractWaiters.shift();
    if (next) next();
  }
}

export async function extractTextFromBrowserFile(
  file: File,
  api?: NanviApiClient,
): Promise<string> {
  const ext = getExt(file.name);
  if (TEXT_EXTENSIONS.has(ext)) {
    return (await readBrowserFileText(file)).trim();
  }
  if (MARKUP_EXTENSIONS.has(ext)) {
    return stripXmlTags(await readBrowserFileText(file));
  }

  const buffer = await readBrowserFileBuffer(file);
  const bytes = new Uint8Array(buffer);

  if (ext === ".xlsx" || ext === ".xls" || ext === ".xlsm" || ext === ".ods") {
    try {
      const wb = XLSX.read(bytes, { type: "array" });
      if (wb && wb.SheetNames && wb.SheetNames.length > 0) {
        const parts: string[] = [];
        for (const sname of wb.SheetNames) {
          const sheet = wb.Sheets[sname];
          const csv = XLSX.utils.sheet_to_csv(sheet);
          if (csv && csv.trim().length > 0) {
            parts.push(`--- Sheet: ${sname} ---\n${csv}`);
          }
        }
        if (parts.length > 0) {
          return parts.join("\n\n");
        }
      }
    } catch {
      // fallback to zip extractor
    }
  }

  if (OFFICE_ZIP_EXTENSIONS.has(ext)) {
    try {
      const text = await extractOfficeTextFromBytes(ext, bytes);
      if (text) return text;
    } catch {
      // fall through to stateless helper below if needed
    }
  }

  if (ext === ".pdf") {
    let localPdfText = "";
    let hasEmbeddedImages = false;
    try {
      const latinProbe = new TextDecoder("latin1", { fatal: false }).decode(bytes);
      hasEmbeddedImages = /\/Subtype\s*\/Image\b/i.test(latinProbe);
      localPdfText = await extractPdfTextSimple(bytes);
      const alphaCount = (localPdfText.match(/[A-Za-z0-9]/g) || []).length;
      if (alphaCount >= 40 && !hasEmbeddedImages) return localPdfText;
    } catch {
      // compressed fonts / object streams — use stateless RAM extractor + OCR
    }
    if (api && typeof api.extractLocalDocumentText === "function" && bytes.length <= MAX_EXTRACT_FALLBACK_BYTES) {
      try {
        const res = await withRemoteExtractSlot(() =>
          api.extractLocalDocumentText(file.name, arrayBufferToBase64(bytes)),
        );
        if (res?.text && res.text.trim()) return res.text.trim();
      } catch {
        // fall through to any selectable text already recovered
      }
    }
    if (localPdfText.trim()) return localPdfText;
  }

  // Image files & complex binary documents — extract text via stateless RAM OCR / parser
  if (
    (IMAGE_EXTENSIONS.has(ext) || ext !== ".pdf") &&
    api &&
    typeof api.extractLocalDocumentText === "function" &&
    bytes.length <= MAX_EXTRACT_FALLBACK_BYTES
  ) {
    try {
      const res = await withRemoteExtractSlot(() =>
        api.extractLocalDocumentText(file.name, arrayBufferToBase64(bytes)),
      );
      if (res?.text) return res.text.trim();
    } catch {
      // ignore extraction error on unreadable files
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// Chunking & Hash Utilities
// ---------------------------------------------------------------------------

function hashId(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const p1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const p2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${p1}${p2}`;
}

export function chunkBrowserText(text: string, maxChunks: number = MAX_CHUNKS_PER_FILE): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_SIZE_CHARS) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length && chunks.length < maxChunks) {
    let end = start + CHUNK_SIZE_CHARS;
    if (end < clean.length) {
      const paraBreak = clean.lastIndexOf("\n\n", end);
      if (paraBreak > start + CHUNK_SIZE_CHARS / 2) {
        end = paraBreak + 2;
      } else {
        const lineBreak = clean.lastIndexOf("\n", end);
        if (lineBreak > start + CHUNK_SIZE_CHARS / 2) {
          end = lineBreak + 1;
        }
      }
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Recursive Directory Traversal, Sync & Watcher
// ---------------------------------------------------------------------------

type WalkedEntry = {
  relativePath: string;
  fileHandle: FileSystemFileHandle;
};

async function collectDirectoryFiles(
  dirHandle: BrowserDirectoryHandle,
  prefix = "",
): Promise<WalkedEntry[]> {
  const out: WalkedEntry[] = [];
  const queue: Array<{ handle: BrowserDirectoryHandle; prefix: string }> = [{ handle: dirHandle, prefix }];

  while (queue.length > 0) {
    const wave = queue.splice(0, DIR_WALK_CONCURRENCY);
    await Promise.all(
      wave.map(async (next) => {
        try {
          for await (const entry of next.handle.values()) {
            if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
            if (entry.kind === "directory") {
              if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
              const nextPrefix = next.prefix ? `${next.prefix}/${entry.name}` : entry.name;
              queue.push({ handle: entry as BrowserDirectoryHandle, prefix: nextPrefix });
            } else if (entry.kind === "file") {
              const ext = getExt(entry.name);
              if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
              const rel = next.prefix ? `${next.prefix}/${entry.name}` : entry.name;
              out.push({ relativePath: rel, fileHandle: entry as FileSystemFileHandle });
            }
          }
        } catch {
          // skip unreadable directory
        }
      }),
    );
  }

  return out;
}

type CollectedBrowserFile = {
  relativePath: string;
  file?: File;
  name?: string;
  size?: number;
  lastModified?: number;
  loadFile?: () => Promise<File | null>;
};

function getFilePriorityTier(name: string): number {
  const ext = getExt(name);
  if (TEXT_EXTENSIONS.has(ext) || MARKUP_EXTENSIONS.has(ext)) return 0;
  if (OFFICE_ZIP_EXTENSIONS.has(ext)) return 1;
  return 2;
}

function sortDirtyFilesForFastIndexing(items: CollectedBrowserFile[]): CollectedBrowserFile[] {
  return [...items].sort((a, b) => {
    const aName = a.file?.name || a.name || a.relativePath;
    const bName = b.file?.name || b.name || b.relativePath;
    const tierDiff = getFilePriorityTier(aName) - getFilePriorityTier(bName);
    if (tierDiff !== 0) return tierDiff;
    const aSize = a.file ? a.file.size : (a.size ?? 0);
    const bSize = b.file ? b.file.size : (b.size ?? 0);
    return aSize - bSize;
  });
}

function buildStubMetaForDirtyFile(item: CollectedBrowserFile, folderName: string): BrowserFileMeta {
  const name = item.file?.name || item.name || item.relativePath.split("/").pop() || item.relativePath;
  const size = item.file ? item.file.size : (item.size ?? 0);
  const lastMod = item.file ? item.file.lastModified : (item.lastModified ?? Date.now());
  return {
    relative_path: item.relativePath,
    filename: name,
    folder_name: folderName,
    file_type: getExt(name).replace(/^\./, ""),
    size_bytes: size,
    chunk_count: 0,
    modified_at: new Date(lastMod).toISOString(),
  };
}

async function uploadCatalogAndChunks(
  api: NanviApiClient,
  pairingToken: string,
  meta: { folderId: string; folderPath: string; folderName: string },
  filesMeta: BrowserFileMeta[],
  chunks: BrowserChunkRecord[],
  onProgress?: (p: BrowserSyncProgress) => void,
  stats?: { totalFiles: number; reusedCount: number },
  shouldAbort?: () => boolean,
): Promise<void> {
  const { folderId, folderPath, folderName } = meta;
  if (shouldAbort?.()) return;

  if (filesMeta.length > FILE_META_BATCH_SIZE) {
    for (let fStart = 0; fStart < filesMeta.length; fStart += FILE_META_BATCH_SIZE) {
      if (shouldAbort?.()) return;
      const fileSlice = filesMeta.slice(fStart, fStart + FILE_META_BATCH_SIZE);
      await api.syncLocalFolderWithPairingToken(pairingToken, {
        folder_id: folderId,
        folder_path: folderPath,
        display_name: folderName,
        files: fileSlice,
        chunks: [],
        replace_all: fStart === 0,
      });
    }
    const batches = splitChunkBatches(chunks);
    for (let b = 0; b < batches.length; b++) {
      if (shouldAbort?.()) return;
      onProgress?.({
        phase: "syncing",
        scannedFiles: stats?.totalFiles ?? filesMeta.length,
        indexedFiles: filesMeta.length,
        cachedFiles: stats?.reusedCount ?? 0,
        totalFiles: stats?.totalFiles ?? filesMeta.length,
        totalChunks: chunks.length,
        message: `Syncing batch ${b + 1}/${batches.length} (${chunks.length} searchable sections)...`,
      });
      await api.syncLocalFolderWithPairingToken(pairingToken, {
        folder_id: folderId,
        folder_path: folderPath,
        display_name: folderName,
        files: [],
        chunks: batches[b],
        replace_all: false,
      });
    }
    return;
  }

  if (chunks.length === 0) {
    await api.syncLocalFolderWithPairingToken(pairingToken, {
      folder_id: folderId,
      folder_path: folderPath,
      display_name: folderName,
      files: filesMeta,
      chunks: [],
      replace_all: true,
    });
    return;
  }

  const batches = splitChunkBatches(chunks);
  for (let b = 0; b < batches.length; b++) {
    if (shouldAbort?.()) return;
    if (batches.length > 1) {
      onProgress?.({
        phase: "syncing",
        scannedFiles: stats?.totalFiles ?? filesMeta.length,
        indexedFiles: filesMeta.length,
        cachedFiles: stats?.reusedCount ?? 0,
        totalFiles: stats?.totalFiles ?? filesMeta.length,
        totalChunks: chunks.length,
        message: `Syncing batch ${b + 1}/${batches.length} (${chunks.length} searchable sections)...`,
      });
    }
    await api.syncLocalFolderWithPairingToken(pairingToken, {
      folder_id: folderId,
      folder_path: folderPath,
      display_name: folderName,
      files: b === 0 ? filesMeta : [],
      chunks: batches[b],
      replace_all: b === 0,
    });
  }
}

async function syncCollectedFiles(
  api: NanviApiClient,
  params: {
    folderName: string;
    agentVersion: string;
    totalFiles: number;
    validFiles: CollectedBrowserFile[];
    allKnownPaths: Set<string>;
    snapshotMap: Map<string, number>;
    dirHandle?: BrowserDirectoryHandle | null;
  },
  onProgress?: (p: BrowserSyncProgress) => void,
  options?: BrowserSyncOptions,
): Promise<BrowserSyncResult> {
  const { folderName, agentVersion, totalFiles, validFiles, allKnownPaths, snapshotMap, dirHandle } = params;
  const myGen = getNextFolderSyncGeneration(folderName);
  isBackgroundIndexing = false;
  const folderId = `browser://${folderName}`;
  const folderPath = resolveEffectiveFolderPath(folderName);
  const folderMeta = { folderId, folderPath, folderName };

  sessionFolderName = folderName;
  const existingCache = options?.forceFullReindex ? null : await getCachedFolderIndex(folderName);
  const prevEntries = existingCache?.entries || {};

  const nextCacheEntries: Record<string, CachedFileEntry> = {};
  const dirtyFiles: CollectedBrowserFile[] = [];
  let reusedCount = 0;

  for (const item of validFiles) {
    const itemSize = item.file ? item.file.size : (item.size ?? 0);
    const itemLastMod = item.file ? item.file.lastModified : (item.lastModified ?? 0);
    const prev = prevEntries[item.relativePath];
    if (prev && prev.lastModified === itemLastMod && prev.size === itemSize) {
      nextCacheEntries[item.relativePath] = prev;
      reusedCount++;
    } else {
      dirtyFiles.push(item);
    }
  }

  const prioritizedDirty = sortDirtyFilesForFastIndexing(dirtyFiles);
  const maxChunksForFile = getEffectiveMaxChunksPerFile(validFiles.length);
  const deletedCount = Object.keys(prevEntries).filter((p) => !(p in nextCacheEntries)).length;
  const noLocalDelta = prioritizedDirty.length === 0 && deletedCount === 0 && reusedCount > 0;

  let skipUpload = false;
  if (noLocalDelta && options?.skipIfBackendMatches !== false && typeof api.getLocalAgentStatus === "function") {
    try {
      const reusedChunkTotal = Object.values(nextCacheEntries).reduce((s, e) => s + e.chunks.length, 0);
      const reusedFileTotal = Object.keys(nextCacheEntries).length;
      const status = await api.getLocalAgentStatus();
      const matchingFolder = status.connected_folders?.find(
        (f) => f.folder_id === folderId || f.display_name === folderName,
      );
      const folderChunkCount = matchingFolder?.chunk_count ?? 0;
      if (
        matchingFolder &&
        (!matchingFolder.folder_path || matchingFolder.folder_path === folderPath) &&
        matchingFolder.file_count === reusedFileTotal &&
        (folderChunkCount === reusedChunkTotal ||
          status.total_chunks === reusedChunkTotal ||
          (typeof existingCache?.uploadedChunks === "number" && (folderChunkCount === existingCache.uploadedChunks || status.total_chunks === existingCache.uploadedChunks)) ||
          (reusedChunkTotal > BACKEND_MAX_CHUNKS && (folderChunkCount >= BACKEND_MAX_CHUNKS || status.total_chunks >= BACKEND_MAX_CHUNKS)))
      ) {
        skipUpload = true;
      }
    } catch {
      skipUpload = false;
    }
  }

  const hasPdfWork = prioritizedDirty.some((d) => getExt(d.name || d.file?.name || d.relativePath) === ".pdf");
  const localOnly = Boolean(options?.localOnly);
  const useBackgroundStream =
    Boolean(options?.background) &&
    !skipUpload &&
    (prioritizedDirty.length > 15 || (hasPdfWork && prioritizedDirty.length > 3));

  const extractSingleDirty = async (item: CollectedBrowserFile): Promise<CachedFileEntry | null> => {
    const file = item.file ?? (item.loadFile ? await item.loadFile() : null);
    if (!file) return null;
    const text = await extractTextFromBrowserFile(file, api);
    const textChunks = text ? chunkBrowserText(text, maxChunksForFile) : [];
    const modIso = new Date(file.lastModified).toISOString();
    const ext = getExt(file.name).replace(/^\./, "");

    const fileRecord: BrowserFileMeta = {
      relative_path: item.relativePath,
      filename: file.name,
      folder_name: folderName,
      file_type: ext,
      size_bytes: file.size,
      chunk_count: textChunks.length,
      modified_at: modIso,
    };
    const chunks: BrowserChunkRecord[] = textChunks.map((chunkText, cIdx) => ({
      chunk_id: hashId(`${item.relativePath}:${cIdx}:${chunkText.slice(0, 64)}`),
      relative_path: item.relativePath,
      filename: file.name,
      folder_name: folderName,
      chunk_index: cIdx,
      text: chunkText,
      char_count: chunkText.length,
      modified_at: modIso,
      metadata: { browser_direct: true },
    }));

    return {
      lastModified: file.lastModified,
      size: file.size,
      fileRecord,
      chunks,
    };
  };

  if (useBackgroundStream) {
    // Phase 1 (<0.3s): Register full file catalog + any cached chunks immediately & mark folder Connected
    const initialFilesMeta: BrowserFileMeta[] = [];
    const initialCachedChunks: BrowserChunkRecord[] = [];
    for (const entry of Object.values(nextCacheEntries)) {
      initialFilesMeta.push(entry.fileRecord);
      initialCachedChunks.push(...entry.chunks);
    }
    for (const item of prioritizedDirty) {
      const stub = buildStubMetaForDirtyFile(item, folderName);
      initialFilesMeta.push(stub);
      if (localOnly && !nextCacheEntries[item.relativePath]) {
        nextCacheEntries[item.relativePath] = {
          lastModified: item.file?.lastModified ?? item.lastModified ?? 0,
          size: item.file?.size ?? item.size ?? 0,
          fileRecord: stub,
          chunks: [],
        };
      }
    }

    folderFileSnapshots.set(folderName, snapshotMap);
    lastFileSnapshot = snapshotMap;
    knownRelativePaths = allKnownPaths;

    let pairingToken = "";
    if (localOnly) {
      desktopLocalCacheSnapshot = { ...nextCacheEntries };
      saveDesktopFolderMeta({
        folderId,
        folderPath,
        folderName,
        fileCount: initialFilesMeta.length,
        chunkCount: initialCachedChunks.length,
        lastSyncedAt: new Date().toISOString(),
      });
    } else {
      const tokenResp = await api.getLocalAgentToken();
      pairingToken = tokenResp.token;

      await uploadCatalogAndChunks(
        api,
        pairingToken,
        folderMeta,
        initialFilesMeta,
        initialCachedChunks,
        undefined,
        { totalFiles, reusedCount },
        () => !isFolderSyncActive(folderName, myGen),
      );

      if (!isFolderSyncActive(folderName, myGen)) {
        return {
          folderName,
          folderId,
          fileCount: initialFilesMeta.length,
          chunkCount: initialCachedChunks.length,
          reusedCachedCount: reusedCount,
        };
      }

      await api.sendLocalAgentHeartbeatWithPairingToken(pairingToken, {
        agent_version: agentVersion,
        folders: [
          {
            folder_id: folderId,
            folder_path: folderPath,
            display_name: folderName,
            file_count: initialFilesMeta.length,
            chunk_count: initialCachedChunks.length,
            status: "synced",
          },
        ],
      });
    }

    const currentTotalFolders = getCurrentTotalBrowserFolderCount();
    window.dispatchEvent(
      new CustomEvent("nanvi:company-folder-updated", {
        detail: {
          path: folderPath,
          exists: true,
          folder_count: currentTotalFolders,
          file_count: initialFilesMeta.length,
        },
      }),
    );

    // Phase 2: Stream prioritized content extraction silently in compact background waves (or locally only on Desktop)
    isBackgroundIndexing = true;
    const bgTask = (async () => {
      let currentToken = pairingToken;
      let streamedChunksCount = initialCachedChunks.length;
      const pendingStreamChunks: BrowserChunkRecord[] = [];
      let pendingStreamBytes = 0;
      let flushChain: Promise<void> = Promise.resolve();
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let completedDirty = 0;
      let lastCheckpointAt = Date.now();
      let lastUiNotifyAt = Date.now();

      const clearFlushTimer = () => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
      };

      const doFlush = (force: boolean) => {
        if (localOnly || !isFolderSyncActive(folderName, myGen)) return;
        if (!force && pendingStreamChunks.length < STREAM_CHUNK_BATCH_SIZE && pendingStreamBytes < 220_000) {
          return;
        }
        clearFlushTimer();
        if (pendingStreamChunks.length === 0) return;

        const toSend = pendingStreamChunks.splice(0, pendingStreamChunks.length);
        pendingStreamBytes = 0;

        flushChain = flushChain.then(async () => {
          const chunkBatches = splitChunkBatches(toSend);
          for (const batch of chunkBatches) {
            if (!isFolderSyncActive(folderName, myGen)) return;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                await api.syncLocalFolderWithPairingToken(currentToken, {
                  folder_id: folderId,
                  folder_path: folderPath,
                  display_name: folderName,
                  files: [],
                  chunks: batch,
                  replace_all: false,
                });
                streamedChunksCount += batch.length;
                break;
              } catch {
                if (attempt === 0) {
                  try {
                    const refreshed = await api.getLocalAgentToken();
                    currentToken = refreshed.token;
                  } catch {
                    // ignore token refresh error
                  }
                  await new Promise((r) => setTimeout(r, 400));
                }
              }
            }
          }
          const nowNotify = Date.now();
          if (isFolderSyncActive(folderName, myGen) && nowNotify - lastUiNotifyAt >= 2000) {
            lastUiNotifyAt = nowNotify;
            const currentTotalFolders = getCurrentTotalBrowserFolderCount();
            window.dispatchEvent(
              new CustomEvent("nanvi:company-folder-updated", {
                detail: {
                  path: folderPath,
                  exists: true,
                  folder_count: currentTotalFolders,
                  file_count: initialFilesMeta.length,
                },
              }),
            );
          }
        });
      };

      const scheduleTimerFlush = () => {
        if (localOnly || flushTimer !== null || !isFolderSyncActive(folderName, myGen)) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          doFlush(true);
        }, STREAM_FLUSH_INTERVAL_MS);
      };

      try {
        let cursor = 0;
        const workers = Array.from(
          { length: Math.min(EXTRACTION_CONCURRENCY, prioritizedDirty.length) },
          async () => {
            while (isFolderSyncActive(folderName, myGen)) {
              const idx = cursor++;
              if (idx >= prioritizedDirty.length) break;
              const item = prioritizedDirty[idx];
              try {
                const entry = await extractSingleDirty(item);
                if (!isFolderSyncActive(folderName, myGen)) break;
                if (entry) {
                  nextCacheEntries[item.relativePath] = entry;
                  if (localOnly) {
                    desktopLocalCacheSnapshot[item.relativePath] = entry;
                    streamedChunksCount += entry.chunks.length;
                  } else if (entry.chunks.length > 0) {
                    for (const ch of entry.chunks) {
                      pendingStreamChunks.push(ch);
                      pendingStreamBytes += (ch.text?.length || 0) + 256;
                    }
                    if (pendingStreamChunks.length >= STREAM_CHUNK_BATCH_SIZE || pendingStreamBytes >= 220_000) {
                      doFlush(true);
                    } else {
                      scheduleTimerFlush();
                    }
                  }
                }
              } catch {
                // skip unreadable file
              } finally {
                completedDirty++;
                const nowCp = Date.now();
                if (isFolderSyncActive(folderName, myGen) && completedDirty % 250 === 0 && nowCp - lastCheckpointAt >= 8000) {
                  lastCheckpointAt = nowCp;
                  await saveCachedFolderIndex({
                    folderName,
                    updatedAt: nowCp,
                    entries: { ...nextCacheEntries },
                  });
                  if (localOnly) {
                    saveDesktopFolderMeta({
                      folderId,
                      folderPath,
                      folderName,
                      fileCount: initialFilesMeta.length,
                      chunkCount: streamedChunksCount,
                      lastSyncedAt: new Date().toISOString(),
                    });
                  }
                }
              }
            }
          },
        );

        await Promise.all(workers);
        clearFlushTimer();
        if (!isFolderSyncActive(folderName, myGen)) return;

        if (!localOnly) {
          doFlush(true);
          await flushChain;
          if (!isFolderSyncActive(folderName, myGen)) return;
        }

        await saveCachedFolderIndex({
          folderName,
          updatedAt: Date.now(),
          uploadedChunks: Math.min(streamedChunksCount, BACKEND_MAX_CHUNKS),
          entries: nextCacheEntries,
        });

        if (localOnly) {
          desktopLocalCacheSnapshot = { ...nextCacheEntries };
          saveDesktopFolderMeta({
            folderId,
            folderPath,
            folderName,
            fileCount: initialFilesMeta.length,
            chunkCount: streamedChunksCount,
            lastSyncedAt: new Date().toISOString(),
          });
        } else {
          await api.sendLocalAgentHeartbeatWithPairingToken(currentToken, {
            agent_version: agentVersion,
            folders: [
              {
                folder_id: folderId,
                folder_path: folderPath,
                display_name: folderName,
                file_count: initialFilesMeta.length,
                chunk_count: streamedChunksCount,
                status: "synced",
              },
            ],
          });

          if (dirHandle) {
            startBrowserFolderWatcher(api, dirHandle);
          } else {
            startWebkitKeepaliveWatcher(api, folderName, initialFilesMeta.length, streamedChunksCount, agentVersion);
          }
        }

        const currentTotalFolders = getCurrentTotalBrowserFolderCount();
        window.dispatchEvent(
          new CustomEvent("nanvi:company-folder-updated", {
            detail: {
              path: folderPath,
              exists: true,
              folder_count: currentTotalFolders,
              file_count: initialFilesMeta.length,
            },
          }),
        );
      } catch {
        // background worker resilient exit
      } finally {
        clearFlushTimer();
        if (isFolderSyncActive(folderName, myGen)) {
          isBackgroundIndexing = false;
        }
      }
    })();

    activeBackgroundSyncPromise = bgTask;
    onProgress?.({
      phase: "done",
      scannedFiles: totalFiles,
      indexedFiles: initialFilesMeta.length,
      cachedFiles: reusedCount,
      totalFiles,
      totalChunks: initialCachedChunks.length,
      message: `✓ Connected '${folderName}' (${initialFilesMeta.length} files) — indexing files in background`,
    });

    return {
      folderName,
      folderId,
      fileCount: initialFilesMeta.length,
      chunkCount: initialCachedChunks.length,
      reusedCachedCount: reusedCount,
      backgroundSyncing: true,
    };
  }

  // Standard (awaited) path for small folders (<=15 files), cache restores, and direct programmatic/test syncs
  if (prioritizedDirty.length > 0) {
    let cursor = 0;
    let completedDirty = 0;
    let lastProgressAt = 0;
    let lastCheckpointAt = Date.now();

    const workers = Array.from(
      { length: Math.min(EXTRACTION_CONCURRENCY, prioritizedDirty.length) },
      async () => {
        while (isFolderSyncActive(folderName, myGen)) {
          const idx = cursor++;
          if (idx >= prioritizedDirty.length) break;
          const item = prioritizedDirty[idx];
          try {
            const name = item.file?.name || item.name || item.relativePath;
            const now = Date.now();
            if (completedDirty === 0 || now - lastProgressAt >= 150) {
              lastProgressAt = now;
              onProgress?.({
                phase: "extracting",
                scannedFiles: reusedCount + completedDirty + 1,
                indexedFiles: reusedCount + completedDirty,
                cachedFiles: reusedCount,
                totalFiles,
                totalChunks: 0,
                currentFile: name,
                message:
                  reusedCount > 0
                    ? `Reused ${reusedCount} cached • Reading (${completedDirty + 1}/${prioritizedDirty.length} changed): ${name}`
                    : `Reading (${completedDirty + 1}/${prioritizedDirty.length}): ${name}`,
              });
            }

            const entry = await extractSingleDirty(item);
            if (entry) {
              nextCacheEntries[item.relativePath] = entry;
            }
          } catch {
            // skip unreadable file
          } finally {
            completedDirty++;
            const nowCheckpoint = Date.now();
            if (completedDirty % 250 === 0 && nowCheckpoint - lastCheckpointAt >= 8000) {
              lastCheckpointAt = nowCheckpoint;
              await saveCachedFolderIndex({
                folderName,
                updatedAt: nowCheckpoint,
                entries: { ...nextCacheEntries },
              });
            }
          }
        }
      },
    );

    await Promise.all(workers);
  }

  const filesMeta: BrowserFileMeta[] = [];
  const allChunks: BrowserChunkRecord[] = [];
  for (const entry of Object.values(nextCacheEntries)) {
    filesMeta.push(entry.fileRecord);
    allChunks.push(...entry.chunks);
  }

  await saveCachedFolderIndex({
    folderName,
    updatedAt: Date.now(),
    uploadedChunks: Math.min(allChunks.length, BACKEND_MAX_CHUNKS),
    entries: nextCacheEntries,
  });

  folderFileSnapshots.set(folderName, snapshotMap);
  lastFileSnapshot = snapshotMap;
  knownRelativePaths = allKnownPaths;

  if (localOnly) {
    desktopLocalCacheSnapshot = { ...nextCacheEntries };
    saveDesktopFolderMeta({
      folderId,
      folderPath,
      folderName,
      fileCount: filesMeta.length,
      chunkCount: allChunks.length,
      lastSyncedAt: new Date().toISOString(),
    });
  } else {
    const tokenResp = await api.getLocalAgentToken();
    const pairingToken = tokenResp.token;

    if (!skipUpload) {
      onProgress?.({
        phase: "syncing",
        scannedFiles: totalFiles,
        indexedFiles: filesMeta.length,
        cachedFiles: reusedCount,
        totalFiles,
        totalChunks: allChunks.length,
        message:
          reusedCount === filesMeta.length && filesMeta.length > 0
            ? `Restoring ${filesMeta.length} files from local browser cache (instant)...`
            : `Syncing ${allChunks.length} searchable sections to Nanvi...`,
      });

      await uploadCatalogAndChunks(
        api,
        pairingToken,
        folderMeta,
        filesMeta,
        allChunks,
        onProgress,
        { totalFiles, reusedCount },
        () => !isFolderSyncActive(folderName, myGen),
      );
    }

    await api.sendLocalAgentHeartbeatWithPairingToken(pairingToken, {
      agent_version: agentVersion,
      folders: [
        {
          folder_id: folderId,
          folder_path: folderPath,
          display_name: folderName,
          file_count: filesMeta.length,
          chunk_count: allChunks.length,
          status: "synced",
        },
      ],
    });

    if (dirHandle) {
      startBrowserFolderWatcher(api, dirHandle);
    } else {
      startWebkitKeepaliveWatcher(api, folderName, filesMeta.length, allChunks.length, agentVersion);
    }
  }

  const currentTotalFolders = getCurrentTotalBrowserFolderCount();
  window.dispatchEvent(
    new CustomEvent("nanvi:company-folder-updated", {
      detail: {
        path: folderPath,
        exists: true,
        folder_count: currentTotalFolders,
        file_count: filesMeta.length,
      },
    }),
  );

  const statusMsg = skipUpload
    ? `✓ '${folderName}' is up to date (${filesMeta.length} files verified in <1s)`
    : reusedCount > 0 && prioritizedDirty.length === 0
      ? `✓ Restored '${folderName}' from cache (${filesMeta.length} files, 0 re-read)`
      : `✓ Connected '${folderName}' (${filesMeta.length} files, ${allChunks.length} chunks)`;

  onProgress?.({
    phase: "done",
    scannedFiles: totalFiles,
    indexedFiles: filesMeta.length,
    cachedFiles: reusedCount,
    totalFiles,
    totalChunks: allChunks.length,
    message: statusMsg,
  });

  return {
    folderName,
    folderId,
    fileCount: filesMeta.length,
    chunkCount: allChunks.length,
    reusedCachedCount: reusedCount,
  };
}

export async function syncBrowserDirectory(
  api: NanviApiClient,
  dirHandle: BrowserDirectoryHandle,
  onProgress?: (p: BrowserSyncProgress) => void,
  options?: BrowserSyncOptions,
): Promise<BrowserSyncResult> {
  const res = await runExclusiveSync(async () => {
    await saveBrowserDirectoryHandle(dirHandle);
    const folderName = dirHandle.name || "Local Folder";

    onProgress?.({
      phase: "scanning",
      scannedFiles: 0,
      indexedFiles: 0,
      totalFiles: 0,
      totalChunks: 0,
      message: `Scanning '${folderName}' for changes...`,
    });

    const entries = await collectDirectoryFiles(dirHandle);
    const validFiles: CollectedBrowserFile[] = [];
    const nextSnapshot = new Map<string, number>();
    const nextPaths = new Set<string>();

    const META_BATCH = META_BATCH_SIZE;
    for (let i = 0; i < entries.length; i += META_BATCH) {
      const slice = entries.slice(i, i + META_BATCH);
      const loaded = await Promise.all(
        slice.map(async ({ relativePath, fileHandle }) => {
          try {
            const file = await fileHandle.getFile();
            return { relativePath, file };
          } catch {
            return null;
          }
        }),
      );
      for (const item of loaded) {
        if (!item) continue;
        nextPaths.add(item.relativePath);
        nextSnapshot.set(item.relativePath, item.file.lastModified);
        if (item.file.size > 0 && item.file.size <= MAX_FILE_SIZE_BYTES) {
          validFiles.push(item);
        }
      }
    }

    return await syncCollectedFiles(
      api,
      {
        folderName,
        agentVersion: "browser-fs-1.0.0",
        totalFiles: entries.length,
        validFiles,
        allKnownPaths: nextPaths,
        snapshotMap: nextSnapshot,
        dirHandle,
      },
      onProgress,
      options,
    );
  });

  return res || {
    folderName: dirHandle.name,
    folderId: `browser://${dirHandle.name}`,
    fileCount: lastFileSnapshot.size,
    chunkCount: 0,
    reusedCachedCount: 0,
  };
}

export async function syncWebkitFileList(
  api: NanviApiClient,
  files: FileList | File[],
  onProgress?: (p: BrowserSyncProgress) => void,
  options?: BrowserSyncOptions,
): Promise<BrowserSyncResult | null> {
  const arr = Array.from(files);
  if (arr.length === 0) return null;

  return await runExclusiveSync(async () => {
    activeDirectoryHandle = null;
    desktopAbsPathMap.clear();

    let detectedFolderName = "Local Folder";
    const firstRel = (arr[0] as File & { webkitRelativePath?: string }).webkitRelativePath || "";
    if (firstRel.includes("/")) {
      detectedFolderName = firstRel.split("/")[0] || "Local Folder";
    }

    // Clean up previous session entries for this specific folder, but preserve other folders
    const folderPrefix = `${detectedFolderName}/`.toLowerCase();
    const folderBackslashPrefix = `${detectedFolderName}\\`.toLowerCase();
    for (const [k] of Array.from(sessionFileMap.entries())) {
      const lower = k.toLowerCase();
      if (lower.startsWith(folderPrefix) || lower.startsWith(folderBackslashPrefix)) {
        sessionFileMap.delete(k);
      }
    }

    onProgress?.({
      phase: "scanning",
      scannedFiles: 0,
      indexedFiles: 0,
      totalFiles: arr.length,
      totalChunks: 0,
      message: `Scanning '${detectedFolderName}' for changes...`,
    });

    const validFiles: CollectedBrowserFile[] = [];
    const nextSnapshot = new Map<string, number>();
    const nextPaths = new Set<string>();

    for (const file of arr) {
      const rawRel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const parts = rawRel.replace(/\\/g, "/").split("/").filter(Boolean);
      const relParts = parts.length > 1 && parts[0] === detectedFolderName ? parts.slice(1) : parts;
      if (relParts.length === 0) continue;

      if (relParts.some((seg, idx) => {
        if (idx < relParts.length - 1) {
          return seg.startsWith(".") || IGNORED_DIRS.has(seg.toLowerCase());
        }
        return seg.startsWith(".") || seg.startsWith("~$");
      })) {
        continue;
      }

      const ext = getExt(file.name);
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      const relativePath = relParts.join("/");
      nextPaths.add(relativePath);
      nextSnapshot.set(relativePath, file.lastModified);
      // Index under relativePath, under folderName/relativePath, and by base filename
      sessionFileMap.set(relativePath, file);
      sessionFileMap.set(`${detectedFolderName}/${relativePath}`, file);
      sessionFileMap.set(file.name.toLowerCase(), file);

      if (file.size > 0 && file.size <= MAX_FILE_SIZE_BYTES) {
        validFiles.push({ relativePath, file });
      }
    }

    return await syncCollectedFiles(
      api,
      {
        folderName: detectedFolderName,
        agentVersion: "browser-webkitdir-1.0.0",
        totalFiles: nextPaths.size,
        validFiles,
        allKnownPaths: nextPaths,
        snapshotMap: nextSnapshot,
        dirHandle: null,
      },
      onProgress,
      options,
    );
  });
}

export async function syncElectronFolder(
  api: NanviApiClient,
  folderPath: string,
  entries: ElectronFolderFileEntry[],
  onProgress?: (p: BrowserSyncProgress) => void,
  options?: BrowserSyncOptions,
): Promise<BrowserSyncResult | null> {
  if (!entries || entries.length === 0) return null;

  return await runExclusiveSync(async () => {
    activeDirectoryHandle = null;
    sessionFileMap.clear();
    desktopAbsPathMap.clear();

    const cleanedRoot = folderPath.replace(/[/\\]+$/, "");
    const folderName = cleanedRoot.split(/[/\\]/).pop() || cleanedRoot || "Local Folder";
    setBrowserFolderRealPath(folderName, cleanedRoot);

    onProgress?.({
      phase: "scanning",
      scannedFiles: 0,
      indexedFiles: 0,
      totalFiles: entries.length,
      totalChunks: 0,
      message: `Scanning '${folderName}'...`,
    });

    const validFiles: CollectedBrowserFile[] = [];
    const nextSnapshot = new Map<string, number>();
    const nextPaths = new Set<string>();

    for (const entry of entries) {
      const ext = getExt(entry.name);
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      if (entry.size <= 0 || entry.size > MAX_FILE_SIZE_BYTES) continue;

      const rel = entry.relativePath.replace(/\\/g, "/");
      nextPaths.add(rel);
      nextSnapshot.set(rel, entry.lastModified);
      desktopAbsPathMap.set(rel, entry.absPath);

      validFiles.push({
        relativePath: rel,
        name: entry.name,
        size: entry.size,
        lastModified: entry.lastModified,
        loadFile: async () => {
          const reader = typeof window !== "undefined" ? window.electronAPI?.readFileBytes : undefined;
          if (!reader) return null;
          const raw = await reader(entry.absPath);
          if (!raw) return null;
          const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
          const safeBuf = new Uint8Array(bytes.byteLength);
          safeBuf.set(bytes);
          return new File([safeBuf.buffer], entry.name, {
            type: inferBrowserFileMime(entry.name),
            lastModified: entry.lastModified,
          });
        },
      });
    }

    if (validFiles.length === 0) return null;

    return await syncCollectedFiles(
      api,
      {
        folderName,
        agentVersion: "desktop-electron-1.0.0",
        totalFiles: nextPaths.size,
        validFiles,
        allKnownPaths: nextPaths,
        snapshotMap: nextSnapshot,
        dirHandle: null,
      },
      onProgress,
      options,
    );
  });
}

const webkitKeepaliveFolders = new Map<
  string,
  { folderName: string; fileCount: number; chunkCount: number; agentVersion: string }
>();

function startWebkitKeepaliveWatcher(
  api: NanviApiClient,
  folderName: string,
  fileCount: number,
  chunkCount: number,
  agentVersion: string,
): void {
  webkitKeepaliveFolders.set(folderName, { folderName, fileCount, chunkCount, agentVersion });

  if (watcherTimer !== null) {
    return;
  }

  watcherTimer = window.setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    void (async () => {
      // 1. Multi-folder keepalive for webkit directory folders (Firefox & Safari)
      if (webkitKeepaliveFolders.size > 0) {
        try {
          const tokenResp = await api.getLocalAgentToken();
          const folderList = Array.from(webkitKeepaliveFolders.values()).map((entry) => ({
            folder_id: `browser://${entry.folderName}`,
            folder_path: resolveEffectiveFolderPath(entry.folderName),
            display_name: entry.folderName,
            file_count: entry.fileCount,
            chunk_count: entry.chunkCount,
            status: "synced" as const,
          }));
          await api.sendLocalAgentHeartbeatWithPairingToken(tokenResp.token, {
            agent_version: agentVersion,
            folders: folderList,
          });
        } catch {
          // transient keepalive error
        }
      }

      // 2. Multi-folder watching & keepalive for directory handles (Chrome & Edge)
      if (watcherHandlesMap.size > 0 && !isSyncInProgress && !isBackgroundIndexing) {
        for (const [fName, handle] of Array.from(watcherHandlesMap.entries())) {
          try {
            const ok = await verifyDirectoryPermission(handle, false);
            if (!ok) continue;

            const entries = await collectDirectoryFiles(handle);
            const folderSnapshot = folderFileSnapshots.get(fName) || lastFileSnapshot;
            let changed = false;
            for (const { relativePath, fileHandle } of entries) {
              const file = await fileHandle.getFile();
              if (folderSnapshot.get(relativePath) !== file.lastModified) {
                changed = true;
                break;
              }
            }

            if (changed) {
              await syncBrowserDirectory(api, handle);
            } else {
              const summary = await getCachedBrowserIndexSummary(fName);
              const chunkCount = summary?.chunkCount ?? 0;
              const tokenResp = await api.getLocalAgentToken();
              const folderId = `browser://${fName}`;
              const folderPath = resolveEffectiveFolderPath(fName);
              await api.sendLocalAgentHeartbeatWithPairingToken(tokenResp.token, {
                agent_version: "browser-fs-1.0.0",
                folders: [
                  {
                    folder_id: folderId,
                    folder_path: folderPath,
                    display_name: fName,
                    file_count: entries.length,
                    chunk_count: chunkCount,
                    status: "synced",
                  },
                ],
              });
            }
          } catch {
            // transient watcher error
          }
        }
      }
    })();
  }, 25000);
}

const watcherHandlesMap = new Map<string, BrowserDirectoryHandle>();

export function startBrowserFolderWatcher(api: NanviApiClient, dirHandle: BrowserDirectoryHandle): void {
  if (dirHandle.name) {
    watcherHandlesMap.set(dirHandle.name, dirHandle);
  }
  activeDirectoryHandle = dirHandle;

  if (watcherTimer !== null) {
    return;
  }

  startWebkitKeepaliveWatcher(api, dirHandle.name, 0, 0, "browser-fs-1.0.0");
}

export function stopBrowserFolderWatcher(folderName?: string): void {
  if (folderName) {
    watcherHandlesMap.delete(folderName);
    webkitKeepaliveFolders.delete(folderName);
    if (watcherHandlesMap.size > 0 || webkitKeepaliveFolders.size > 0) return;
  } else {
    watcherHandlesMap.clear();
    webkitKeepaliveFolders.clear();
  }
  if (watcherTimer !== null) {
    window.clearInterval(watcherTimer);
    watcherTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Direct Local File Reading for Instant In-Memory Browser Preview & Download
// ---------------------------------------------------------------------------

async function findFileRecursivelyInHandle(
  dir: BrowserDirectoryHandle,
  targetFileName: string,
  depth = 0,
  maxDepth = 4,
): Promise<File | null> {
  if (depth > maxDepth) return null;
  const targetLower = targetFileName.toLowerCase();

  try {
    // 1. Check direct file in current directory
    try {
      const directHandle = await dir.getFileHandle(targetFileName, { create: false });
      if (directHandle) return await directHandle.getFile();
    } catch {
      // not in immediate folder
    }

    // 2. Iterate directory entries
    const subDirs: FileSystemDirectoryHandle[] = [];
    // @ts-ignore
    if (typeof (dir as any).values === "function") {
      // @ts-ignore
      for await (const entry of (dir as any).values()) {
        if (entry.kind === "file") {
          if (entry.name.toLowerCase() === targetLower) {
            return await (entry as FileSystemFileHandle).getFile();
          }
        } else if (entry.kind === "directory" && !entry.name.startsWith(".")) {
          subDirs.push(entry as FileSystemDirectoryHandle);
        }
      }
    }

    // 3. Search subdirectories
    for (const subDir of subDirs) {
      const found = await findFileRecursivelyInHandle(subDir as BrowserDirectoryHandle, targetFileName, depth + 1, maxDepth);
      if (found) return found;
    }
  } catch {
    // Silently ignore permission/access errors
  }
  return null;
}

async function getFileByRelativePath(
  root: BrowserDirectoryHandle,
  relPath: string,
): Promise<File | null> {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;

  let current: FileSystemDirectoryHandle = root;
  for (let i = 0; i < parts.length - 1; i++) {
    current = await current.getDirectoryHandle(parts[i], { create: false });
  }
  const fh = await current.getFileHandle(parts[parts.length - 1], { create: false });
  return await fh.getFile();
}

export function cleanBrowserDisplayPath(rawPath: string): string {
  const clean = String(rawPath || "").trim();
  const fwd = clean.replace(/\\/g, "/");
  if (fwd.toLowerCase().startsWith("browserfolder/")) {
    return clean.slice("BrowserFolder/".length);
  }
  return clean;
}

function buildCandidatePaths(rawPath: string, rootName: string, knownPaths: Set<string>): Set<string> {
  let clean = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.toLowerCase().startsWith("browserfolder/")) {
    clean = clean.slice("BrowserFolder/".length);
  }
  const candidates = new Set<string>();

  if (rootName) {
    if (clean.toLowerCase().startsWith(`${rootName.toLowerCase()}/`)) {
      candidates.add(clean.slice(rootName.length + 1));
    }
    const marker = `/${rootName.toLowerCase()}/`;
    const idx = clean.toLowerCase().indexOf(marker);
    if (idx >= 0) {
      candidates.add(clean.slice(idx + marker.length));
    }
  }
  candidates.add(clean);

  const reqSegs = new Set(clean.toLowerCase().split("/").filter(Boolean));
  const suffixMatches: string[] = [];
  for (const known of knownPaths) {
    const kl = known.toLowerCase();
    const cl = clean.toLowerCase();
    if (cl === kl || cl.endsWith(`/${kl}`)) {
      suffixMatches.push(known);
    }
  }
  for (const m of suffixMatches) {
    candidates.add(m);
  }

  const baseName = clean.split("/").pop();
  if (baseName) {
    const sameName: Array<{ path: string; overlap: number }> = [];
    for (const known of knownPaths) {
      if (known.split("/").pop()?.toLowerCase() === baseName.toLowerCase()) {
        const segs = known.toLowerCase().split("/").filter(Boolean);
        const overlap = segs.filter((s) => reqSegs.has(s)).length;
        sameName.push({ path: known, overlap });
      }
    }
    sameName.sort((a, b) => b.overlap - a.overlap);
    for (const entry of sameName) {
      candidates.add(entry.path);
    }
    candidates.add(baseName);
  }

  return candidates;
}

export async function readBrowserLocalFile(rawPath: string, requestPermission = false): Promise<File | null> {
  if (!rawPath) return null;

  const fileName = rawPath.split(/[/\\]/).pop() || rawPath;

  // 1. Chrome / Edge FileSystemDirectoryHandle (Iterate all saved handles, with primary first)
  const handlesToTry: BrowserDirectoryHandle[] = [];
  try {
    const primary = await getSavedBrowserDirectoryHandle();
    if (primary) handlesToTry.push(primary);
    const all = await getAllSavedBrowserHandles();
    for (const entry of all) {
      if (!handlesToTry.some((h) => h.name === entry.handle.name)) {
        handlesToTry.push(entry.handle);
      }
    }
  } catch {
    // ignore
  }

  // Hydrate knownRelativePaths from cached index if empty
  if (knownRelativePaths.size === 0 && handlesToTry.length > 0) {
    try {
      const cached = await getCachedFolderIndex(handlesToTry[0].name);
      if (cached?.entries) {
        knownRelativePaths = new Set(Object.values(cached.entries).map((e) => e.fileRecord.relative_path));
      }
    } catch {
      // ignore
    }
  }

  for (const handle of handlesToTry) {
    try {
      const hasPerm = await verifyDirectoryPermission(handle, requestPermission);
      if (!hasPerm) continue;

      const candidates = buildCandidatePaths(rawPath, handle.name, knownRelativePaths);
      for (const cand of candidates) {
        try {
          const f = await getFileByRelativePath(handle, cand);
          if (f) return f;
        } catch {
          // try next path candidate
        }
      }

      // If direct candidate lookup fails, perform fast recursive scan inside the directory handle
      if (fileName) {
        const found = await findFileRecursivelyInHandle(handle, fileName, 0, 4);
        if (found) return found;
      }
    } catch {
      // continue to next handle
    }
  }

  // 2. Firefox / Safari session FileMap (from <input type="file" webkitdirectory>)
  if (sessionFileMap.size > 0) {
    const rootName = sessionFolderName;
    const known = new Set<string>([...knownRelativePaths, ...sessionFileMap.keys()]);
    const candidates = buildCandidatePaths(rawPath, rootName, known);
    for (const cand of candidates) {
      const f = sessionFileMap.get(cand);
      if (f) return f;
    }
    const fnLower = fileName.toLowerCase();
    for (const [pathKey, fileObj] of sessionFileMap.entries()) {
      if (fileObj.name.toLowerCase() === fnLower || pathKey.toLowerCase().endsWith(`/${fnLower}`)) {
        return fileObj;
      }
    }
  }

  // 3. Electron desktop session approved files (and direct approved Windows path read)
  if (typeof window !== "undefined" && window.electronAPI?.readFileBytes) {
    const buildElectronFile = (rawBytes: Uint8Array | ArrayBuffer, fileName: string) => {
      const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
      const safeBuf = new Uint8Array(bytes.byteLength);
      safeBuf.set(bytes);
      return new File([safeBuf.buffer], fileName, {
        type: inferBrowserFileMime(fileName),
      });
    };

    if (desktopAbsPathMap.size > 0) {
      const rootName = sessionFolderName;
      const known = new Set<string>([...knownRelativePaths, ...desktopAbsPathMap.keys()]);
      const candidates = buildCandidatePaths(rawPath, rootName, known);
      for (const cand of candidates) {
        const absPath = desktopAbsPathMap.get(cand);
        if (absPath) {
          const raw = await window.electronAPI.readFileBytes(absPath);
          if (raw) {
            return buildElectronFile(raw, cand.split("/").pop() || cand);
          }
        }
      }
    }

    const desktopMeta = readStoredDesktopFolderMeta();
    if (desktopMeta && desktopMeta.folderPath) {
      let resolvedPath = rawPath;
      if (!rawPath.includes(":") && !rawPath.startsWith("\\\\")) {
        const cleanRel = rawPath.replace(/^[/\\]+/, "").replace(/\//g, "\\");
        resolvedPath = `${desktopMeta.folderPath.replace(/[/\\]+$/, "")}\\${cleanRel}`;
      }
      let raw = await window.electronAPI.readFileBytes(resolvedPath);
      if (!raw && resolvedPath !== rawPath) {
        raw = await window.electronAPI.readFileBytes(rawPath);
      }
      if (raw) {
        return buildElectronFile(raw, rawPath.split(/[/\\]/).pop() || rawPath);
      }
    }
  }

  return null;
}

export function inferBrowserFileMime(filename: string, rawType?: string): string {
  if (rawType) return rawType;
  const ext = getExt(filename);
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".tsv": "text/tab-separated-values; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".svg": "image/svg+xml",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext] || "application/octet-stream";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseDelimitedRows(raw: string, delimiter: string): string[][] {
  try {
    const parsed = Papa.parse<string[]>(raw, {
      delimiter: delimiter || undefined,
      skipEmptyLines: "greedy",
    });
    if (parsed.data && parsed.data.length > 0) {
      return parsed.data.map((r) => r.map((c) => String(c ?? "").trim()));
    }
  } catch {
    // fallback to manual loop below
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"' && raw[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some((c) => c.length > 0)) rows.push(row);
  return rows;
}

export function formatWordDocumentPreviewHtml(filename: string, text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let bodyHtml = "";
  let isFirstHeading = true;
  let inList = false;

  for (const line of lines) {
    if (!line) {
      if (inList) {
        bodyHtml += "</ul>";
        inList = false;
      }
      continue;
    }

    const isHeading1 = isFirstHeading && line.length < 80;
    const isHeading2 =
      !isFirstHeading &&
      line.length < 60 &&
      !line.endsWith(".") &&
      (/^[A-Z0-9\s,&/()'-]+$/.test(line) ||
        /^(Section|Policy|Article|Part|\d+\.)/i.test(line) ||
        /^[A-Z][a-zA-Z0-9\s,&/()'-]+:?$/.test(line));
    const isListItem = /^(?:[-*•]|\d+[.)])\s+/.test(line);

    if (isHeading1) {
      if (inList) {
        bodyHtml += "</ul>";
        inList = false;
      }
      bodyHtml += `<h1 class="word-doc-title">${escapeHtml(line)}</h1>`;
      isFirstHeading = false;
    } else if (isHeading2) {
      if (inList) {
        bodyHtml += "</ul>";
        inList = false;
      }
      bodyHtml += `<h2 class="word-section-header">${escapeHtml(line)}</h2>`;
    } else if (isListItem) {
      if (!inList) {
        bodyHtml += `<ul class="word-bullet-list">`;
        inList = true;
      }
      const cleanItem = line.replace(/^(?:[-*•]|\d+[.)])\s+/, "");
      bodyHtml += `<li>${escapeHtml(cleanItem)}</li>`;
    } else {
      if (inList) {
        bodyHtml += "</ul>";
        inList = false;
      }
      if (line.length < 50 && !line.includes(".") && !line.includes(",")) {
        bodyHtml += `<h3 class="word-sub-header">${escapeHtml(line)}</h3>`;
      } else {
        bodyHtml += `<p class="word-paragraph">${escapeHtml(line)}</p>`;
      }
      isFirstHeading = false;
    }
  }
  if (inList) bodyHtml += "</ul>";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(filename)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: #eef2f6;
      font-family: 'Calibri', 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif;
      color: #1e293b;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
    }
    .word-ribbon {
      width: 100%;
      background: #2b579a;
      color: #ffffff;
      padding: 10px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 2px 6px rgba(0,0,0,0.12);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .word-ribbon-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .word-icon-badge {
      background: #1e3f73;
      color: #ffffff;
      font-weight: 800;
      font-size: 13px;
      padding: 3px 8px;
      border-radius: 4px;
      letter-spacing: 0.05em;
    }
    .word-file-title {
      font-size: 14px;
      font-weight: 600;
      color: #ffffff;
    }
    .word-badge {
      font-size: 11px;
      background: rgba(255,255,255,0.18);
      padding: 2px 8px;
      border-radius: 12px;
    }
    .word-document-stage {
      padding: 32px 20px 60px;
      width: 100%;
      display: flex;
      justify-content: center;
    }
    .word-page {
      background: #ffffff;
      width: 100%;
      max-width: 820px;
      min-height: 1050px;
      padding: 56px 64px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04);
      border: 1px solid #d1d5db;
      border-radius: 2px;
    }
    .word-doc-title {
      font-size: 23px;
      font-weight: 700;
      color: #1e3a8a;
      margin: 0 0 20px;
      line-height: 1.3;
      border-bottom: 2px solid #2b579a;
      padding-bottom: 12px;
    }
    .word-section-header {
      font-size: 16px;
      font-weight: 700;
      color: #1e40af;
      margin: 26px 0 10px;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 4px;
    }
    .word-sub-header {
      font-size: 14.5px;
      font-weight: 600;
      color: #0f172a;
      margin: 18px 0 6px;
    }
    .word-paragraph {
      font-size: 14px;
      line-height: 1.7;
      color: #334155;
      margin: 0 0 12px;
      text-align: justify;
    }
    .word-bullet-list {
      margin: 8px 0 16px 22px;
      padding: 0;
      color: #334155;
    }
    .word-bullet-list li {
      font-size: 14px;
      line-height: 1.65;
      margin-bottom: 6px;
    }
    .word-page-footer {
      margin-top: 48px;
      padding-top: 14px;
      border-top: 1px solid #e2e8f0;
      font-size: 11.5px;
      color: #94a3b8;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <div class="word-ribbon">
    <div class="word-ribbon-left">
      <span class="word-icon-badge">W</span>
      <span class="word-file-title">${escapeHtml(filename)}</span>
      <span class="word-badge">Microsoft Word Document (.docx)</span>
    </div>
    <span style="font-size: 12px; opacity: 0.85;">Formatted Document View</span>
  </div>
  <div class="word-document-stage">
    <div class="word-page">
      ${bodyHtml}
      <div class="word-page-footer">
        <span>Confidential Enterprise Document</span>
        <span>Page 1 · Microsoft Word</span>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function formatExcelSpreadsheetPreviewHtml(filename: string, text: string): string {
  let rows: string[][] = [];
  const ext = getExt(filename);

  if (ext === ".tsv" || text.includes("\t")) {
    rows = parseDelimitedRows(text, "\t");
  } else if (ext === ".csv" || (text.includes(",") && !text.includes("|"))) {
    rows = parseDelimitedRows(text, ",");
  } else {
    const rawLines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of rawLines) {
      if (line.includes("|")) {
        const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
        if (parts.length > 0 && !parts[0].startsWith("---")) {
          rows.push(parts);
        }
      } else {
        const parts = line.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
        rows.push(parts.length > 1 ? parts : [line]);
      }
    }
  }

  if (rows.length === 0) {
    rows = [["(No data rows found)"]];
  }

  const maxCols = Math.min(26, Math.max(4, ...rows.map((r) => r.length)));
  const colLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").slice(0, maxCols);

  const tableRowsHtml = rows
    .slice(0, 500)
    .map((row, rowIdx) => {
      const cells = Array.from({ length: maxCols }, (_, colIdx) => row[colIdx] ?? "");
      return `<tr>
      <td class="excel-row-num">${rowIdx + 1}</td>
      ${cells
        .map((c) => {
          const isNum = /^[\$€£₹]?\s?-?[\d,]+(\.\d+)?%?$/.test(c.trim());
          return `<td class="excel-cell ${isNum ? "is-number" : ""}">${escapeHtml(c)}</td>`;
        })
        .join("")}
    </tr>`;
    })
    .join("");

  const badgeLabel =
    ext === ".csv"
      ? "Comma-Separated Values (.csv)"
      : ext === ".tsv"
      ? "Tab-Separated Values (.tsv)"
      : ext === ".xls"
      ? "Microsoft Excel 97-2003 (.xls)"
      : ext === ".ods"
      ? "OpenDocument Spreadsheet (.ods)"
      : "Microsoft Excel Worksheet (.xlsx)";
  const iconBadge = ext === ".csv" ? "CSV" : ext === ".tsv" ? "TSV" : "X";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(filename)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: #f3f4f6;
      font-family: 'Segoe UI', Calibri, Arial, sans-serif;
      color: #1e293b;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .excel-ribbon {
      width: 100%;
      background: #107c41;
      color: #ffffff;
      padding: 8px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 2px 6px rgba(0,0,0,0.12);
      flex-shrink: 0;
    }
    .excel-ribbon-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .excel-icon-badge {
      background: #0b552c;
      color: #ffffff;
      font-weight: 800;
      font-size: 13px;
      padding: 3px 8px;
      border-radius: 4px;
    }
    .excel-file-title {
      font-size: 14px;
      font-weight: 600;
      color: #ffffff;
    }
    .excel-badge {
      font-size: 11px;
      background: rgba(255,255,255,0.2);
      padding: 2px 8px;
      border-radius: 12px;
    }
    .excel-grid-container {
      flex: 1;
      overflow: auto;
      background: #ffffff;
    }
    .excel-table {
      border-collapse: collapse;
      width: 100%;
      font-size: 12.5px;
      table-layout: auto;
    }
    .excel-col-header {
      background: #f3f4f6;
      border: 1px solid #d1d5db;
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 600;
      color: #64748b;
      text-align: center;
      position: sticky;
      top: 0;
      z-index: 2;
      user-select: none;
    }
    .excel-corner-header {
      background: #e2e8f0;
      border: 1px solid #d1d5db;
      width: 44px;
      position: sticky;
      top: 0;
      left: 0;
      z-index: 3;
    }
    .excel-row-num {
      background: #f3f4f6;
      border: 1px solid #d1d5db;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 600;
      color: #64748b;
      text-align: center;
      position: sticky;
      left: 0;
      z-index: 1;
      user-select: none;
      width: 44px;
    }
    .excel-cell {
      border: 1px solid #e2e8f0;
      padding: 6px 12px;
      color: #1e293b;
      white-space: nowrap;
      background: #ffffff;
    }
    .excel-cell.is-number {
      text-align: right;
      font-family: var(--font-mono, Consolas, monospace);
    }
    tr:hover .excel-cell {
      background: #f0fdf4;
    }
    .excel-sheet-bar {
      height: 32px;
      background: #e2e8f0;
      border-top: 1px solid #cbd5e1;
      display: flex;
      align-items: center;
      padding: 0 12px;
      gap: 8px;
      flex-shrink: 0;
    }
    .excel-sheet-tab {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-bottom: none;
      padding: 4px 14px;
      font-size: 11.5px;
      font-weight: 600;
      color: #107c41;
      border-top: 2px solid #107c41;
      border-radius: 3px 3px 0 0;
    }
  </style>
</head>
<body>
  <div class="excel-ribbon">
    <div class="excel-ribbon-left">
      <span class="excel-icon-badge">${iconBadge}</span>
      <span class="excel-file-title">${escapeHtml(filename)}</span>
      <span class="excel-badge">${badgeLabel}</span>
    </div>
    <span style="font-size: 12px; opacity: 0.85;">Grid View · ${rows.length} rows</span>
  </div>
  <div class="excel-grid-container">
    <table class="excel-table">
      <thead>
        <tr>
          <th class="excel-corner-header"></th>
          ${colLetters.map((col) => `<th class="excel-col-header">${col}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${tableRowsHtml}
      </tbody>
    </table>
  </div>
  <div class="excel-sheet-bar">
    <div class="excel-sheet-tab">📄 Sheet1</div>
    <span style="font-size: 11px; color: #64748b; margin-left: 8px;">Ready</span>
  </div>
</body>
</html>`;
}

export function formatPowerPointPresentationPreviewHtml(filename: string, text: string): string {
  // Split slides based on --- Slide X --- or Slide X: or double newlines
  const rawSections = text
    .split(/(?:^|\n)(?:---+\s*Slide\s*\d+\s*---+|\s*Slide\s+\d+:?)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  let slideContents = rawSections;
  if (slideContents.length <= 1 && text.includes("\n\n")) {
    const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length > 1) {
      slideContents = paragraphs;
    }
  }
  if (slideContents.length === 0) {
    slideContents = [text.trim() || "No slide content available."];
  }

  const slidesHtml = slideContents
    .map((content, idx) => {
      const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const title = lines[0] || `Slide ${idx + 1}`;
      const bodyLines = lines.slice(1);

      let bodyHtml = "";
      let inList = false;

      for (const line of bodyLines) {
        const isListItem = /^(?:[-*•]|\d+[.)])\s+/.test(line);
        if (isListItem) {
          if (!inList) {
            bodyHtml += `<ul class="ppt-bullet-list">`;
            inList = true;
          }
          const clean = line.replace(/^(?:[-*•]|\d+[.)])\s+/, "");
          bodyHtml += `<li>${escapeHtml(clean)}</li>`;
        } else {
          if (inList) {
            bodyHtml += `</ul>`;
            inList = false;
          }
          if (line.length < 50 && !line.includes(".") && !line.includes(",")) {
            bodyHtml += `<h4 class="ppt-sub-heading">${escapeHtml(line)}</h4>`;
          } else {
            bodyHtml += `<p class="ppt-paragraph">${escapeHtml(line)}</p>`;
          }
        }
      }
      if (inList) bodyHtml += `</ul>`;

      return `
      <div class="ppt-slide-card">
        <div class="ppt-slide-header">
          <div class="ppt-slide-num">Slide ${idx + 1} of ${slideContents.length}</div>
          <div class="ppt-slide-badge">PowerPoint Presentation</div>
        </div>
        <div class="ppt-slide-canvas">
          <h2 class="ppt-slide-title">${escapeHtml(title)}</h2>
          <div class="ppt-slide-body">
            ${bodyHtml || `<p class="ppt-paragraph">${escapeHtml(lines[0] || "")}</p>`}
          </div>
        </div>
        <div class="ppt-slide-footer">
          <span>Enterprise Confidential</span>
          <span>Slide ${idx + 1}</span>
        </div>
      </div>
    `;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(filename)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: #0f172a;
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif;
      color: #0f172a;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
    }
    .ppt-ribbon {
      width: 100%;
      background: #c43e1c;
      color: #ffffff;
      padding: 10px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .ppt-ribbon-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .ppt-icon-badge {
      background: #8e2b12;
      color: #ffffff;
      font-weight: 800;
      font-size: 13px;
      padding: 3px 8px;
      border-radius: 4px;
      letter-spacing: 0.05em;
    }
    .ppt-file-title {
      font-size: 14px;
      font-weight: 600;
      color: #ffffff;
    }
    .ppt-badge {
      font-size: 11px;
      background: rgba(255,255,255,0.2);
      padding: 2px 8px;
      border-radius: 12px;
    }
    .ppt-stage {
      padding: 36px 20px 60px;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 32px;
    }
    .ppt-slide-card {
      background: #ffffff;
      width: 100%;
      max-width: 860px;
      aspect-ratio: 16 / 9;
      min-height: 480px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 32px 48px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35), 0 1px 3px rgba(0,0,0,0.1);
      border-radius: 6px;
      position: relative;
    }
    .ppt-slide-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #c43e1c;
      padding-bottom: 8px;
      margin-bottom: 16px;
    }
    .ppt-slide-num {
      font-size: 11px;
      font-weight: 700;
      color: #c43e1c;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .ppt-slide-badge {
      font-size: 11px;
      color: #64748b;
    }
    .ppt-slide-canvas {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .ppt-slide-title {
      font-size: 26px;
      font-weight: 700;
      color: #0f172a;
      margin: 0 0 18px;
      line-height: 1.25;
    }
    .ppt-slide-body {
      flex: 1;
      font-size: 15px;
      line-height: 1.7;
      color: #334155;
    }
    .ppt-sub-heading {
      font-size: 17px;
      font-weight: 600;
      color: #c43e1c;
      margin: 16px 0 8px;
    }
    .ppt-paragraph {
      margin: 0 0 12px;
    }
    .ppt-bullet-list {
      margin: 8px 0 16px 24px;
      padding: 0;
    }
    .ppt-bullet-list li {
      margin-bottom: 8px;
      line-height: 1.6;
    }
    .ppt-slide-footer {
      border-top: 1px solid #e2e8f0;
      padding-top: 10px;
      margin-top: 16px;
      font-size: 11px;
      color: #94a3b8;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <div class="ppt-ribbon">
    <div class="ppt-ribbon-left">
      <span class="ppt-icon-badge">P</span>
      <span class="ppt-file-title">${escapeHtml(filename)}</span>
      <span class="ppt-badge">Microsoft PowerPoint Presentation (.pptx)</span>
    </div>
    <span style="font-size: 12px; opacity: 0.9;">Presentation View · ${slideContents.length} Slides</span>
  </div>
  <div class="ppt-stage">
    ${slidesHtml}
  </div>
</body>
</html>`;
}

export function formatPdfDocumentPreviewHtml(filename: string, text: string): string {
  // Split pages by [Page X] or --- Page X --- or form feed (\f)
  const pageSections = text
    .split(/(?:^|\n)(?:---+|\s*\[Page\s+\d+\]|\s*Page\s+\d+:?|\f)/i)
    .map((p) => p.trim())
    .filter(Boolean);

  const pages = pageSections.length > 0 ? pageSections : [text.trim() || "(No document text)"];

  const renderPdfTable = (rows: Array<[string, string]>): string => {
    const trs = rows
      .map(
        ([k, v]) =>
          `<tr><td class="pdf-key">${escapeHtml(k)}</td><td class="pdf-val">${escapeHtml(v)}</td></tr>`,
      )
      .join("");
    return `<table class="pdf-table">${trs}</table>`;
  };

  const pagesHtml = pages
    .map((pageText, pIdx) => {
      const lines = pageText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const title = lines[0] || `Page ${pIdx + 1}`;
      const restLines = lines.slice(1);

      let bodyHtml = "";
      const tableRows: Array<[string, string]> = [];

      for (let i = 0; i < restLines.length; i++) {
        const line = restLines[i];
        if (line.includes(":") && !line.startsWith("http")) {
          const colonIdx = line.indexOf(":");
          tableRows.push([line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim()]);
        } else if (line.includes("|")) {
          const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            tableRows.push([parts[0], parts.slice(1).join(" | ")]);
          } else {
            tableRows.push([line, ""]);
          }
        } else if (i + 1 < restLines.length && line.length < 35 && !line.includes(".")) {
          tableRows.push([line, restLines[i + 1]]);
          i++;
        } else {
          if (tableRows.length > 0) {
            bodyHtml += renderPdfTable(tableRows);
            tableRows.length = 0;
          }
          bodyHtml += `<p class="pdf-paragraph">${escapeHtml(line)}</p>`;
        }
      }
      if (tableRows.length > 0) {
        bodyHtml += renderPdfTable(tableRows);
      }

      return `
      <div class="pdf-page-sheet">
        <div class="pdf-page-header">
          <span class="pdf-doc-meta">${escapeHtml(filename)}</span>
          <span class="pdf-page-num">Page ${pIdx + 1} of ${pages.length}</span>
        </div>
        <div class="pdf-page-content">
          <h2 class="pdf-page-title">${escapeHtml(title)}</h2>
          <div class="pdf-page-body">
            ${bodyHtml}
          </div>
        </div>
        <div class="pdf-page-footer">
          <span>Enterprise Confidential Document</span>
          <span>Verified PDF · Nanvi Enterprise Assistant</span>
        </div>
      </div>
    `;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(filename)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: #525659;
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif;
      color: #0f172a;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
    }
    .pdf-ribbon {
      width: 100%;
      background: #b30b00;
      color: #ffffff;
      padding: 9px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .pdf-ribbon-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .pdf-icon-badge {
      background: #7a0800;
      color: #ffffff;
      font-weight: 800;
      font-size: 12px;
      padding: 3px 7px;
      border-radius: 4px;
      letter-spacing: 0.05em;
    }
    .pdf-file-title {
      font-size: 14px;
      font-weight: 600;
      color: #ffffff;
    }
    .pdf-badge {
      font-size: 11px;
      background: rgba(255,255,255,0.2);
      padding: 2px 8px;
      border-radius: 12px;
    }
    .pdf-stage {
      padding: 32px 20px 60px;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 28px;
    }
    .pdf-page-sheet {
      background: #ffffff;
      width: 100%;
      max-width: 820px;
      min-height: 1060px;
      aspect-ratio: 8.5 / 11;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 56px 64px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.1);
      border-radius: 2px;
    }
    .pdf-page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 10px;
      margin-bottom: 24px;
      font-size: 11.5px;
      color: #64748b;
    }
    .pdf-page-num {
      font-weight: 600;
      color: #b30b00;
    }
    .pdf-page-content {
      flex: 1;
    }
    .pdf-page-title {
      font-size: 22px;
      font-weight: 700;
      color: #0f172a;
      margin: 0 0 20px;
      line-height: 1.3;
      border-bottom: 2px solid #b30b00;
      padding-bottom: 10px;
    }
    .pdf-paragraph {
      font-size: 13.5px;
      line-height: 1.7;
      color: #334155;
      margin: 0 0 12px;
    }
    .pdf-table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0 24px;
      font-size: 13px;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      overflow: hidden;
    }
    .pdf-table td {
      padding: 8px 12px;
      border-bottom: 1px solid #e2e8f0;
      color: #1e293b;
    }
    .pdf-table td.pdf-key {
      font-weight: 600;
      color: #475569;
      width: 35%;
      background: #f8fafc;
      border-right: 1px solid #e2e8f0;
    }
    .pdf-table td.pdf-val {
      font-family: inherit;
    }
    .pdf-page-footer {
      border-top: 1px solid #e2e8f0;
      padding-top: 12px;
      margin-top: 24px;
      font-size: 11px;
      color: #94a3b8;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <div class="pdf-ribbon">
    <div class="pdf-ribbon-left">
      <span class="pdf-icon-badge">PDF</span>
      <span class="pdf-file-title">${escapeHtml(filename)}</span>
      <span class="pdf-badge">Portable Document Format</span>
    </div>
    <span style="font-size: 12px; opacity: 0.9;">PDF Reader · ${pages.length} Pages</span>
  </div>
  <div class="pdf-stage">
    ${pagesHtml}
  </div>
</body>
</html>`;
}

export function formatCodeDocumentPreviewHtml(filename: string, text: string): string {
  const ext = getExt(filename).toLowerCase().replace(".", "");
  const langLabel =
    {
      json: "JSON Document",
      jsonl: "JSON Lines",
      xml: "XML Data",
      yaml: "YAML Configuration",
      yml: "YAML Configuration",
      sql: "SQL Query / Schema",
      py: "Python Script",
      js: "JavaScript Source",
      ts: "TypeScript Source",
      tsx: "React TypeScript",
      jsx: "React JavaScript",
      css: "Stylesheet",
      sh: "Shell Script",
      bat: "Batch Script",
    }[ext] || `${ext.toUpperCase()} Source`;

  const lines = text.split(/\r?\n/);
  const numberedLinesHtml = lines
    .slice(0, 1000)
    .map(
      (l, idx) =>
        `<tr><td class="line-num">${idx + 1}</td><td class="line-code"><code>${escapeHtml(l) || "&nbsp;"}</code></td></tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(filename)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: #0f172a;
      font-family: Consolas, 'Fira Code', 'Courier New', monospace;
      color: #e2e8f0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .code-ribbon {
      width: 100%;
      background: #1e293b;
      color: #ffffff;
      padding: 9px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #334155;
      flex-shrink: 0;
    }
    .code-ribbon-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .code-icon-badge {
      background: #3b82f6;
      color: #ffffff;
      font-weight: 800;
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 4px;
      letter-spacing: 0.05em;
    }
    .code-file-title {
      font-size: 13.5px;
      font-weight: 600;
      color: #f8fafc;
    }
    .code-badge {
      font-size: 11px;
      background: rgba(255,255,255,0.1);
      color: #94a3b8;
      padding: 2px 8px;
      border-radius: 12px;
    }
    .code-container {
      flex: 1;
      overflow: auto;
      padding: 16px 0;
      background: #090d16;
    }
    table.code-table {
      border-collapse: collapse;
      width: 100%;
      font-size: 13px;
      line-height: 1.6;
    }
    td.line-num {
      width: 50px;
      min-width: 50px;
      text-align: right;
      padding: 0 16px 0 12px;
      color: #475569;
      user-select: none;
      vertical-align: top;
      border-right: 1px solid #1e293b;
    }
    td.line-code {
      padding: 0 16px;
      color: #e2e8f0;
      white-space: pre-wrap;
      word-break: break-all;
    }
    td.line-code code {
      font-family: inherit;
    }
    tr:hover td {
      background: rgba(255,255,255,0.03);
    }
    .code-footer {
      height: 28px;
      background: #1e293b;
      border-top: 1px solid #334155;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 14px;
      font-size: 11px;
      color: #94a3b8;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div class="code-ribbon">
    <div class="code-ribbon-left">
      <span class="code-icon-badge">${escapeHtml(ext.toUpperCase())}</span>
      <span class="code-file-title">${escapeHtml(filename)}</span>
      <span class="code-badge">${escapeHtml(langLabel)}</span>
    </div>
    <span style="font-size: 11.5px; color: #94a3b8;">${lines.length} lines</span>
  </div>
  <div class="code-container">
    <table class="code-table">
      <tbody>
        ${numberedLinesHtml}
      </tbody>
    </table>
  </div>
  <div class="code-footer">
    <span>UTF-8 · Enterprise Developer View</span>
    <span>Ready</span>
  </div>
</body>
</html>`;
}

export function formatTextDocumentPreviewHtml(filename: string, text: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(filename)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 24px 28px;
      background: #f8fafc;
      color: #1e293b;
      line-height: 1.6;
    }
    .paper {
      max-width: 860px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 28px 32px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    h2 {
      margin: 0 0 16px;
      font-size: 17px;
      color: #0f172a;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 8px;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: Consolas, "Courier New", monospace;
      font-size: 13px;
      line-height: 1.6;
      color: #334155;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="paper">
    <h2>📄 ${escapeHtml(filename)}</h2>
    <pre>${escapeHtml(text)}</pre>
  </div>
</body>
</html>`;
}

export async function buildLocalFilePreviewBlob(
  file: File,
  api?: NanviApiClient,
): Promise<{ blob: Blob; mimeType: string }> {
  const ext = getExt(file.name);
  const rawMime = inferBrowserFileMime(file.name, file.type);

  // 1. Native browser-rendered binary/media formats (PDF, images, video, audio, HTML)
  if (ext === ".pdf") {
    if (file.size > 0) {
      try {
        const slice = await file.slice(0, 1024).arrayBuffer();
        const header = new TextDecoder("latin1").decode(slice);
        if (header.includes("%PDF")) {
          return {
            blob: new Blob([file], { type: "application/pdf" }),
            mimeType: "application/pdf",
          };
        }
      } catch {
        // fallback to formatted document view
      }
    }
    const extracted = await extractTextFromBrowserFile(file, api);
    if (extracted) {
      const html = formatPdfDocumentPreviewHtml(file.name, extracted);
      return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mimeType: "text/html; charset=utf-8" };
    }
  }

  if (
    rawMime.startsWith("image/") ||
    rawMime.startsWith("video/") ||
    rawMime.startsWith("audio/") ||
    ext === ".html" ||
    ext === ".htm"
  ) {
    return {
      blob: file.type ? file : new Blob([file], { type: rawMime }),
      mimeType: rawMime,
    };
  }

  // 2. Microsoft Word documents (.docx, .doc, .rtf, .odt)
  if (ext === ".docx" || ext === ".doc" || ext === ".rtf" || ext === ".odt") {
    const extracted = await extractTextFromBrowserFile(file, api);
    if (extracted) {
      const html = formatWordDocumentPreviewHtml(file.name, extracted);
      return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mimeType: "text/html; charset=utf-8" };
    }
  }

  // 3. Microsoft Excel spreadsheets (.xlsx, .xlsm, .xls, .csv, .tsv, .ods)
  if (
    ext === ".xlsx" ||
    ext === ".xlsm" ||
    ext === ".xls" ||
    ext === ".csv" ||
    ext === ".tsv" ||
    ext === ".ods"
  ) {
    let extracted = "";
    if (ext === ".csv" || ext === ".tsv") {
      extracted =
        typeof file.text === "function"
          ? await file.text()
          : new TextDecoder("utf-8").decode(await file.arrayBuffer());
    } else {
      extracted = await extractTextFromBrowserFile(file, api);
    }
    if (extracted) {
      const html = formatExcelSpreadsheetPreviewHtml(file.name, extracted);
      return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mimeType: "text/html; charset=utf-8" };
    }
  }

  // 4. Microsoft PowerPoint presentations (.pptx, .ppt, .odp)
  if (ext === ".pptx" || ext === ".ppt" || ext === ".odp") {
    const extracted = await extractTextFromBrowserFile(file, api);
    if (extracted) {
      const html = formatPowerPointPresentationPreviewHtml(file.name, extracted);
      return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mimeType: "text/html; charset=utf-8" };
    }
  }

  // 5. Code & structured developer files (.json, .xml, .yaml, .sql, .py, .js, .ts, etc.)
  if (
    ext === ".json" ||
    ext === ".jsonl" ||
    ext === ".yaml" ||
    ext === ".yml" ||
    ext === ".xml" ||
    ext === ".sql" ||
    ext === ".py" ||
    ext === ".js" ||
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".jsx" ||
    ext === ".css" ||
    ext === ".sh" ||
    ext === ".bat"
  ) {
    const text =
      typeof file.text === "function"
        ? await file.text()
        : new TextDecoder("utf-8").decode(await file.arrayBuffer());
    const html = formatCodeDocumentPreviewHtml(file.name, text);
    return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mimeType: "text/html; charset=utf-8" };
  }

  // 6. Text, Markdown, and log files (.txt, .md, .markdown, .log, .rst)
  if (
    ext === ".txt" ||
    ext === ".md" ||
    ext === ".markdown" ||
    ext === ".log" ||
    ext === ".rst"
  ) {
    const text =
      typeof file.text === "function"
        ? await file.text()
        : new TextDecoder("utf-8").decode(await file.arrayBuffer());
    const html = formatTextDocumentPreviewHtml(file.name, text);
    return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mimeType: "text/html; charset=utf-8" };
  }

  // 6. Generic fallback: try text extraction if available, else return raw blob
  try {
    const extracted = await extractTextFromBrowserFile(file, api);
    if (extracted && extracted.trim()) {
      const html = formatTextDocumentPreviewHtml(file.name, extracted);
      return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mimeType: "text/html; charset=utf-8" };
    }
  } catch {
    // Ignore extraction failure
  }

  return {
    blob: file.type ? file : new Blob([file], { type: rawMime }),
    mimeType: rawMime,
  };
}

export async function getSavedBrowserHandleInfo(): Promise<{
  name: string;
  permission: PermissionState;
  handle: BrowserDirectoryHandle;
} | null> {
  const handle = await getSavedBrowserDirectoryHandle();
  if (!handle) return null;
  let permission: PermissionState = "prompt";
  try {
    if (typeof handle.queryPermission === "function") {
      permission = await handle.queryPermission({ mode: "read" });
    } else {
      permission = "granted";
    }
  } catch {
    permission = "prompt";
  }
  return { name: handle.name, permission, handle };
}

export async function restoreCachedBrowserFolder(
  api: NanviApiClient,
  onProgress?: (p: BrowserSyncProgress) => void,
  targetFolderName?: string,
): Promise<BrowserSyncResult | null> {
  return await runExclusiveSync(async () => {
    const folderName = targetFolderName || (await getLastCachedFolderName());
    if (!folderName) return null;
    const cached = await getCachedFolderIndex(folderName);
    if (!cached) return null;
    const cachedEntries = Object.values(cached.entries || {});
    if (cachedEntries.length === 0) return null;

    const validFiles: CollectedBrowserFile[] = cachedEntries.map((entry) => ({
      relativePath: entry.fileRecord.relative_path,
      file: {
        name: entry.fileRecord.filename,
        size: entry.size,
        lastModified: entry.lastModified,
      } as File,
    }));
    const allKnownPaths = new Set(validFiles.map((v) => v.relativePath));
    const snapshotMap = new Map(validFiles.map((v) => [v.relativePath, v.file?.lastModified ?? v.lastModified ?? 0]));

    return await syncCollectedFiles(
      api,
      {
        folderName,
        agentVersion: "browser-cache-1.0.0",
        totalFiles: validFiles.length,
        validFiles,
        allKnownPaths,
        snapshotMap,
        dirHandle: null,
      },
      onProgress,
      { skipIfBackendMatches: true },
    );
  });
}

let _desktopAutoRestorePromise: Promise<BrowserSyncResult | null> | null = null;
let _lastDesktopRestoreResult: {
  at: number;
  apiRef: unknown;
  folderKey: string;
  result: BrowserSyncResult | null;
} | null = null;

async function _runDesktopAutoRestore(
  api: NanviApiClient,
  options?: BrowserSyncOptions,
): Promise<BrowserSyncResult | null> {
  let saved = readStoredDesktopFolderMeta();
  if (!saved?.folderPath && window.electronAPI?.getPersistedDesktopFolder) {
    try {
      const diskMeta = await window.electronAPI.getPersistedDesktopFolder();
      if (diskMeta && diskMeta.folderPath) {
        const fullMeta: DesktopLocalFolderMeta = {
          folderId: diskMeta.folderPath,
          folderPath: diskMeta.folderPath,
          folderName: diskMeta.folderName || diskMeta.folderPath.split(/[/\\]/).pop() || "Local Folder",
          fileCount: diskMeta.fileCount ?? 0,
          chunkCount: 0,
          lastSyncedAt: diskMeta.lastSyncedAt || new Date().toISOString(),
        };
        saved = fullMeta;
        saveDesktopFolderMeta(fullMeta);
      }
    } catch {
      // ignore IPC error
    }
  }
  if (!saved?.folderPath) {
    return null;
  }

  const targetPath = normalizeDesktopFolderPath(saved.folderPath);

  // Zero-Upload fast-connect mode must never fall back to enumerating 10k+ files into IndexedDB
  if (window.electronAPI?.connectFolderFast) {
    try {
      const fast = await window.electronAPI.connectFolderFast(targetPath);
      if (fast?.ok && fast.folderPath) {
        return connectDesktopFolderDirect(fast.folderPath, fast.fileCount ?? saved.fileCount);
      }
    } catch {
      // keep existing metadata state without flooding Chromium IndexedDB
    }
    return null;
  }

  try {
    let entries: ElectronFolderFileEntry[] | undefined;
    if (window.electronAPI?.approveAndListFolderFiles) {
      const scan = await window.electronAPI.approveAndListFolderFiles(targetPath);
      if (scan?.ok && scan.entries) {
        entries = scan.entries;
      }
    }
    if ((!entries || entries.length === 0) && window.electronAPI?.listFolderFiles) {
      entries = await window.electronAPI.listFolderFiles(targetPath);
    }
    if (entries && entries.length > 0) {
      return await syncElectronFolder(api, targetPath, entries, undefined, {
        background: true,
        localOnly: true,
        ...options,
      });
    }
  } catch {
    // fall through
  }
  return null;
}

export async function autoRestoreBrowserFolderIfGranted(
  api: NanviApiClient,
  options?: BrowserSyncOptions,
): Promise<BrowserSyncResult | null> {
  // Desktop Zero-Upload auto-restore from persisted Windows folder path (zero upload / zero full pre-scan)
  if (typeof window !== "undefined" && window.electronAPI?.isDesktop) {
    const apiRef = window.electronAPI;
    const savedKey = normalizeDesktopFolderPath(readStoredDesktopFolderMeta()?.folderPath || "").toLowerCase();
    if (_desktopAutoRestorePromise) {
      return await _desktopAutoRestorePromise;
    }
    if (
      _lastDesktopRestoreResult &&
      _lastDesktopRestoreResult.apiRef === apiRef &&
      _lastDesktopRestoreResult.folderKey === savedKey &&
      Date.now() - _lastDesktopRestoreResult.at < 2000
    ) {
      return _lastDesktopRestoreResult.result;
    }
    const p = _runDesktopAutoRestore(api, options)
      .then((res) => {
        _lastDesktopRestoreResult = {
          at: Date.now(),
          apiRef,
          folderKey: savedKey,
          result: res,
        };
        return res;
      })
      .finally(() => {
        if (_desktopAutoRestorePromise === p) {
          _desktopAutoRestorePromise = null;
        }
      });
    _desktopAutoRestorePromise = p;
    return await p;
  }

  if (isFileSystemAccessSupported()) {
    const all = await getAllSavedBrowserHandles();
    let anyRestored: BrowserSyncResult | null = null;
    for (const item of all) {
      try {
        const granted = await verifyDirectoryPermission(item.handle, false);
        if (granted) {
          const res = await syncBrowserDirectory(api, item.handle, undefined, { skipIfBackendMatches: true, ...options });
          if (res && !anyRestored) anyRestored = res;
        }
      } catch {
        // fall through
      }
    }
    if (anyRestored) return anyRestored;
  }

  // Cross-browser (Firefox/Safari) & cached cold-start restore: restore all cached folders
  try {
    const cachedNames = await getAllCachedFolderNames();
    if (cachedNames.length > 0) {
      let anyRestored: BrowserSyncResult | null = null;
      for (const name of cachedNames) {
        try {
          const res = await restoreCachedBrowserFolder(api, undefined, name);
          if (res && !anyRestored) anyRestored = res;
        } catch {}
      }
      return anyRestored;
    }
    return await restoreCachedBrowserFolder(api);
  } catch {
    return null;
  }
}

export async function reconnectSavedBrowserFolder(
  api: NanviApiClient,
  onProgress?: (p: BrowserSyncProgress) => void,
  options?: BrowserSyncOptions,
): Promise<BrowserSyncResult | null> {
  const handle = await getSavedBrowserDirectoryHandle();
  if (handle) {
    const granted = await verifyDirectoryPermission(handle, true);
    if (!granted) {
      throw new Error("Folder read permission was not granted by browser.");
    }
    return await syncBrowserDirectory(api, handle, onProgress, { skipIfBackendMatches: true, ...options });
  }
  return await restoreCachedBrowserFolder(api, onProgress);
}

let activeWebkitCancel: (() => void) | null = null;

export function cancelPendingBrowserFolderPicker(): void {
  if (activeWebkitCancel) {
    const fn = activeWebkitCancel;
    activeWebkitCancel = null;
    fn();
  }
}

export function pickAndSyncWebkitDirectory(
  api: NanviApiClient,
  onProgress?: (p: BrowserSyncProgress) => void,
  options?: BrowserSyncOptions,
): Promise<BrowserSyncResult | null> {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("Folder selection is not supported in this environment."));
  }
  const dirSupported = isDirectoryInputSupported();

  if (activeWebkitCancel) {
    activeWebkitCancel();
    activeWebkitCancel = null;
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (dirSupported) {
      (input as HTMLInputElement & { webkitdirectory?: boolean; directory?: boolean }).webkitdirectory = true;
      (input as HTMLInputElement & { directory?: boolean }).directory = true;
      input.setAttribute("webkitdirectory", "");
    } else {
      // iOS / iPadOS Safari does not support directory selection; allow selecting multiple documents cleanly
      input.accept = Array.from(SUPPORTED_EXTENSIONS).join(",");
    }
    // Off-screen but rendered so Firefox/Safari honor activation and confirmation prompts
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "0";
    input.style.width = "1px";
    input.style.height = "1px";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";

    let settled = false;
    const cancelPending = () => {
      if (settled) return;
      settled = true;
      if (activeWebkitCancel === cancelPending) {
        activeWebkitCancel = null;
      }
      if (input.parentNode) input.parentNode.removeChild(input);
      resolve(null);
    };
    activeWebkitCancel = cancelPending;

    const cleanup = () => {
      if (activeWebkitCancel === cancelPending) {
        activeWebkitCancel = null;
      }
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    input.addEventListener("cancel", cancelPending, { once: true });

    input.addEventListener(
      "change",
      () => {
        if (settled) return;
        settled = true;
        const files = input.files;
        cleanup();
        if (!files || files.length === 0) {
          resolve(null);
          return;
        }
        syncWebkitFileList(api, files, onProgress, options).then(resolve, reject);
      },
      { once: true },
    );

    document.body.appendChild(input);
    input.click();
  });
}

export async function pickAndSyncBrowserFolder(
  api: NanviApiClient,
  onProgress?: (p: BrowserSyncProgress) => void,
  options?: BrowserSyncOptions,
): Promise<BrowserSyncResult | null> {
  if (!isFileSystemAccessSupported()) {
    if (typeof document !== "undefined") {
      return await pickAndSyncWebkitDirectory(api, onProgress, options);
    }
    throw new Error("Browser Folder Access requires Chrome, Edge, Firefox, or Safari.");
  }

  const picker = (window as unknown as {
    showDirectoryPicker: (opts?: BrowserPermissionDescriptor) => Promise<BrowserDirectoryHandle>;
  }).showDirectoryPicker;

  try {
    const dirHandle = await picker({ mode: "read" });
    return await syncBrowserDirectory(api, dirHandle, onProgress, options);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return null;
    }
    throw err;
  }
}

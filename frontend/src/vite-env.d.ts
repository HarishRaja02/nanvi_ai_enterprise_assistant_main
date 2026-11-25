/// <reference types="vite/client" />

interface ElectronFolderFileEntry {
  absPath: string;
  relativePath: string;
  name: string;
  size: number;
  lastModified: number;
}

interface ElectronAPI {
  isDesktop: boolean;
  platform: string;
  selectFolder: () => Promise<string | null>;
  listFolderFiles?: (folderPath: string) => Promise<ElectronFolderFileEntry[]>;
  approveAndListFolderFiles?: (folderPath: string) => Promise<{
    ok: boolean;
    folderPath?: string;
    entries?: ElectronFolderFileEntry[];
    error?: string;
  }>;
  connectFolderFast?: (folderPath: string) => Promise<{
    ok: boolean;
    folderPath?: string;
    fileCount?: number;
    error?: string;
  }>;
  searchDesktopFolder?: (
    folderPath: string,
    query: string,
    topChunksLimit?: number,
    topFilesLimit?: number,
    options?: {
      offset?: number;
      userId?: string;
      role?: string;
      roles?: string[];
      department?: string | null;
      tenantId?: string;
    },
  ) => Promise<{
    folder_path: string;
    files: Array<{
      name: string;
      path: string;
      full_path: string;
      display_path: string;
      type: string;
      open_url: string;
      source: string;
      match_type?: string;
      content_snippet?: string;
    }>;
    chunks: Array<{
      chunk_id: string;
      folder_path: string;
      relative_path: string;
      filename: string;
      citation: string;
      text: string;
      engine?: string;
      score?: number;
    }>;
    total_matches?: number;
    offset?: number;
    page_size?: number;
    has_more?: boolean;
    all_ranked_files?: Array<{
      name: string;
      path: string;
      full_path: string;
      display_path: string;
      type: string;
      open_url: string;
      source: string;
      match_type?: string;
      content_snippet?: string;
    }>;
    structured_summary?: string;
    aggregated_entities?: Record<string, unknown>;
    folder_stats?: { total_files: number; categories: Record<string, number> };
    zero_match?: boolean;
    elapsed_ms?: number;
    engines_used?: string[];
    degraded_engines?: string[];
    offline_mode?: boolean;
    generation_mode?: string;
    semantic_model_ready?: boolean;
  } | null>;
  getSearchSidecarStatus?: (folderPath?: string | null) => Promise<Record<string, unknown>>;
  getPersistedDesktopFolder?: () => Promise<{
    folderPath: string;
    folderName: string;
    fileCount?: number;
    lastSyncedAt?: string;
  } | null>;
  savePersistedDesktopFolder?: (meta: {
    folderPath: string;
    folderName: string;
    fileCount?: number;
    lastSyncedAt?: string;
  } | null) => Promise<boolean>;
  onFolderCountUpdated?: (
    callback: (payload: { folderPath: string; fileCount: number }) => void,
  ) => () => void;
  revokeApprovedFolder?: (folderPath?: string) => Promise<boolean>;
  readFileBytes?: (filePath: string) => Promise<Uint8Array | null>;
  openPath?: (filePath: string) => Promise<{ success?: boolean; error?: string }>;
  showItemInFolder?: (filePath: string) => Promise<boolean>;
  showNotification: (title: string, body: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
  onAccountBlocked: (callback: () => void) => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}

interface ImportMetaEnv {
  /** "true" enables development sign-in (demo accounts). Must be "false" in production builds. */
  readonly VITE_DEMO_MODE?: string;
  /** Fully-qualified company SSO authorization URL, configured per deployment. */
  readonly VITE_SSO_LOGIN_URL?: string;
  /** Build target: "desktop" when bundled inside Electron, otherwise undefined/empty for web. */
  readonly VITE_APP_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

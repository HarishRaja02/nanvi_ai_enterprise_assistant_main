import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { NanviApiClient, LocalAgentStatusResponse } from "../../api";
import { useToast } from "./Toast";
import { FolderConnectModal, type PreviewableFolderFile } from "./FolderConnectModal";
import {
  autoRestoreBrowserFolderIfGranted,
  cancelPendingBrowserFolderPicker,
  clearDesktopLocalFolder,
  clearSavedBrowserDirectoryHandle,
  connectDesktopFolderDirect,
  extractDroppedFoldersFromDataTransfer,
  getAllCachedFolderNames,
  getBrowserFolderMode,
  getBrowserFolderRealPath,
  getCachedBrowserIndexSummary,
  getCachedFolderFilesPreview,
  getDesktopLocalStatus,
  getLastCachedFolderName,
  getSavedBrowserHandleInfo,
  pickAndSyncBrowserFolder,
  reconnectSavedBrowserFolder,
  setBrowserFolderRealPath,
  syncDroppedFolder,
  syncElectronFolder,
  type BrowserSyncProgress,
  type DroppedFolderCandidate,
} from "../../lib/browserFolderSync";

type Props = {
  api: NanviApiClient;
};

export function CompanyFolderPicker({ api }: Props) {
  const notify = useToast();
  const isDesktop =
    typeof window !== "undefined" &&
    (Boolean(window.electronAPI?.isDesktop) || window.location.protocol === "file:");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Local Agent & Cross-Browser Folder Access state
  const [agentStatus, setAgentStatus] = useState<LocalAgentStatusResponse | null>(() =>
    isDesktop ? (getDesktopLocalStatus() as LocalAgentStatusResponse | null) : null
  );
  const browserMode = getBrowserFolderMode();
  const browserSupported = browserMode !== "unsupported";
  const [connectMethod, setConnectMethod] = useState<"browse" | "manual">(
    isDesktop || browserSupported ? "browse" : "manual"
  );
  const [savedBrowserFolder, setSavedBrowserFolder] = useState<{
    name: string;
    permission: PermissionState;
    cachedFiles?: number;
  } | null>(null);
  const [browserSyncProgress, setBrowserSyncProgress] = useState<BrowserSyncProgress | null>(null);
  const [customLocalFolder, setCustomLocalFolder] = useState("");
  const [addingFolder, setAddingFolder] = useState(false);
  const [browsingFolder, setBrowsingFolder] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [addFolderMsg, setAddFolderMsg] = useState<string | null>(null);
  const [browserRealPathInput, setBrowserRealPathInput] = useState("");
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderModalMode, setFolderModalMode] = useState<"connect" | "preview">("connect");
  const [droppedCandidates, setDroppedCandidates] = useState<DroppedFolderCandidate[]>([]);
  const [confirmingDropConnect, setConfirmingDropConnect] = useState(false);
  const [cardDragOver, setCardDragOver] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<{ name: string; path: string }>({ name: "", path: "" });
  const [previewFiles, setPreviewFiles] = useState<PreviewableFolderFile[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  const rapidPollRef = useRef<number | null>(null);
  const lastDispatchedRef = useRef<string>("");

  const fetchStatus = useCallback(async () => {
    const dispatchIfChanged = (res: LocalAgentStatusResponse) => {
      const primary = res.connected_folders && res.connected_folders.length > 0 ? res.connected_folders[0] : null;
      const path = primary ? primary.folder_path : "";
      const exists = Boolean(primary);
      const folder_count = res.connected_folders ? res.connected_folders.length : 0;
      const file_count = res.total_files || 0;
      const signature = `${path}|${exists}|${folder_count}|${file_count}`;

      if (lastDispatchedRef.current !== signature) {
        lastDispatchedRef.current = signature;
        window.dispatchEvent(
          new CustomEvent("nanvi:company-folder-updated", {
            detail: { path, exists, folder_count, file_count },
          })
        );
      }
    };

    if (isDesktop && window.electronAPI?.connectFolderFast) {
      const desktopLocal = getDesktopLocalStatus() as LocalAgentStatusResponse | null;
      const res: LocalAgentStatusResponse =
        desktopLocal && desktopLocal.connected_folders.length > 0
          ? desktopLocal
          : {
              is_online: true,
              last_heartbeat: new Date().toISOString(),
              agent_version: "desktop-local-only",
              connected_folders: [],
              total_files: 0,
              total_chunks: 0,
            };
      setAgentStatus(res);
      dispatchIfChanged(res);
      return res;
    }

    try {
      const remoteRes = await api.getLocalAgentStatus();
      const desktopLocal = isDesktop ? (getDesktopLocalStatus() as LocalAgentStatusResponse | null) : null;
      const res =
        desktopLocal && desktopLocal.connected_folders.length > 0 && (!remoteRes.connected_folders || remoteRes.connected_folders.length === 0)
          ? desktopLocal
          : remoteRes;
      setAgentStatus(res);
      dispatchIfChanged(res);
      return res;
    } catch {
      const desktopLocal = isDesktop ? (getDesktopLocalStatus() as LocalAgentStatusResponse | null) : null;
      if (desktopLocal && desktopLocal.connected_folders.length > 0) {
        setAgentStatus(desktopLocal);
        dispatchIfChanged(desktopLocal);
        return desktopLocal;
      }
      return null;
    }
  }, [api, isDesktop]);

  const applyOptimisticConnectedFolder = useCallback(
    (folderId: string, folderPath: string, folderName: string, fileCount: number, chunkCount: number) => {
      setAgentStatus((prev) => {
        const existing = prev?.connected_folders || [];
        const normId = folderId.replace(/\\/g, "/").toLowerCase();
        const normPath = folderPath.replace(/\\/g, "/").toLowerCase();
        const others = existing.filter((f) => {
          const fid = (f.folder_id || "").replace(/\\/g, "/").toLowerCase();
          const fp = (f.folder_path || "").replace(/\\/g, "/").toLowerCase();
          return fid !== normId && fp !== normPath;
        });
        const currentFolder = {
          folder_id: folderId,
          folder_path: folderPath,
          display_name: folderName,
          file_count: fileCount,
          chunk_count: chunkCount,
          status: "synced" as const,
          last_synced_at: new Date().toISOString(),
        };
        const updated = [...others, currentFolder];
        return {
          is_online: true,
          last_heartbeat: new Date().toISOString(),
          agent_version: prev?.agent_version || "browser-fs-1.0.0",
          connected_folders: updated,
          total_files: updated.reduce((s, f) => s + (f.file_count || 0), 0),
          total_chunks: updated.reduce((s, f) => s + (f.chunk_count || 0), 0),
        };
      });
    },
    [],
  );

  // Refresh quietly when background folder streaming publishes new waves or finishes
  useEffect(() => {
    let lastRefresh = 0;
    const onBgFolderUpdated = () => {
      const now = Date.now();
      if (now - lastRefresh < 1500) return;
      lastRefresh = now;
      void fetchStatus();
    };
    window.addEventListener("nanvi:company-folder-updated", onBgFolderUpdated);
    return () => window.removeEventListener("nanvi:company-folder-updated", onBgFolderUpdated);
  }, [fetchStatus]);

  // Initial load + inspect IndexedDB saved browser directory handle
  useEffect(() => {
    let cancelled = false;
    const safetyTimer = window.setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 2500);
    fetchStatus().finally(() => {
      window.clearTimeout(safetyTimer);
      if (!cancelled) setLoading(false);
    });
    if (isDesktop) {
      void autoRestoreBrowserFolderIfGranted(api).then((restored) => {
        if (!cancelled && restored) {
          void fetchStatus();
        }
      });
    } else if (browserSupported) {
      void (async () => {
        const info = browserMode === "fs-access" ? await getSavedBrowserHandleInfo() : null;
        if (cancelled) return;
        if (info) {
          const cached = await getCachedBrowserIndexSummary(info.name);
          if (cancelled) return;
          setSavedBrowserFolder({
            name: info.name,
            permission: info.permission,
            cachedFiles: cached?.fileCount,
          });
          setBrowserRealPathInput(getBrowserFolderRealPath(info.name));
          if (info.permission === "granted") {
            const restored = await autoRestoreBrowserFolderIfGranted(api, { background: true });
            if (!cancelled && restored) {
              setSavedBrowserFolder({
                name: restored.folderName,
                permission: "granted",
                cachedFiles: restored.fileCount,
              });
              void fetchStatus();
            }
          }
          return;
        }

        // Firefox / Safari cached folders check (restore all cached folders)
        const cachedNames = await getAllCachedFolderNames();
        if (cancelled) return;
        if (cachedNames.length > 0) {
          const primaryName = cachedNames[0];
          const cached = await getCachedBrowserIndexSummary(primaryName);
          if (!cancelled && cached) {
            setSavedBrowserFolder({
              name: primaryName,
              permission: "granted",
              cachedFiles: cached.fileCount,
            });
            setBrowserRealPathInput(getBrowserFolderRealPath(primaryName));
          }
          const restored = await autoRestoreBrowserFolderIfGranted(api, { background: true });
          if (!cancelled && restored) {
            void fetchStatus();
          }
          return;
        }

        const lastName = await getLastCachedFolderName();
        if (cancelled || !lastName) return;
        const cached = await getCachedBrowserIndexSummary(lastName);
        if (cancelled || !cached) return;
        setSavedBrowserFolder({
          name: lastName,
          permission: "granted",
          cachedFiles: cached.fileCount,
        });
        const restored = await autoRestoreBrowserFolderIfGranted(api, { background: true });
        if (!cancelled && restored) {
          void fetchStatus();
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [api, browserMode, browserSupported, fetchStatus, isDesktop]);

  // Polling: 15s when waiting for connection, 30s when online and idle (paused when tab is hidden)
  useEffect(() => {
    let timer: NodeJS.Timeout;

    const scheduleNext = () => {
      const isOnline = Boolean(agentStatus?.is_online);
      const delay = isOnline ? 30000 : 15000;
      timer = setTimeout(() => {
        if (typeof document !== "undefined" && document.hidden) {
          scheduleNext();
          return;
        }
        void fetchStatus().then(() => {
          scheduleNext();
        });
      }, delay);
    };

    scheduleNext();

    // Re-check quietly on tab visibility
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchStatus();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchStatus, agentStatus?.is_online]);

  // Start temporary rapid polling (1s interval) for 8 seconds after an action
  const triggerRapidPoll = useCallback(() => {
    if (rapidPollRef.current) clearInterval(rapidPollRef.current);
    let count = 0;
    const interval = window.setInterval(() => {
      count++;
      void fetchStatus();
      if (count >= 8) {
        clearInterval(interval);
        rapidPollRef.current = null;
      }
    }, 1000);
    rapidPollRef.current = interval;
  }, [fetchStatus]);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    setMessage(null);
    try {
      await fetchStatus();
      setMessage({ text: "Status refreshed.", type: "success" });
      notify("Folder status refreshed.", "info");
    } catch {
      const msg = "Could not refresh status.";
      setMessage({ text: msg, type: "error" });
      notify(msg, "danger");
    } finally {
      setRefreshing(false);
    }
  };

  const handleDisconnectFolder = async (folderId: string) => {
    if (!folderId) return;
    setDisconnectingId(folderId);
    setMessage(null);

    // Optimistically update local UI state immediately
    const norm = folderId.replace(/\\/g, "/").toLowerCase();
    const baseNorm = norm.split("/").pop() || norm;
    let remainingFolders: NonNullable<typeof agentStatus>["connected_folders"] = [];
    setAgentStatus((prev) => {
      if (!prev) return prev;
      const updated = (prev.connected_folders || []).filter((f) => {
        const fId = (f.folder_id || "").replace(/\\/g, "/").toLowerCase();
        const fPath = (f.folder_path || "").replace(/\\/g, "/").toLowerCase();
        const fBase = fPath.split("/").pop() || fPath;
        if (fId === norm || fPath === norm || fBase === baseNorm || fId === baseNorm) return false;
        if (norm && (fId.includes(norm) || fPath.includes(norm) || norm.includes(fId) || norm.includes(fPath))) return false;
        return true;
      });
      remainingFolders = updated;
      return {
        ...prev,
        connected_folders: updated,
        total_files: updated.length === 0 ? 0 : updated.reduce((acc, x) => acc + (x.file_count || 0), 0),
        total_chunks: updated.length === 0 ? 0 : updated.reduce((acc, x) => acc + (x.chunk_count || 0), 0),
      };
    });

    // Notify the rest of the application (TopBar, ContextPanel, Sidebar)
    const remCount = remainingFolders.length;
    const remFiles = remainingFolders.reduce((acc, x) => acc + (x.file_count || 0), 0);
    const remPath = remCount > 0 ? (remainingFolders[0].folder_path || "") : "";
    lastDispatchedRef.current = `${remPath}|${remCount > 0}|${remCount}|${remFiles}`;
    window.dispatchEvent(
      new CustomEvent("nanvi:company-folder-updated", {
        detail: { path: remPath, exists: remCount > 0, folder_count: remCount, file_count: remFiles },
      })
    );

    try {
      if (isDesktop) {
        await clearDesktopLocalFolder(folderId);
      }
      await api.removeLocalFolder(folderId);
      if (folderId.startsWith("browser://") || savedBrowserFolder) {
        const fName = folderId.replace(/^browser:\/\//, "");
        await clearSavedBrowserDirectoryHandle(fName);
        if (savedBrowserFolder?.name === fName) {
          const remaining = (agentStatus?.connected_folders || []).filter((f) => {
            const fid = (f.folder_id || "").replace(/^browser:\/\//, "");
            const fdisp = f.display_name || "";
            return fid !== fName && fdisp !== fName;
          });
          if (remaining.length > 0) {
            const next = remaining[0];
            const nextName = next.display_name || next.folder_path.replace(/^browser:\/\//, "");
            setSavedBrowserFolder({
              name: nextName,
              permission: "granted",
              cachedFiles: next.file_count,
            });
            setBrowserRealPathInput(getBrowserFolderRealPath(nextName));
          } else {
            setSavedBrowserFolder(null);
            setBrowserRealPathInput("");
          }
        }
        setBrowserSyncProgress(null);
      }
      await fetchStatus();
      triggerRapidPoll();
      setMessage({ text: "✓ Folder removed and disconnected successfully.", type: "success" });
      notify("Folder removed and disconnected successfully.", "success");
    } catch (err: any) {
      await fetchStatus();
      const errMsg = err?.message || "Failed to disconnect folder.";
      setMessage({
        text: errMsg,
        type: "error",
      });
      notify(errMsg, "danger");
    } finally {
      setDisconnectingId(null);
    }
  };

  const connectDesktopFolder = async (targetPath: string, preApproved: boolean): Promise<boolean> => {
    // 1. Direct Instant Desktop Local Folder Connect (0 upload, 0 pre-extraction, 0 network blocking)
    if (window.electronAPI?.connectFolderFast) {
      const fast = await window.electronAPI.connectFolderFast(targetPath);
      if (!fast.ok || !fast.folderPath) {
        const msg = fast.error || `Cannot access folder '${targetPath}'.`;
        setAddFolderMsg(msg);
        notify(msg, "danger");
        return false;
      }
      const fastRes = connectDesktopFolderDirect(fast.folderPath, fast.fileCount || 0);
      const curFolders = agentStatus?.connected_folders || [];
      const isExisting = curFolders.some((f) => f.folder_path === fastRes.folderId || f.folder_id === fastRes.folderId);
      const newFolderCount = isExisting ? curFolders.length : curFolders.length + 1;
      const otherFiles = curFolders.filter((f) => f.folder_path !== fastRes.folderId && f.folder_id !== fastRes.folderId).reduce((s, f) => s + (f.file_count || 0), 0);
      const totalFiles = otherFiles + fastRes.fileCount;
      lastDispatchedRef.current = `${fastRes.folderId}|true|${newFolderCount}|${totalFiles}`;
      applyOptimisticConnectedFolder(
        fastRes.folderId,
        fastRes.folderId,
        fastRes.folderName,
        fastRes.fileCount,
        0,
      );
      setAddFolderMsg(
        `✓ Connected '${fastRes.folderName}' (${fastRes.fileCount} files) — Direct local access (no cloud upload).`,
      );
      notify(`Connected folder '${fastRes.folderName}' (${fastRes.fileCount} files).`, "success");
      return true;
    }

    let resolvedTarget = targetPath;
    let preScannedEntries: any[] | null = null;

    if (!preApproved && window.electronAPI?.approveAndListFolderFiles) {
      const scan = await window.electronAPI.approveAndListFolderFiles(targetPath);
      if (!scan.ok || !scan.folderPath) {
        const msg = scan.error || `Cannot access folder '${targetPath}'.`;
        setAddFolderMsg(msg);
        notify(msg, "danger");
        return false;
      }
      resolvedTarget = scan.folderPath;
      preScannedEntries = scan.entries || [];
    }

    let res: any = { indexed_locally: false };
    try {
      res = await api.addLocalFolder(resolvedTarget);
    } catch {
      res = { indexed_locally: false };
    }
    const addedPath = res.folder_path || resolvedTarget;
    const serverIndexed =
      res.indexed_locally === true && typeof res.file_count === "number";

    if (serverIndexed) {
      const fileCnt = Number(res.file_count || 0);
      const curFolders = agentStatus?.connected_folders || [];
      const isExisting = curFolders.some((f) => f.folder_path === addedPath || f.folder_id === addedPath);
      const newFolderCount = isExisting ? curFolders.length : curFolders.length + 1;
      const otherFiles = curFolders.filter((f) => f.folder_path !== addedPath && f.folder_id !== addedPath).reduce((s, f) => s + (f.file_count || 0), 0);
      const totalFiles = otherFiles + fileCnt;
      lastDispatchedRef.current = `${addedPath}|true|${newFolderCount}|${totalFiles}`;
      const okMsg = res.message || `✓ Folder '${addedPath}' linked to Nanvi Assistant.`;
      setAddFolderMsg(okMsg);
      notify(`Folder '${addedPath}' linked to Nanvi Assistant.`, "success");
      window.dispatchEvent(
        new CustomEvent("nanvi:company-folder-updated", {
          detail: { path: addedPath, exists: true, folder_count: newFolderCount, file_count: totalFiles },
        })
      );
      applyOptimisticConnectedFolder(addedPath, addedPath, addedPath.split(/[/\\]/).pop() || addedPath, fileCnt, 0);
      return true;
    }

    if (window.electronAPI?.listFolderFiles) {
      const entries = preScannedEntries ?? (await window.electronAPI.listFolderFiles(resolvedTarget));
      if (!entries || entries.length === 0) {
        setBrowserSyncProgress(null);
        const msg = `No supported documents found inside '${resolvedTarget}'.`;
        setAddFolderMsg(msg);
        notify(msg, "warning");
        return false;
      }
      // Desktop Zero-Upload Mode: keep folder files/chunks strictly on this Windows PC (0 cloud DB uploads)
      const syncRes = await syncElectronFolder(api, resolvedTarget, entries, undefined, {
        background: true,
        localOnly: true,
      });
      setBrowserSyncProgress(null);
      if (syncRes) {
        const curFolders = agentStatus?.connected_folders || [];
        const isExisting = curFolders.some((f) => f.folder_path === resolvedTarget || f.folder_id === resolvedTarget);
        const newFolderCount = isExisting ? curFolders.length : curFolders.length + 1;
        const otherFiles = curFolders.filter((f) => f.folder_path !== resolvedTarget && f.folder_id !== resolvedTarget).reduce((s, f) => s + (f.file_count || 0), 0);
        const totalFiles = otherFiles + syncRes.fileCount;
        lastDispatchedRef.current = `${resolvedTarget}|true|${newFolderCount}|${totalFiles}`;
        applyOptimisticConnectedFolder(
          syncRes.folderId,
          resolvedTarget,
          syncRes.folderName,
          syncRes.fileCount,
          syncRes.chunkCount,
        );
        window.dispatchEvent(
          new CustomEvent("nanvi:company-folder-updated", {
            detail: { path: resolvedTarget, exists: true, folder_count: newFolderCount, file_count: totalFiles },
          })
        );
        setAddFolderMsg(
          `✓ Connected '${syncRes.folderName}' (${syncRes.fileCount} files) — Direct local access (no cloud upload).`,
        );
        notify(`Connected folder '${syncRes.folderName}' (${syncRes.fileCount} files).`, "success");
        return true;
      }
      const msg = `No supported documents found inside '${resolvedTarget}'.`;
      setAddFolderMsg(msg);
      notify(msg, "warning");
      return false;
    }

    setAddFolderMsg(
      `Saved path reference '${addedPath}', but this cloud server cannot read files directly from your local drive. Use Method 1 (Connect Local Folder) to index files securely.`
    );
    return false;
  };

  const handleAddLocalFolder = async (pathToAdd?: string) => {
    let raw = (pathToAdd || customLocalFolder).trim();
    if (!raw) return;

    let clean = raw.replace(/^['"“”`]|['"“”`]$/g, "").trim();
    for (const prefix of [
      "nanvi-agent add",
      "nanvi local agent add",
      "nanvi add",
      "python nanvi_local_agent.py add",
      "python nanvi_gui_agent.py add",
      "python local_agent.py add",
      "python add",
      "add folder",
      "add path",
      "add:",
      "add",
    ]) {
      if (clean.toLowerCase().startsWith(prefix + " ") || clean.toLowerCase() === prefix) {
        clean = clean.slice(prefix.length).trim().replace(/^['"“”`]|['"“”`]$/g, "").trim();
        break;
      }
    }
    clean = clean.replace(/^['"“”`:]|['"“”`:]$/g, "").trim();
    if (!clean) return;

    // Block any accidental server-side paths
    if (clean.toLowerCase().includes("/var/task") || clean.toLowerCase().includes("var/task")) {
      setAddFolderMsg("Server path /var/task/CompanyData is disabled. Please select a local folder from your computer.");
      return;
    }

    setAddingFolder(true);
    setAddFolderMsg(null);
    try {
      const ok = await connectDesktopFolder(clean, false);
      if (ok) {
        setCustomLocalFolder("");
      }
      if (!window.electronAPI?.connectFolderFast) {
        await fetchStatus();
        triggerRapidPoll();
      }
    } catch (err: any) {
      setBrowserSyncProgress(null);
      setAddFolderMsg(`Error: ${err?.message || "Failed to add folder"}`);
    } finally {
      setAddingFolder(false);
    }
  };

  const runBrowserDevicePicker = async () => {
    // Direct Browser Folder Access (Chrome/Edge File System API + Firefox/Safari webkitdirectory)
    if (browserSupported) {
      setBrowsingFolder(true);
      setAddFolderMsg(null);
      if (browserMode === "webkitdirectory" || browserMode === "file-picker") {
        setBrowserSyncProgress({
          phase: "scanning",
          scannedFiles: 0,
          indexedFiles: 0,
          totalFiles: 0,
          totalChunks: 0,
          message:
            browserMode === "webkitdirectory"
              ? "Select your folder, then click 'Upload' if your browser asks to confirm..."
              : "Select documents from Apple Files or iCloud Drive...",
        });
      } else {
        setBrowserSyncProgress(null);
      }
      try {
        const result = await pickAndSyncBrowserFolder(api, undefined, { background: true });
        setBrowserSyncProgress(null);
        if (!result) {
          setAddFolderMsg("Folder selection was canceled.");
          return;
        }
        const effectivePath = getBrowserFolderRealPath(result.folderName) || result.folderName;
        setSavedBrowserFolder({
          name: result.folderName,
          permission: "granted",
          cachedFiles: result.fileCount,
        });
        applyOptimisticConnectedFolder(
          result.folderId,
          effectivePath,
          result.folderName,
          result.fileCount,
          result.chunkCount,
        );
        setFolderModalOpen(false);
        setDroppedCandidates([]);
        setAddFolderMsg(
          `✓ Connected '${result.folderName}' (${result.fileCount} files) — Ready to search.`,
        );
        notify(`Connected folder '${result.folderName}' (${result.fileCount} files).`, "success");
        void fetchStatus();
        triggerRapidPoll();
      } catch (err: any) {
        setBrowserSyncProgress(null);
        const errMsg = err?.message || "Please grant folder permission or use Method 2 (Manual Path Input).";
        setAddFolderMsg(`Error accessing folder: ${errMsg}`);
        notify(`Error accessing folder: ${errMsg}`, "danger");
      } finally {
        setBrowsingFolder(false);
      }
      return;
    }

    // Fallback for environments without browser picker: backend / remote agent dialog
    setBrowsingFolder(true);
    setAddFolderMsg(null);
    try {
      const res = await api.browseLocalFolder();
      if (res.status === "ok" && res.folder_path) {
        setCustomLocalFolder(res.folder_path);
        setFolderModalOpen(false);
        setAddFolderMsg(res.message || `✓ Folder '${res.folder_path}' linked to Nanvi Assistant.`);
        window.dispatchEvent(
          new CustomEvent("nanvi:company-folder-updated", {
            detail: { path: res.folder_path, exists: true, folder_count: 1, file_count: (res as any).file_count || 1 },
          })
        );
        await fetchStatus();
        triggerRapidPoll();
      } else if (res.status === "canceled") {
        setAddFolderMsg(res.message || "Folder selection was canceled.");
      } else {
        setAddFolderMsg(res.message || "✓ Windows Explorer Folder Picker launched. Please choose your folder.");
        triggerRapidPoll();
      }
    } catch (err: any) {
      setAddFolderMsg(`Error opening folder browser: ${err?.message || "Failed to trigger folder browser. Please use Method 2 (Manual Path Input)."}`);
    } finally {
      setTimeout(() => setBrowsingFolder(false), 2000);
    }
  };

  const handleBrowseFolder = async () => {
    // 1. Native Desktop File Picker (when running in Electron Desktop Application)
    if (typeof window !== "undefined" && window.electronAPI?.selectFolder) {
      setBrowsingFolder(true);
      setAddFolderMsg(null);
      try {
        const selected = await window.electronAPI.selectFolder();
        if (selected) {
          setCustomLocalFolder(selected);
          setAddingFolder(true);
          await connectDesktopFolder(selected, true);
          if (!window.electronAPI?.connectFolderFast) {
            await fetchStatus();
            triggerRapidPoll();
          }
        }
      } catch (err: any) {
        setBrowserSyncProgress(null);
        setAddFolderMsg(`Error selecting folder: ${err?.message || "Failed to select folder"}`);
      } finally {
        setBrowsingFolder(false);
        setAddingFolder(false);
      }
      return;
    }

    // 2. Web / Vercel: Open Nanvi's Drag & Drop + File Preview Confirmation Modal (zero browser upload warning)
    if (browserSupported) {
      setAddFolderMsg(null);
      setDroppedCandidates([]);
      setFolderModalMode("connect");
      setFolderModalOpen(true);
      return;
    }

    await runBrowserDevicePicker();
  };

  const handleCardDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (isDesktop) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    if (!cardDragOver) setCardDragOver(true);
  };

  const handleCardDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (isDesktop) return;
    e.preventDefault();
    e.stopPropagation();
    const nextTarget = e.relatedTarget as Node | null;
    if (!nextTarget || !e.currentTarget.contains(nextTarget)) {
      setCardDragOver(false);
    }
  };

  const handleCardDrop = async (e: DragEvent<HTMLDivElement>) => {
    if (isDesktop) return;
    e.preventDefault();
    e.stopPropagation();
    setCardDragOver(false);
    try {
      const candidates = await extractDroppedFoldersFromDataTransfer(e.dataTransfer);
      if (candidates.length === 0) {
        setAddFolderMsg("No folder or files were detected. Drag a folder directly from Explorer or Finder.");
        return;
      }
      setDroppedCandidates(candidates);
      setFolderModalMode("connect");
      setFolderModalOpen(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not read dropped folder.";
      setAddFolderMsg(msg);
      notify(msg, "danger");
    }
  };

  const handleConfirmDroppedConnect = async (candidates: DroppedFolderCandidate[]) => {
    const validCandidates = candidates.filter((c) => c.supportedCount > 0);
    if (validCandidates.length === 0) return;

    setConfirmingDropConnect(true);
    setAddFolderMsg(null);
    let connectedCount = 0;
    let totalIndexedFiles = 0;
    let lastConnectedName = "";

    try {
      for (const candidate of validCandidates) {
        const result = await syncDroppedFolder(api, candidate, undefined, { background: true });
        if (!result) continue;
        connectedCount++;
        totalIndexedFiles += result.fileCount;
        lastConnectedName = result.folderName;
        const effectivePath = getBrowserFolderRealPath(result.folderName) || result.folderName;
        setSavedBrowserFolder({
          name: result.folderName,
          permission: "granted",
          cachedFiles: result.fileCount,
        });
        applyOptimisticConnectedFolder(
          result.folderId,
          effectivePath,
          result.folderName,
          result.fileCount,
          result.chunkCount,
        );
      }

      if (connectedCount > 0) {
        const summaryMsg =
          connectedCount === 1
            ? `✓ Connected '${lastConnectedName}' (${totalIndexedFiles} files) — Ready to search.`
            : `✓ Connected ${connectedCount} folders (${totalIndexedFiles} files) — Ready to search.`;
        setAddFolderMsg(summaryMsg);
        notify(summaryMsg.replace(/^✓\s*/, ""), "success");
        setFolderModalOpen(false);
        setDroppedCandidates([]);
        void fetchStatus();
        triggerRapidPoll();
      } else {
        setAddFolderMsg("No supported files were found to connect.");
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Failed to connect dropped folder.";
      setAddFolderMsg(`Error accessing folder: ${errMsg}`);
      notify(`Error accessing folder: ${errMsg}`, "danger");
    } finally {
      setConfirmingDropConnect(false);
    }
  };

  const handlePreviewConnectedFolder = async (folder: NonNullable<typeof agentStatus>["connected_folders"][number]) => {
    const folderName = folder.display_name || folder.folder_path.split(/[/\\]/).pop() || folder.folder_path;
    const folderPath = folder.folder_path || folderName;
    setPreviewTarget({ name: folderName, path: folderPath });
    setPreviewFiles([]);
    setPreviewLoading(true);
    setFolderModalMode("preview");
    setFolderModalOpen(true);

    try {
      if (isDesktop && window.electronAPI?.listFolderFiles && folderPath) {
        const entries = await window.electronAPI.listFolderFiles(folderPath);
        setPreviewFiles(
          (entries || []).map((e) => ({
            relativePath: e.relativePath,
            filename: e.name,
            fileType: e.name.split(".").pop() || "file",
            sizeBytes: e.size,
          })),
        );
      } else {
        const lookupKeys = Array.from(new Set([folderName, folderPath.replace(/^browser:\/\//, "")].filter(Boolean)));
        let found: PreviewableFolderFile[] = [];
        for (const key of lookupKeys) {
          const cached = await getCachedFolderFilesPreview(key);
          if (cached.length > 0) {
            found = cached.map((m) => ({
              relativePath: m.relative_path,
              filename: m.filename,
              fileType: m.file_type,
              sizeBytes: m.size_bytes,
              chunkCount: m.chunk_count,
            }));
            break;
          }
        }
        setPreviewFiles(found);
      }
    } catch {
      setPreviewFiles([]);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleReconnectSavedBrowserFolder = async () => {
    setBrowsingFolder(true);
    setAddFolderMsg(null);
    try {
      const result = await reconnectSavedBrowserFolder(api, undefined, { background: true });
      setBrowserSyncProgress(null);
      if (result) {
        const effectivePath = getBrowserFolderRealPath(result.folderName) || result.folderName;
        setSavedBrowserFolder({
          name: result.folderName,
          permission: "granted",
          cachedFiles: result.fileCount,
        });
        applyOptimisticConnectedFolder(
          result.folderId,
          effectivePath,
          result.folderName,
          result.fileCount,
          result.chunkCount,
        );
        setAddFolderMsg(
          result.reusedCachedCount && result.reusedCachedCount === result.fileCount
            ? `✓ Restored '${result.folderName}' instantaneously from local cache (${result.fileCount} files, 0 re-read).`
            : `✓ Connected '${result.folderName}' (${result.fileCount} files) — Ready to search.`,
        );
        notify(`Folder '${result.folderName}' synchronized (${result.fileCount} files).`, "success");
        void fetchStatus();
        triggerRapidPoll();
      }
    } catch (err: any) {
      setBrowserSyncProgress(null);
      const errMsg = err?.message || "Could not reconnect saved folder. Click Connect Local Folder to pick it again.";
      setAddFolderMsg(errMsg);
      notify(errMsg, "danger");
    } finally {
      setBrowsingFolder(false);
    }
  };

  const isOnline = Boolean(agentStatus?.is_online) || isDesktop || (agentStatus?.connected_folders?.length || 0) > 0;
  const connectedFolders = agentStatus?.connected_folders || [];
  const totalFiles = agentStatus?.total_files || 0;
  const totalChunks = agentStatus?.total_chunks || 0;

  return (
    <div className="folder-picker" style={{ maxWidth: "100%", padding: 0 }}>
      {/* Main Header */}
      <div
        className="folder-picker-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "16px",
          paddingBottom: "18px",
          borderBottom: "1px solid #e2e8f0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <div className="folder-picker-icon" style={{ background: "#0284c7", color: "#ffffff" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div>
            <h3 className="folder-picker-title" style={{ fontSize: "1.3rem", fontWeight: 700, margin: 0, color: "#0f172a" }}>
              Local Folders/Files
            </h3>
            <p className="folder-picker-subtitle" style={{ margin: "4px 0 0", color: "#64748b", fontSize: "0.9rem" }}>
              Connect local computer folders and files for Nanvi AI Assistant to search and reference. All documents stay securely on your computer.
            </p>
          </div>
        </div>

        {/* Top Header Actions */}
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="folder-picker-btn folder-picker-btn-secondary"
            onClick={handleManualRefresh}
            disabled={refreshing}
            style={{
              padding: "9px 16px",
              fontSize: "0.88rem",
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              cursor: "pointer",
            }}
            title="Check live status from local connection"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ animation: refreshing ? "spin 1s linear infinite" : "none" }}
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            {refreshing ? "Refreshing..." : "Refresh Status"}
          </button>
        </div>
      </div>

      {/* Status Messages */}
      {message && (
        <div
          className={`folder-picker-message folder-picker-message-${message.type}`}
          style={{ marginTop: "16px", padding: "12px 16px", borderRadius: "8px" }}
        >
          {message.type === "success" ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          )}
          {message.text}
        </div>
      )}

      {/* Connection Status Banner */}
      <div
        style={{
          marginTop: "20px",
          padding: "18px 22px",
          background: isOnline ? "#f0fdf4" : "#f8fafc",
          border: `1.5px solid ${isOnline ? "#86efac" : "#cbd5e1"}`,
          borderRadius: "12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "14px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span
            style={{
              width: "14px",
              height: "14px",
              borderRadius: "50%",
              background: isDesktop ? "#0284c7" : isOnline ? "#16a34a" : "#64748b",
              boxShadow: isDesktop
                ? "0 0 0 4px rgba(2, 132, 199, 0.2)"
                : isOnline
                ? "0 0 0 4px rgba(22, 163, 74, 0.2)"
                : "0 0 0 4px rgba(100, 116, 139, 0.2)",
            }}
          />
          <div>
            <div style={{ fontSize: "1.05rem", fontWeight: 700, color: isDesktop ? "#0369a1" : isOnline ? "#166534" : "#1e293b" }}>
              {isDesktop
                ? "🖥️ Nanvi Desktop Mode: Direct Local Computer Access Active"
                : isOnline
                ? "🟢 Local Computer Storage Active & Connected"
                : "Ready to Connect Local Folders"}
            </div>
            <div style={{ fontSize: "0.85rem", color: isDesktop ? "#0284c7" : isOnline ? "#15803d" : "#64748b", marginTop: "2px" }}>
              {isDesktop
                ? "Direct 1-Click Windows Explorer folder picker and manual path input ready."
                : isOnline
                ? "Local filesystem ready • Direct 1-Click Explorer folder picker and manual path entry active"
                : "Connect any local folder via 1-Click folder picker or manual path input."}
            </div>
          </div>
        </div>

        {/* Live Counters */}
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <div style={{ padding: "6px 14px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "0.85rem", fontWeight: 600, color: "#334155" }}>
            📁 {connectedFolders.length} Folders
          </div>
          <div style={{ padding: "6px 14px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "0.85rem", fontWeight: 600, color: "#334155" }}>
            📄 {totalFiles} Files
          </div>
          <div style={{ padding: "6px 14px", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "8px", fontSize: "0.85rem", fontWeight: 600, color: "#0284c7" }}>
            {isDesktop && agentStatus?.agent_version === "desktop-local-only" && totalChunks === 0
              ? "⚡ Live On-Device Search"
              : totalChunks === 0 && totalFiles > 0
                ? "⚡ Indexing Chunks..."
                : `⚡ ${totalChunks} Searchable Chunks`}
          </div>
        </div>
      </div>

      {/* Connected Folders List */}
      <div style={{ marginTop: "24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <h4 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}>
            Connected Folders ({connectedFolders.length}):
          </h4>
          <span style={{ fontSize: "0.82rem", color: "#64748b" }}>
            Only files in these folders are searched by Nanvi AI Assistant
          </span>
        </div>

        {connectedFolders.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {connectedFolders.map((folder, idx) => {
              const targetId = folder.folder_id || folder.folder_path || "";
              const isRemoving = disconnectingId === targetId;
              return (
                <div
                  key={targetId || idx}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "14px",
                    padding: "18px 22px",
                    background: "#f0fdf4",
                    border: "1.5px solid #86efac",
                    borderLeft: "6px solid #16a34a",
                    borderRadius: "12px",
                    boxShadow: "0 2px 8px rgba(22, 163, 74, 0.08)",
                    transition: "all 0.2s ease",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "3px 10px",
                          background: "#dcfce7",
                          border: "1px solid #86efac",
                          borderRadius: "20px",
                          color: "#166534",
                          fontSize: "0.78rem",
                          fontWeight: 700,
                          letterSpacing: "0.02em",
                        }}
                      >
                        <span
                          style={{
                            width: "8px",
                            height: "8px",
                            borderRadius: "50%",
                            background: "#16a34a",
                            boxShadow: "0 0 0 2px rgba(22, 163, 74, 0.3)",
                          }}
                        />
                        CONNECTED & ACTIVE
                      </span>
                      <span style={{ fontSize: "0.8rem", color: "#15803d", fontWeight: 500 }}>
                        Searched by Nanvi AI Assistant
                      </span>
                    </div>

                    <div style={{ fontWeight: 700, fontSize: "1.08rem", color: "#0f172a" }}>
                      📁 {folder.display_name || folder.folder_path}
                    </div>
                    <code style={{ fontSize: "0.85rem", color: "#475569", marginTop: "4px", display: "inline-block", background: "#ffffff", padding: "2px 8px", borderRadius: "4px", border: "1px solid #e2e8f0" }}>
                      {folder.folder_path}
                    </code>
                    <div style={{ marginTop: "8px", display: "flex", gap: "12px", alignItems: "center", fontSize: "0.84rem", color: "#166534", fontWeight: 600 }}>
                      <span>✓ {folder.file_count ?? 0} files on disk</span>
                      <span>•</span>
                      <span>
                        {isDesktop && agentStatus?.agent_version === "desktop-local-only" && (folder.chunk_count ?? 0) === 0
                          ? "⚡ Searched live on your PC (no cloud upload)"
                          : (folder.chunk_count ?? 0) === 0 && (folder.file_count ?? 0) > 0
                            ? "⚡ Indexing searchable chunks in background..."
                            : `⚡ ${folder.chunk_count ?? 0} searchable chunks`}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                    <button
                      type="button"
                      className="folder-picker-btn"
                      style={{
                        background: "#ffffff",
                        color: "#0369a1",
                        border: "1.5px solid #bae6fd",
                        fontSize: "0.86rem",
                        fontWeight: 700,
                        padding: "9px 14px",
                        borderRadius: "8px",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        transition: "all 0.15s ease",
                      }}
                      onClick={() => void handlePreviewConnectedFolder(folder)}
                      title="Preview files inside this connected folder"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                      Preview Files
                    </button>

                    <button
                      type="button"
                      className="folder-picker-btn"
                      style={{
                        background: "#fee2e2",
                        color: "#b91c1c",
                        border: "1.5px solid #fca5a5",
                        fontSize: "0.86rem",
                        fontWeight: 700,
                        padding: "9px 18px",
                        borderRadius: "8px",
                        cursor: isRemoving ? "wait" : "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        boxShadow: "0 1px 4px rgba(220, 38, 38, 0.12)",
                        transition: "all 0.15s ease",
                      }}
                      onClick={() => handleDisconnectFolder(targetId)}
                      disabled={isRemoving}
                      title="Disconnect this folder from Nanvi Assistant"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      {isRemoving ? "Removing..." : "Remove / Disconnect"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            onDragOver={handleCardDragOver}
            onDragLeave={handleCardDragLeave}
            onDrop={(e) => void handleCardDrop(e)}
            style={{
              padding: "26px",
              textAlign: "center",
              background: cardDragOver ? "#e0f2fe" : "#f8fafc",
              border: `2px dashed ${cardDragOver ? "#0284c7" : "#cbd5e1"}`,
              borderRadius: "12px",
              color: "#475569",
              transition: "all 0.16s ease",
            }}
          >
            <div style={{ fontSize: "2rem", marginBottom: "8px" }}>📂</div>
            <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "#1e293b", marginBottom: "6px" }}>
              No Folders Connected Yet
            </div>
            <p style={{ margin: "0 auto 16px", maxWidth: "560px", fontSize: "0.9rem", color: "#64748b", lineHeight: 1.5 }}>
              Choose a method below to connect your local folders or files:
            </p>
            <div style={{ display: "flex", justifyContent: "center", gap: "10px", flexWrap: "wrap" }}>
              <button
                type="button"
                className="folder-picker-btn"
                onClick={() => {
                  setConnectMethod("browse");
                  void handleBrowseFolder();
                }}
                disabled={browsingFolder}
                style={{
                  padding: "9px 20px",
                  fontSize: "0.9rem",
                  fontWeight: 700,
                  background: "#0284c7",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "8px",
                  cursor: "pointer",
                }}
              >
                {isDesktop ? "📁 1-Click Browse (Windows Explorer)" : "📁 Connect & Preview Folder"}
              </button>
              <button
                type="button"
                className="folder-picker-btn"
                onClick={() => setConnectMethod("manual")}
                style={{
                  padding: "9px 20px",
                  fontSize: "0.9rem",
                  fontWeight: 700,
                  background: "#ffffff",
                  color: "#1e293b",
                  border: "1.5px solid #cbd5e1",
                  borderRadius: "8px",
                  cursor: "pointer",
                }}
              >
                ✍️ Enter Path Manually
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Choose Connection Method Section */}
      <div
        style={{
          marginTop: "28px",
          padding: "24px",
          background: "#ffffff",
          borderRadius: "14px",
          border: "1px solid #e2e8f0",
          boxShadow: "0 2px 8px rgba(0, 0, 0, 0.04)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", marginBottom: "18px" }}>
          <div>
            <div style={{ fontSize: "1.08rem", fontWeight: 700, color: "#0f172a" }}>
              Connect Local Folders / Files
            </div>
            <div style={{ fontSize: "0.85rem", color: "#64748b", marginTop: "2px" }}>
              Select your preferred folder connection method below:
            </div>
          </div>

          {/* 2 Dedicated Method Selector Tabs */}
          <div style={{ display: "inline-flex", background: "#f1f5f9", padding: "4px", borderRadius: "10px", gap: "4px" }}>
            <button
              type="button"
              onClick={() => setConnectMethod("browse")}
              style={{
                padding: "8px 16px",
                fontSize: "0.86rem",
                fontWeight: 700,
                border: "none",
                borderRadius: "8px",
                cursor: "pointer",
                background: connectMethod === "browse" ? "#ffffff" : "transparent",
                color: connectMethod === "browse" ? "#0284c7" : "#475569",
                boxShadow: connectMethod === "browse" ? "0 2px 6px rgba(0, 0, 0, 0.08)" : "none",
                transition: "all 0.15s ease",
              }}
            >
              {browserSupported && !isDesktop ? "📁 Method 1: Drag & Drop / Preview" : "📁 Method 1: Windows Explorer (1-Click)"}
            </button>
            <button
              type="button"
              onClick={() => setConnectMethod("manual")}
              style={{
                padding: "8px 16px",
                fontSize: "0.86rem",
                fontWeight: 700,
                border: "none",
                borderRadius: "8px",
                cursor: "pointer",
                background: connectMethod === "manual" ? "#ffffff" : "transparent",
                color: connectMethod === "manual" ? "#2563eb" : "#475569",
                boxShadow: connectMethod === "manual" ? "0 2px 6px rgba(0, 0, 0, 0.08)" : "none",
                transition: "all 0.15s ease",
              }}
            >
              ✍️ Method 2: Manual Path Input
            </button>
          </div>
        </div>

        {/* Tab 1: Instant Browser Folder Access (Drag & Drop Modal on Web, Native Picker on Desktop) */}
        {connectMethod === "browse" && (
          <div
            onDragOver={handleCardDragOver}
            onDragLeave={handleCardDragLeave}
            onDrop={(e) => void handleCardDrop(e)}
            style={{
              padding: "24px",
              background: cardDragOver ? "#e0f2fe" : "#f0f9ff",
              border: `1.5px ${!isDesktop ? "dashed" : "solid"} ${cardDragOver ? "#0284c7" : "#bae6fd"}`,
              borderRadius: "12px",
              textAlign: "center",
              transition: "all 0.16s ease",
            }}
          >
            <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#0369a1", marginBottom: "6px" }}>
              {browserSupported && !isDesktop
                ? cardDragOver
                  ? "📂 Release to Preview & Connect Folder"
                  : "📁 Connect Local Folders / Files (Preview & Drag-and-Drop)"
                : "📁 1-Click Folder / File Picker (Easy Way)"}
            </div>
            <p style={{ margin: "0 auto 20px", maxWidth: "620px", fontSize: "0.9rem", color: "#0284c7", lineHeight: 1.5 }}>
              {browserSupported && !isDesktop
                ? "Click below to open Nanvi's Drag & Drop connector, or drop any folder directly here from Windows Explorer or Mac Finder to preview its files before connecting."
                : "Click the button below to launch the native Windows Explorer dialog. Pick any folder on your PC and Nanvi links it immediately."}
            </p>

            <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: "12px" }}>
              <button
                type="button"
                className="folder-picker-btn"
                onClick={handleBrowseFolder}
                disabled={browsingFolder}
                style={{
                  padding: "14px 30px",
                  fontSize: "1.02rem",
                  fontWeight: 700,
                  background: "#0284c7",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "10px",
                  cursor: browsingFolder ? "wait" : "pointer",
                  boxShadow: "0 4px 16px rgba(2, 132, 199, 0.3)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "10px",
                  transition: "all 0.2s ease",
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                {browsingFolder
                  ? "Opening Folder Picker..."
                  : browserSupported && !isDesktop
                    ? (connectedFolders.length > 0 ? "+ Connect Another Folder" : "Connect Local Folder")
                    : (connectedFolders.length > 0 ? "+ Connect Another Folder" : "Open Windows Explorer & Select Folder")}
              </button>
            </div>

            <div style={{ marginTop: "14px", fontSize: "0.82rem", color: "#0369a1", fontWeight: 500 }}>
              {browserSupported && !isDesktop
                ? "✓ Drag & drop a folder directly to preview its files before connecting. Need Google Drive or OneDrive? Connect in Settings → Connections Hub."
                : "✓ Direct 1-Click Access: Windows Explorer folder dialog opens directly on your computer screen."}
            </div>

            {browserSupported && !isDesktop && (savedBrowserFolder || connectedFolders.length > 0) && (
              <div
                style={{
                  marginTop: "16px",
                  padding: "12px 14px",
                  background: "#ffffff",
                  border: "1px solid #bae6fd",
                  borderRadius: "8px",
                  textAlign: "left",
                  maxWidth: "660px",
                  marginLeft: "auto",
                  marginRight: "auto",
                }}
              >
                <div style={{ fontSize: "0.82rem", fontWeight: 700, color: "#0369a1", marginBottom: "6px" }}>
                  Exact Windows Folder Path (Optional — Browsers hide C:\... for security)
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    type="text"
                    value={browserRealPathInput}
                    onChange={(e) => setBrowserRealPathInput(e.target.value)}
                    placeholder={`e.g. C:\\Users\\YourName\\Documents\\${savedBrowserFolder?.name || connectedFolders[0]?.display_name || "MyFolder"}`}
                    style={{
                      flex: "1 1 280px",
                      padding: "8px 10px",
                      fontSize: "0.85rem",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      color: "#0f172a",
                    }}
                  />
                  <button
                    type="button"
                    className="folder-picker-btn"
                    disabled={browsingFolder}
                    onClick={async () => {
                      const folderKey =
                        savedBrowserFolder?.name ||
                        connectedFolders[0]?.display_name ||
                        "";
                      if (!folderKey) return;
                      setBrowserFolderRealPath(folderKey, browserRealPathInput);
                      await handleReconnectSavedBrowserFolder();
                    }}
                    style={{
                      padding: "8px 14px",
                      fontSize: "0.84rem",
                      fontWeight: 600,
                      background: "#0284c7",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: "6px",
                      cursor: browsingFolder ? "wait" : "pointer",
                    }}
                  >
                    Apply Real Path
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: ✍️ Manual Folder Path Input */}
        {connectMethod === "manual" && (
          <div
            style={{
              padding: "24px",
              background: "#f8fafc",
              border: "1.5px solid #e2e8f0",
              borderRadius: "12px",
            }}
          >
            <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#1e293b", marginBottom: "6px" }}>
              ✍️ Enter or Paste Folder Path Manually
            </div>
            <p style={{ margin: "0 0 18px", fontSize: "0.88rem", color: "#64748b", lineHeight: 1.5 }}>
              Type or paste any directory path on your computer (e.g. <code>C:\CompanyData</code> or <code>D:\Projects\Invoices</code>), or pick a 1-click preset.
            </p>

            {/* Custom Path Input Row */}
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "16px" }}>
              <input
                type="text"
                className="folder-picker-input"
                style={{
                  flex: 1,
                  minWidth: "300px",
                  fontSize: "0.95rem",
                  padding: "12px 16px",
                  background: "#ffffff",
                  color: "#0f172a",
                  border: "1.5px solid #cbd5e1",
                  borderRadius: "8px",
                }}
                placeholder="Paste or type path, e.g. C:\CompanyData or C:\Users\Username\Documents"
                value={customLocalFolder}
                onChange={(e) => setCustomLocalFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAddLocalFolder();
                }}
              />
              <button
                type="button"
                className="folder-picker-btn"
                onClick={() => void handleAddLocalFolder()}
                disabled={addingFolder || !customLocalFolder.trim()}
                style={{
                  padding: "12px 26px",
                  fontSize: "0.95rem",
                  fontWeight: 700,
                  background: "#2563eb",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "8px",
                  cursor: addingFolder || !customLocalFolder.trim() ? "not-allowed" : "pointer",
                  whiteSpace: "nowrap",
                  boxShadow: "0 2px 8px rgba(37, 99, 235, 0.25)",
                }}
              >
                {addingFolder ? "Connecting & Indexing..." : "+ Connect Folder Path"}
              </button>
            </div>

            {/* 1-Click Quick Presets */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
              <span style={{ fontSize: "0.86rem", fontWeight: 700, color: "#475569", marginRight: "4px" }}>
                1-Click Presets:
              </span>
              <button
                type="button"
                className="folder-picker-btn"
                style={{ fontSize: "0.86rem", fontWeight: 600, padding: "8px 16px", background: "#ffffff", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer" }}
                onClick={() => handleAddLocalFolder("C:\\Users\\%USERNAME%\\Documents")}
                disabled={addingFolder}
                title="Connect Documents folder"
              >
                📁 Documents
              </button>
              <button
                type="button"
                className="folder-picker-btn"
                style={{ fontSize: "0.86rem", fontWeight: 600, padding: "8px 16px", background: "#ffffff", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer" }}
                onClick={() => handleAddLocalFolder("C:\\Users\\%USERNAME%\\Desktop")}
                disabled={addingFolder}
                title="Connect Desktop folder"
              >
                📁 Desktop
              </button>
              <button
                type="button"
                className="folder-picker-btn"
                style={{ fontSize: "0.86rem", fontWeight: 600, padding: "8px 16px", background: "#ffffff", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer" }}
                onClick={() => handleAddLocalFolder("C:\\Users\\%USERNAME%\\Downloads")}
                disabled={addingFolder}
                title="Connect Downloads folder"
              >
                📁 Downloads
              </button>
              <button
                type="button"
                className="folder-picker-btn"
                style={{ fontSize: "0.86rem", fontWeight: 600, padding: "8px 16px", background: "#ffffff", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer" }}
                onClick={() => handleAddLocalFolder("D:\\")}
                disabled={addingFolder}
                title="Connect D:\ Drive"
              >
                💾 D:\ Drive
              </button>
            </div>
          </div>
        )}

        {/* Minimal prompt only while awaiting Firefox/Safari native confirmation dialog */}
        {browsingFolder && browserSyncProgress && browserSyncProgress.phase === "scanning" && browserSyncProgress.totalFiles === 0 && (
          <div
            style={{
              marginTop: "16px",
              padding: "12px 16px",
              background: "#f0f9ff",
              border: "1px solid #bae6fd",
              borderRadius: "8px",
              fontSize: "0.86rem",
              color: "#0369a1",
              fontWeight: 600,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "12px",
            }}
          >
            <div>{browserSyncProgress.message}</div>
            <button
              type="button"
              onClick={() => {
                cancelPendingBrowserFolderPicker();
                setBrowserSyncProgress(null);
                setBrowsingFolder(false);
              }}
              style={{
                background: "#ffffff",
                color: "#0369a1",
                border: "1px solid #bae6fd",
                borderRadius: "6px",
                padding: "4px 10px",
                fontSize: "0.78rem",
                fontWeight: 600,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {addFolderMsg && (
          <div
            style={{
              marginTop: "16px",
              padding: "12px 16px",
              borderRadius: "8px",
              fontSize: "0.9rem",
              fontWeight: 600,
              background: addFolderMsg.startsWith("✓") ? "#f0fdf4" : "#fef2f2",
              border: `1px solid ${addFolderMsg.startsWith("✓") ? "#bbf7d0" : "#fecaca"}`,
              color: addFolderMsg.startsWith("✓") ? "#15803d" : "#b91c1c",
            }}
          >
            {addFolderMsg}
          </div>
        )}
      </div>

      <FolderConnectModal
        open={folderModalOpen}
        mode={folderModalMode}
        candidates={droppedCandidates}
        onCandidatesChange={setDroppedCandidates}
        onConfirmConnect={handleConfirmDroppedConnect}
        connecting={confirmingDropConnect}
        previewFolderName={previewTarget.name}
        previewFolderPath={previewTarget.path}
        previewFiles={previewFiles}
        previewLoading={previewLoading}
        onClose={() => {
          setFolderModalOpen(false);
          setDroppedCandidates([]);
        }}
      />
    </div>
  );
}

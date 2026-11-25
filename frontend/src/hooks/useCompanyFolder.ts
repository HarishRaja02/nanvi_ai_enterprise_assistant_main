import { useCallback, useEffect, useRef, useState } from "react";
import type { NanviApiClient, CompanyFolderResponse } from "../api";
import { autoRestoreBrowserFolderIfGranted, updateDesktopFolderFileCount } from "../lib/browserFolderSync";

export function useCompanyFolder(api?: NanviApiClient, userScopeKey = "") {
  const [folderPath, setFolderPath] = useState<string>("");
  const [folderName, setFolderName] = useState<string>("");
  const [folderExists, setFolderExists] = useState<boolean>(true);
  const [folderCount, setFolderCount] = useState<number>(0);
  const [fileCount, setFileCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const attemptedAutoRestoreRef = useRef<string>("");

  const extractName = (fullPath: string): string => {
    if (!fullPath) return "";
    const clean = fullPath.replace(/[/\\]+$/, "");
    const parts = clean.split(/[/\\]/);
    return parts[parts.length - 1] || fullPath;
  };

  const refresh = useCallback(async () => {
    if (!api) {
      setFolderPath("");
      setFolderName("");
      setFolderExists(false);
      setFolderCount(0);
      setFileCount(0);
      setError(null);
      setLoading(false);
      return;
    }
    try {
      const res: CompanyFolderResponse = await api.getCompanyFolder();
      setFolderPath(res.path);
      setFolderName(extractName(res.path));
      setFolderExists(res.exists);
      setFolderCount(res.folder_count);
      setFileCount(res.file_count);
      setError(null);

      const scopeToken = userScopeKey || "__default__";
      if (!res.exists && attemptedAutoRestoreRef.current !== scopeToken) {
        attemptedAutoRestoreRef.current = scopeToken;
        void autoRestoreBrowserFolderIfGranted(api);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load company folder");
    } finally {
      setLoading(false);
    }
  }, [api, userScopeKey]);

  useEffect(() => {
    setFolderPath("");
    setFolderName("");
    setFolderExists(false);
    setFolderCount(0);
    setFileCount(0);
    attemptedAutoRestoreRef.current = "";
    void refresh();

    const onUpdated = (e: Event) => {
      const customEvent = e as CustomEvent<{
        path: string;
        exists: boolean;
        folder_count: number;
        file_count: number;
      }>;
      if (customEvent.detail) {
        setFolderPath(customEvent.detail.path);
        setFolderName(extractName(customEvent.detail.path));
        setFolderExists(customEvent.detail.exists);
        setFolderCount(customEvent.detail.folder_count);
        setFileCount(customEvent.detail.file_count);
        setError(null);
      } else {
        void refresh();
      }
    };

    window.addEventListener("nanvi:company-folder-updated", onUpdated);
    const unsubCount =
      typeof window !== "undefined" && window.electronAPI?.onFolderCountUpdated
        ? window.electronAPI.onFolderCountUpdated((payload) => {
            if (payload && payload.folderPath && typeof payload.fileCount === "number") {
              updateDesktopFolderFileCount(payload.folderPath, payload.fileCount);
            }
          })
        : undefined;
    return () => {
      window.removeEventListener("nanvi:company-folder-updated", onUpdated);
      if (unsubCount) unsubCount();
    };
  }, [api, refresh]);

  return {
    folderPath,
    folderName,
    folderExists,
    folderCount,
    fileCount,
    loading,
    error,
    refresh,
  };
}

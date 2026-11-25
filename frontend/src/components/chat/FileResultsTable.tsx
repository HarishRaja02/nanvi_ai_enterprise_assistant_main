import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  FileText,
  Check,
  Copy,
  Eye,
  ExternalLink,
  Loader2,
  Download,
  AlertCircle,
  FolderSearch,
  Search,
  FileSearch,
  Sparkles,
} from "lucide-react";
import type { FileResultItem } from "../../types";
import { useToast } from "../ui/Toast";
import { NanviApiClient } from "../../api";
import { getStoredToken } from "../../lib/session";
import {
  buildLocalFilePreviewBlob,
  cleanBrowserDisplayPath,
  formatCodeDocumentPreviewHtml,
  formatExcelSpreadsheetPreviewHtml,
  formatPdfDocumentPreviewHtml,
  formatPowerPointPresentationPreviewHtml,
  formatWordDocumentPreviewHtml,
  readBrowserLocalFile,
} from "../../lib/browserFolderSync";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";

interface Props {
  files: FileResultItem[];
  api?: NanviApiClient;
  userQuery?: string;
  onOpen?: (file: FileResultItem) => void;
}

async function isRealPdfBinary(blob: Blob): Promise<boolean> {
  try {
    const headerBuf = await blob.slice(0, 1024).arrayBuffer();
    const str = new TextDecoder("latin1").decode(headerBuf);
    return str.includes("%PDF");
  } catch {
    return false;
  }
}

export function FileResultsTable({ files, api, userQuery, onOpen }: Props) {
  const notify = useToast();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copiedModal, setCopiedModal] = useState(false);
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  // In-memory ephemeral preview state
  const [previewFile, setPreviewFile] = useState<FileResultItem | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobLoading, setBlobLoading] = useState(false);
  const [blobError, setBlobError] = useState<string | null>(null);
  const [blobMime, setBlobMime] = useState<string | null>(null);
  const activeBlobUrlRef = useRef<string | null>(null);

  // Free in-memory blob when component unmounts or user leaves the page
  useEffect(() => {
    return () => {
      if (activeBlobUrlRef.current) {
        URL.revokeObjectURL(activeBlobUrlRef.current);
        activeBlobUrlRef.current = null;
      }
    };
  }, []);

  const getExactPath = (file: FileResultItem): string => {
    const raw = file.full_path || file.open_url || file.path;
    return cleanBrowserDisplayPath(raw);
  };

  // Deduplicate rows by normalized canonical path
  const displayedFiles: FileResultItem[] = useMemo(() => {
    if (!files || files.length === 0) return [];
    const result: FileResultItem[] = [];
    const seenDisplayKeys = new Set<string>();
    for (const f of files) {
      const cleanP = getExactPath(f);
      const key = cleanP.replace(/\\/g, "/").toLowerCase().replace(/^\/+/, "");
      if (key && seenDisplayKeys.has(key)) continue;
      if (key) seenDisplayKeys.add(key);
      const cleanName = f.name.replace(/^\[[^\]]+\]\s*/, "").trim();
      result.push({
        ...f,
        name: cleanName || f.name,
        path: cleanP,
        full_path: cleanP,
        display_path: f.display_path ? cleanBrowserDisplayPath(f.display_path) : cleanP,
        open_url: cleanP,
      });
      if (result.length >= 15) break;
    }
    return result;
  }, [files]);

  // Separate File Search Results Based on Matching Type
  // Section 1: File Name Matches
  // Section 2: Document Content Matches
  const { fileNameMatches, contentMatches } = useMemo(() => {
    const nameMatches: FileResultItem[] = [];
    const bodyMatches: FileResultItem[] = [];

    const stopWords = new Set([
      "the",
      "and",
      "for",
      "with",
      "from",
      "show",
      "find",
      "list",
      "what",
      "where",
      "file",
      "files",
      "document",
      "documents",
      "data",
      "please",
      "can",
      "you",
      "all",
      "recent",
    ]);
    const queryTokens = (userQuery || "")
      .toLowerCase()
      .replace(/[^\w\s.-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !stopWords.has(t));

    displayedFiles.forEach((file) => {
      const fnLow = (file.name || "").toLowerCase();
      const explicitType = file.match_type;

      if (explicitType === "name") {
        nameMatches.push(file);
        return;
      }
      if (explicitType === "content") {
        bodyMatches.push(file);
        return;
      }

      // Check if any query token matches the filename directly
      const hasNameMatch =
        queryTokens.length > 0 && queryTokens.some((tok) => fnLow.includes(tok));

      if (hasNameMatch) {
        nameMatches.push(file);
      } else {
        bodyMatches.push(file);
      }
    });

    return {
      fileNameMatches: nameMatches,
      contentMatches: bodyMatches,
    };
  }, [displayedFiles, userQuery]);

  if (!files || files.length === 0) {
    return null;
  }

  const handleCopyPath = async (path: string, key?: string) => {
    try {
      await navigator.clipboard.writeText(path);
      if (key !== undefined) {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2000);
      } else {
        setCopiedModal(true);
        setTimeout(() => setCopiedModal(false), 2000);
      }
      notify(`Copied exact file path to clipboard`, "success");
    } catch {
      notify("Could not copy automatically. Please copy the path manually.", "danger");
    }
  };

  const formatDocumentBlobIfNeeded = async (
    rawBlob: Blob,
    fileName: string,
    defaultMime?: string
  ): Promise<{ blob: Blob; mime: string }> => {
    const extLow = fileName.toLowerCase();

    if (extLow.endsWith(".pdf")) {
      const realPdf = await isRealPdfBinary(rawBlob);
      if (realPdf) {
        return { blob: new Blob([rawBlob], { type: "application/pdf" }), mime: "application/pdf" };
      }
      try {
        const text = await rawBlob.text();
        if (!text.includes("<html") && !text.includes("<HTML")) {
          const html = formatPdfDocumentPreviewHtml(fileName, text);
          return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mime: "text/html; charset=utf-8" };
        }
      } catch {
        // ignore
      }
      return { blob: new Blob([rawBlob], { type: "text/html; charset=utf-8" }), mime: "text/html; charset=utf-8" };
    }

    if (
      extLow.endsWith(".csv") ||
      extLow.endsWith(".tsv") ||
      extLow.endsWith(".xlsx") ||
      extLow.endsWith(".xls") ||
      extLow.endsWith(".ods")
    ) {
      try {
        const text = await rawBlob.text();
        if (!text.includes("<table") && !text.includes("<TABLE")) {
          const html = formatExcelSpreadsheetPreviewHtml(fileName, text);
          return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mime: "text/html; charset=utf-8" };
        }
      } catch {
        // ignore
      }
      return { blob: new Blob([rawBlob], { type: "text/html; charset=utf-8" }), mime: "text/html; charset=utf-8" };
    }

    if (
      extLow.endsWith(".docx") ||
      extLow.endsWith(".doc") ||
      extLow.endsWith(".rtf") ||
      extLow.endsWith(".odt")
    ) {
      try {
        const text = await rawBlob.text();
        if (!text.includes("<html") && !text.includes("<HTML")) {
          const html = formatWordDocumentPreviewHtml(fileName, text);
          return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mime: "text/html; charset=utf-8" };
        }
      } catch {
        // ignore
      }
      return { blob: new Blob([rawBlob], { type: "text/html; charset=utf-8" }), mime: "text/html; charset=utf-8" };
    }

    if (
      extLow.endsWith(".pptx") ||
      extLow.endsWith(".ppt") ||
      extLow.endsWith(".odp")
    ) {
      try {
        const text = await rawBlob.text();
        if (!text.includes("<html") && !text.includes("<HTML")) {
          const html = formatPowerPointPresentationPreviewHtml(fileName, text);
          return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mime: "text/html; charset=utf-8" };
        }
      } catch {
        // ignore
      }
      return { blob: new Blob([rawBlob], { type: "text/html; charset=utf-8" }), mime: "text/html; charset=utf-8" };
    }

    const codeExts = [
      ".json", ".jsonl", ".yaml", ".yml", ".xml", ".sql", ".py", ".js", ".ts", ".tsx", ".jsx", ".css", ".sh", ".bat"
    ];
    if (codeExts.some((ce) => extLow.endsWith(ce))) {
      try {
        const text = await rawBlob.text();
        if (!text.includes("<html") && !text.includes("<HTML")) {
          const html = formatCodeDocumentPreviewHtml(fileName, text);
          return { blob: new Blob([html], { type: "text/html; charset=utf-8" }), mime: "text/html; charset=utf-8" };
        }
      } catch {
        // ignore
      }
      return { blob: new Blob([rawBlob], { type: "text/html; charset=utf-8" }), mime: "text/html; charset=utf-8" };
    }

    const mime = defaultMime || rawBlob.type || "text/html; charset=utf-8";
    return { blob: new Blob([rawBlob], { type: mime }), mime };
  };

  const openPreview = async (file: FileResultItem) => {
    if (activeBlobUrlRef.current) {
      URL.revokeObjectURL(activeBlobUrlRef.current);
      activeBlobUrlRef.current = null;
    }
    setBlobUrl(null);
    setBlobError(null);
    setPreviewFile(file);
    setBlobLoading(true);

    const exactPath = getExactPath(file);
    try {
      const localFile =
        (await readBrowserLocalFile(exactPath, true)) ||
        (await readBrowserLocalFile(file.path, true));
      if (localFile) {
        const preview = await buildLocalFilePreviewBlob(localFile, api);
        const objUrl = URL.createObjectURL(preview.blob);
        activeBlobUrlRef.current = objUrl;
        setBlobUrl(objUrl);
        setBlobMime(preview.mimeType);
        return;
      }

      if (api && typeof api.getDocumentBlob === "function") {
        const result = await api.getDocumentBlob(exactPath);
        const formatted = await formatDocumentBlobIfNeeded(result.blob, file.name, result.mimeType);
        const objUrl = URL.createObjectURL(formatted.blob);
        activeBlobUrlRef.current = objUrl;
        setBlobUrl(objUrl);
        setBlobMime(formatted.mime);
      } else {
        const isDesktopOrigin =
          typeof window !== "undefined" &&
          (window.location.protocol === "file:" ||
            Boolean((window as any).electronAPI?.isDesktop));
        const base = isDesktopOrigin ? "http://127.0.0.1:8000/api" : "/api";
        const token = getStoredToken();
        const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(
          `${base}/local-agent/document-content?path=${encodeURIComponent(exactPath)}`,
          { headers }
        );
        if (!res.ok) throw new Error("Could not load document into browser memory");
        const blob = await res.blob();
        const formatted = await formatDocumentBlobIfNeeded(blob, file.name);
        const objUrl = URL.createObjectURL(formatted.blob);
        activeBlobUrlRef.current = objUrl;
        setBlobUrl(objUrl);
        setBlobMime(formatted.mime);
      }
    } catch (err: any) {
      setBlobError(err.message || "Document content not available on cloud server");
    } finally {
      setBlobLoading(false);
    }
  };

  const closePreview = () => {
    if (activeBlobUrlRef.current) {
      URL.revokeObjectURL(activeBlobUrlRef.current);
      activeBlobUrlRef.current = null;
    }
    setBlobUrl(null);
    setBlobError(null);
    setPreviewFile(null);
  };

  const handleOpen = async (file: FileResultItem, key: string) => {
    if (onOpen) {
      onOpen(file);
    }
    const exactPath = getExactPath(file);

    if (exactPath.startsWith("http://") || exactPath.startsWith("https://")) {
      window.open(exactPath, "_blank");
      notify(`Opening ${file.name} in browser...`, "success");
      return;
    }

    try {
      await navigator.clipboard.writeText(exactPath);
    } catch {
      // ignore
    }

    setOpeningKey(key);

    try {
      if (typeof window !== "undefined" && (window as any).electronAPI?.openPath) {
        const res = await (window as any).electronAPI.openPath(exactPath);
        if (!res?.error) {
          notify(`Opened ${file.name} in your default application`, "success");
          return;
        }
      }

      if (api && typeof api.openFile === "function") {
        const res = await api.openFile(exactPath);
        if (res?.local || res?.queued) {
          notify(res?.message || `Opened ${file.name} on your computer`, "success");
          return;
        }
      }

      const extLow = file.name.toLowerCase();
      const isPdfDoc = extLow.endsWith(".pdf");
      const isImg =
        extLow.endsWith(".png") ||
        extLow.endsWith(".jpg") ||
        extLow.endsWith(".jpeg") ||
        extLow.endsWith(".webp") ||
        extLow.endsWith(".svg") ||
        extLow.endsWith(".gif") ||
        extLow.endsWith(".bmp") ||
        extLow.endsWith(".tif") ||
        extLow.endsWith(".tiff") ||
        extLow.endsWith(".ico");
      const isVideoDoc =
        extLow.endsWith(".mp4") ||
        extLow.endsWith(".webm") ||
        extLow.endsWith(".mov") ||
        extLow.endsWith(".mkv") ||
        extLow.endsWith(".avi") ||
        extLow.endsWith(".m4v") ||
        extLow.endsWith(".ogg");
      const isAudioDoc =
        extLow.endsWith(".mp3") ||
        extLow.endsWith(".wav") ||
        extLow.endsWith(".m4a") ||
        extLow.endsWith(".aac") ||
        extLow.endsWith(".flac");
      const isHtmlDoc = extLow.endsWith(".html") || extLow.endsWith(".htm");

      // Source 1: Local browser folder sync (indexed local files)
      const browserFile =
        (await readBrowserLocalFile(exactPath, true)) ||
        (await readBrowserLocalFile(file.path, true));

      if (browserFile) {
        let openBlob: Blob;
        if (isPdfDoc) {
          const isReal = await isRealPdfBinary(browserFile);
          if (isReal) {
            openBlob = new Blob([browserFile], { type: "application/pdf" });
          } else {
            const preview = await buildLocalFilePreviewBlob(browserFile, api);
            openBlob = preview.blob;
          }
        } else if (isImg || isVideoDoc || isAudioDoc || isHtmlDoc) {
          const mimeType = isImg
            ? browserFile.type || "image/png"
            : isVideoDoc
            ? browserFile.type || "video/mp4"
            : isAudioDoc
            ? browserFile.type || "audio/mpeg"
            : "text/html; charset=utf-8";
          openBlob = new Blob([browserFile], { type: mimeType });
        } else {
          // Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV (.csv), TSV (.tsv), Code & Text
          const preview = await buildLocalFilePreviewBlob(browserFile, api);
          openBlob = preview.blob;
        }

        const tabUrl = URL.createObjectURL(openBlob);
        window.open(tabUrl, "_blank");
        setTimeout(() => URL.revokeObjectURL(tabUrl), 60000);
        notify(`Opened ${file.name} in browser viewer`, "success");
        return;
      }

      // Source 2: Retrieve document blob via API client
      if (api && typeof api.getDocumentBlob === "function") {
        try {
          const docResult = await api.getDocumentBlob(exactPath, false);
          if (docResult?.blob) {
            let openBlob: Blob;
            if (isPdfDoc) {
              const isReal = await isRealPdfBinary(docResult.blob);
              if (isReal) {
                openBlob = new Blob([docResult.blob], { type: "application/pdf" });
              } else {
                const formatted = await formatDocumentBlobIfNeeded(docResult.blob, file.name, "text/html; charset=utf-8");
                openBlob = formatted.blob;
              }
            } else if (isImg || isVideoDoc || isAudioDoc || isHtmlDoc) {
              const mime = isImg
                ? docResult.blob.type || "image/png"
                : isVideoDoc
                ? docResult.blob.type || "video/mp4"
                : isAudioDoc
                ? docResult.blob.type || "audio/mpeg"
                : "text/html; charset=utf-8";
              openBlob = new Blob([docResult.blob], { type: mime });
            } else {
              const formatted = await formatDocumentBlobIfNeeded(docResult.blob, file.name, docResult.mimeType);
              openBlob = formatted.blob;
            }

            const tabUrl = URL.createObjectURL(openBlob);
            window.open(tabUrl, "_blank");
            setTimeout(() => URL.revokeObjectURL(tabUrl), 60000);
            notify(`Opened ${file.name} in browser viewer`, "success");
            return;
          }
        } catch {
          // Proceed to Source 3
        }
      }

      // Source 3: Fetch directly from /local-agent/document-content REST endpoint
      try {
        const isDesktopOrigin =
          typeof window !== "undefined" &&
          (window.location.protocol === "file:" ||
            Boolean((window as any).electronAPI?.isDesktop));
        const base = isDesktopOrigin ? "http://127.0.0.1:8000/api" : "/api";
        const token = getStoredToken();
        const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(
          `${base}/local-agent/document-content?path=${encodeURIComponent(exactPath)}`,
          { headers }
        );
        if (res.ok) {
          const resBlob = await res.blob();
          let openBlob: Blob;
          if (isPdfDoc) {
            const isReal = await isRealPdfBinary(resBlob);
            if (isReal) {
              openBlob = new Blob([resBlob], { type: "application/pdf" });
            } else {
              const formatted = await formatDocumentBlobIfNeeded(resBlob, file.name, "text/html; charset=utf-8");
              openBlob = formatted.blob;
            }
          } else if (isImg || isVideoDoc || isAudioDoc || isHtmlDoc) {
            const mime = isImg
              ? resBlob.type || "image/png"
              : isVideoDoc
              ? resBlob.type || "video/mp4"
              : isAudioDoc
              ? resBlob.type || "audio/mpeg"
              : "text/html; charset=utf-8";
            openBlob = new Blob([resBlob], { type: mime });
          } else {
            const formatted = await formatDocumentBlobIfNeeded(resBlob, file.name);
            openBlob = formatted.blob;
          }

          const tabUrl = URL.createObjectURL(openBlob);
          window.open(tabUrl, "_blank");
          setTimeout(() => URL.revokeObjectURL(tabUrl), 60000);
          notify(`Opened ${file.name} in browser viewer`, "success");
          return;
        }
      } catch {
        // Source 3 failed
      }

      notify(`Could not load ${file.name} to open. Use Preview to view inside the app or check local folder access.`, "warning");
    } catch (err: any) {
      notify(`Could not open ${file.name}: ${err?.message || "Unknown error"}`, "danger");
    } finally {
      setOpeningKey(null);
    }
  };

  const handleDownloadCopy = async () => {
    if (!previewFile) return;
    const exactPath = getExactPath(previewFile);
    try {
      let blob: Blob;
      const localFile =
        (await readBrowserLocalFile(exactPath)) ||
        (await readBrowserLocalFile(previewFile.path));
      if (localFile) {
        blob = localFile;
      } else if (api && typeof api.getDocumentBlob === "function") {
        const res = await api.getDocumentBlob(exactPath, true);
        blob = res.blob;
      } else {
        const url = `/api/local-agent/document-content?path=${encodeURIComponent(exactPath)}&download=true`;
        const token = getStoredToken();
        const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error("Download failed");
        blob = await res.blob();
      }
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = previewFile.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000);
      notify(`Downloaded ${previewFile.name}`, "success");
    } catch {
      if (blobUrl) {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = previewFile.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    }
  };

  const isPdf = (file: FileResultItem, mime?: string | null) => {
    return Boolean(mime && mime.includes("pdf"));
  };

  const isImage = (file: FileResultItem, mime?: string | null) => {
    if (mime && mime.startsWith("image/")) return true;
    const ext = file.name.toLowerCase();
    return (
      ext.endsWith(".png") ||
      ext.endsWith(".jpg") ||
      ext.endsWith(".jpeg") ||
      ext.endsWith(".gif") ||
      ext.endsWith(".webp") ||
      ext.endsWith(".bmp") ||
      ext.endsWith(".svg")
    );
  };

  const isVideo = (file: FileResultItem, mime?: string | null) => {
    if (mime && mime.startsWith("video/")) return true;
    const ext = file.name.toLowerCase();
    return (
      ext.endsWith(".mp4") ||
      ext.endsWith(".webm") ||
      ext.endsWith(".mov") ||
      ext.endsWith(".mkv") ||
      ext.endsWith(".avi") ||
      ext.endsWith(".m4v") ||
      ext.endsWith(".ogg")
    );
  };

  const isAudio = (file: FileResultItem, mime?: string | null) => {
    if (mime && mime.startsWith("audio/")) return true;
    const ext = file.name.toLowerCase();
    return (
      ext.endsWith(".mp3") ||
      ext.endsWith(".wav") ||
      ext.endsWith(".m4a") ||
      ext.endsWith(".aac") ||
      ext.endsWith(".flac") ||
      ext.endsWith(".oga") ||
      ext.endsWith(".opus")
    );
  };

  // Renders a distinct section of files (either File Name Matches or Document Content Matches)
  const renderSection = (
    sectionTitle: string,
    sectionSubtitle: string,
    sectionType: "name" | "content",
    fileList: FileResultItem[]
  ) => {
    if (!fileList.length) return null;

    return (
      <div className={`file-match-section file-match-${sectionType}`} key={sectionType}>
        <div className="file-section-header">
          <div className="file-section-title-wrap">
            {sectionType === "name" ? (
              <FolderSearch size={16} className="file-section-icon is-name" />
            ) : (
              <FileSearch size={16} className="file-section-icon is-content" />
            )}
            <h4 className="file-section-title">{sectionTitle}</h4>
            <span className="file-section-count-badge">
              {fileList.length} {fileList.length === 1 ? "file" : "files"}
            </span>
          </div>
          <span className="file-section-subtitle">{sectionSubtitle}</span>
        </div>

        <div className="file-results-table-wrapper">
          <table className="file-results-table">
            <thead>
              <tr>
                <th className="col-name">File Name</th>
                <th className="col-path">File Path</th>
                <th className="col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {fileList.map((file, idx) => {
                const exactPath = getExactPath(file);
                const uniqueKey = `${sectionType}-${exactPath}-${idx}`;
                const isCopied = copiedKey === uniqueKey;
                const isOpening = openingKey === uniqueKey;

                return (
                  <tr key={uniqueKey} className="file-results-row">
                    <td className="cell-name">
                      <div className="file-cell-main">
                        <div
                          className="file-name-wrapper"
                          onClick={() => openPreview(file)}
                          title="Click to view full document in browser memory"
                        >
                          <FileText className="file-icon" />
                          <span className="file-name-text" title={file.name}>
                            {file.name}
                          </span>
                        </div>
                      </div>
                    </td>

                    <td className="cell-path">
                      <div
                        className="file-path-interactive"
                        onClick={() => handleCopyPath(exactPath, uniqueKey)}
                        title="Click to copy exact path"
                      >
                        <code className="file-path-code">{exactPath}</code>
                        <Copy className="file-copy-icon-subtle" />
                      </div>
                    </td>

                    <td className="cell-action">
                      <div className="file-row-actions">
                        <button
                          type="button"
                          className="file-preview-btn"
                          onClick={() => openPreview(file)}
                          title={`Preview ${file.name} in browser memory`}
                        >
                          <Eye className="btn-icon" />
                          <span>Preview</span>
                        </button>
                        <button
                          type="button"
                          className="file-open-btn"
                          disabled={isOpening}
                          onClick={() => handleOpen(file, uniqueKey)}
                          title={`Open ${file.name} in desktop or browser viewer`}
                        >
                          {isOpening ? (
                            <>
                              <Loader2 className="btn-icon animate-spin" />
                              <span>Opening...</span>
                            </>
                          ) : (
                            <>
                              <ExternalLink className="btn-icon" />
                              <span>Open</span>
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          className={`file-copy-btn ${isCopied ? "is-copied" : ""}`}
                          onClick={() => handleCopyPath(exactPath, uniqueKey)}
                          title="Copy exact file path to clipboard"
                        >
                          {isCopied ? <Check className="btn-icon" /> : <Copy className="btn-icon" />}
                          <span>{isCopied ? "Copied!" : "Copy Path"}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="file-results-container">
      {/* SECTION 1: FILE NAME MATCHES */}
      {renderSection(
        "File Name Matches",
        "Direct match against the document file name",
        "name",
        fileNameMatches
      )}

      {/* SECTION 2: DOCUMENT CONTENT MATCHES */}
      {renderSection(
        "Document Content Matches",
        "Matched from information found inside document content",
        "content",
        contentMatches
      )}

      {/* In-app Ephemeral Document Preview Modal */}
      {previewFile && (
        <Modal
          title={previewFile.name}
          onClose={closePreview}
          size="xl"
          footer={
            <div className="preview-modal-footer">
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleCopyPath(getExactPath(previewFile))}
                  title="Copy path"
                >
                  {copiedModal ? (
                    <Check className="w-4 h-4 mr-1 text-green-600" />
                  ) : (
                    <Copy className="w-4 h-4 mr-1" />
                  )}
                  {copiedModal ? "Copied!" : "Copy File Path"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleDownloadCopy}
                  title="Save original copy to your computer"
                >
                  <Download className="w-4 h-4 mr-1" />
                  Download Copy
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleOpen(previewFile, "modal-open")}
                  title="Open document in a new browser tab"
                >
                  <ExternalLink className="w-4 h-4 mr-1" />
                  Open in New Tab
                </Button>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <Button variant="secondary" size="sm" onClick={closePreview}>
                  Close
                </Button>
              </div>
            </div>
          }
        >
          <div className="document-preview-modal-content">
            {blobLoading && (
              <div className="preview-loading-state">
                <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
                <p>Loading document content into browser memory…</p>
              </div>
            )}

            {blobError && (
              <div className="preview-error-state">
                <AlertCircle className="w-8 h-8 text-amber-500 mb-2" />
                <p style={{ fontWeight: 600, color: "var(--text, #f9fafb)" }}>Could not render visual preview</p>
                <p style={{ fontSize: "13px", color: "var(--text-muted, #8e8e8e)", margin: "4px 0 12px" }}>
                  {blobError}
                </p>
                <div style={{ display: "flex", gap: "8px" }}>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => handleOpen(previewFile, "modal-open")}
                  >
                    Open in Desktop App
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleCopyPath(getExactPath(previewFile))}
                  >
                    Copy Path
                  </Button>
                </div>
              </div>
            )}

            {!blobLoading && !blobError && blobUrl && (
              <div className="preview-display-viewport">
                {isPdf(previewFile, blobMime) ? (
                  <iframe
                    src={`${blobUrl}#toolbar=0`}
                    title={previewFile.name}
                    className="preview-iframe"
                  />
                ) : isImage(previewFile, blobMime) ? (
                  <div className="preview-image-wrap">
                    <img src={blobUrl} alt={previewFile.name} className="preview-image" />
                  </div>
                ) : isVideo(previewFile, blobMime) ? (
                  <div className="preview-video-wrap">
                    <video src={blobUrl} controls className="preview-video" />
                  </div>
                ) : isAudio(previewFile, blobMime) ? (
                  <div className="preview-audio-wrap">
                    <audio src={blobUrl} controls className="preview-audio" />
                  </div>
                ) : (
                  <iframe src={blobUrl} title={previewFile.name} className="preview-iframe" />
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Folder,
  Loader2,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import {
  extractDroppedFoldersFromDataTransfer,
  type DroppedFolderCandidate,
} from "../../lib/browserFolderSync";

export type PreviewableFolderFile = {
  relativePath: string;
  filename: string;
  fileType: string;
  sizeBytes: number;
  chunkCount?: number;
};

type Props = {
  open: boolean;
  mode: "connect" | "preview";
  candidates: DroppedFolderCandidate[];
  onCandidatesChange: (next: DroppedFolderCandidate[]) => void;
  onConfirmConnect: (candidates: DroppedFolderCandidate[]) => Promise<void>;
  onBrowseWithPicker?: () => Promise<void>;
  browsingWithPicker?: boolean;
  connecting?: boolean;
  previewFolderName?: string;
  previewFolderPath?: string;
  previewFiles?: PreviewableFolderFile[];
  previewLoading?: boolean;
  onClose: () => void;
};

const MAX_RENDERED_PREVIEW_ROWS = 250;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function extBadgeLabel(fileTypeOrName: string): string {
  const clean = fileTypeOrName.replace(/^\./, "").trim().toUpperCase();
  if (!clean) return "FILE";
  return clean.slice(0, 5);
}

export function FolderConnectModal({
  open,
  mode,
  candidates,
  onCandidatesChange,
  onConfirmConnect,
  onBrowseWithPicker,
  browsingWithPicker = false,
  connecting = false,
  previewFolderName = "",
  previewFolderPath = "",
  previewFiles = [],
  previewLoading = false,
  onClose,
}: Props) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [extractingDrop, setExtractingDrop] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const dragDepthRef = useRef(0);

  // Prevent browser from navigating away if user drops outside the dropbox while modal is open
  useEffect(() => {
    if (!open || mode !== "connect") return;
    const preventNav = (e: globalThis.DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", preventNav);
    window.addEventListener("drop", preventNav);
    return () => {
      window.removeEventListener("dragover", preventNav);
      window.removeEventListener("drop", preventNav);
    };
  }, [open, mode]);

  useEffect(() => {
    if (!open) {
      setIsDragOver(false);
      setExtractingDrop(false);
      setDropError(null);
      setSearchTerm("");
      dragDepthRef.current = 0;
    }
  }, [open]);

  const totalSupported = useMemo(
    () => candidates.reduce((sum, c) => sum + c.supportedCount, 0),
    [candidates],
  );
  const totalSkipped = useMemo(
    () => candidates.reduce((sum, c) => sum + c.skippedCount, 0),
    [candidates],
  );
  const totalBytes = useMemo(
    () => candidates.reduce((sum, c) => sum + c.totalSizeBytes, 0),
    [candidates],
  );

  const flatCandidateFiles = useMemo(() => {
    const out: Array<{
      folderName: string;
      relativePath: string;
      name: string;
      ext: string;
      size: number;
    }> = [];
    for (const c of candidates) {
      for (const f of c.files) {
        if (!f.supported) continue;
        out.push({
          folderName: c.folderName,
          relativePath: candidates.length > 1 ? `${c.folderName}/${f.relativePath}` : f.relativePath,
          name: f.name,
          ext: f.ext,
          size: f.size,
        });
      }
    }
    return out;
  }, [candidates]);

  const filteredCandidateFiles = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return flatCandidateFiles;
    return flatCandidateFiles.filter(
      (f) => f.relativePath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q),
    );
  }, [flatCandidateFiles, searchTerm]);

  const filteredPreviewFiles = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return previewFiles;
    return previewFiles.filter(
      (f) =>
        f.relativePath.toLowerCase().includes(q) ||
        f.filename.toLowerCase().includes(q) ||
        f.fileType.toLowerCase().includes(q),
    );
  }, [previewFiles, searchTerm]);

  if (!open) return null;

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    setDropError(null);
    setExtractingDrop(true);
    try {
      const extracted = await extractDroppedFoldersFromDataTransfer(e.dataTransfer);
      if (extracted.length === 0) {
        setDropError(
          "No folder or files were detected in that drop. Drag a folder directly from Windows Explorer or Mac Finder.",
        );
        return;
      }
      setSearchTerm("");
      onCandidatesChange(extracted);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not read the dropped folder.";
      setDropError(msg);
    } finally {
      setExtractingDrop(false);
    }
  };

  if (mode === "preview") {
    const displayed = filteredPreviewFiles.slice(0, MAX_RENDERED_PREVIEW_ROWS);
    const remaining = filteredPreviewFiles.length - displayed.length;

    return (
      <Modal
        title={`Folder Preview — ${previewFolderName || "Connected Folder"}`}
        size="lg"
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div style={{ display: "grid", gap: "14px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "10px",
              padding: "12px 14px",
              borderRadius: "10px",
              background: "var(--bg-subtle, #f8fafc)",
              border: "1px solid var(--border, #e2e8f0)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "8px",
                  background: "var(--primary-50, #eff8fa)",
                  color: "var(--primary-600, #006583)",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                <Folder size={18} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "var(--text, #0f172a)" }}>
                  {previewFolderName || "Local Folder"}
                </div>
                {previewFolderPath && (
                  <div
                    style={{
                      fontSize: "0.78rem",
                      color: "var(--text-muted, #64748b)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {previewFolderPath}
                  </div>
                )}
              </div>
            </div>

            <div
              style={{
                padding: "4px 10px",
                borderRadius: "9999px",
                background: "var(--success-bg, #f0fdf4)",
                border: "1px solid var(--success-border, #bbf7d0)",
                color: "var(--success-fg, #15803d)",
                fontSize: "0.78rem",
                fontWeight: 700,
              }}
            >
              {previewFiles.length} {previewFiles.length === 1 ? "file" : "files"}
            </div>
          </div>

          {previewLoading ? (
            <div
              style={{
                padding: "32px 16px",
                textAlign: "center",
                color: "var(--text-muted, #64748b)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "10px",
              }}
            >
              <Loader2 size={22} className="animate-spin" />
              <span style={{ fontSize: "0.88rem" }}>Loading folder file list...</span>
            </div>
          ) : previewFiles.length === 0 ? (
            <div
              style={{
                padding: "24px 16px",
                textAlign: "center",
                borderRadius: "10px",
                border: "1px dashed var(--border, #e2e8f0)",
                background: "var(--bg-subtle, #f8fafc)",
                color: "var(--text-muted, #64748b)",
                fontSize: "0.88rem",
              }}
            >
              No local file index cache is currently available in this browser session for preview.
              The folder remains connected on your workspace.
            </div>
          ) : (
            <>
              {previewFiles.length > 6 && (
                <div style={{ position: "relative" }}>
                  <Search
                    size={15}
                    style={{
                      position: "absolute",
                      left: "12px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "var(--text-muted, #64748b)",
                    }}
                  />
                  <input
                    type="search"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Filter files by name or path..."
                    style={{
                      width: "100%",
                      padding: "8px 12px 8px 34px",
                      borderRadius: "8px",
                      border: "1px solid var(--border, #e2e8f0)",
                      background: "var(--bg-surface, #ffffff)",
                      color: "var(--text, #0f172a)",
                      fontSize: "0.86rem",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              )}

              <div
                style={{
                  maxHeight: "320px",
                  overflowY: "auto",
                  borderRadius: "10px",
                  border: "1px solid var(--border, #e2e8f0)",
                  background: "var(--bg-surface, #ffffff)",
                }}
              >
                {displayed.map((file, idx) => (
                  <div
                    key={`${file.relativePath}-${idx}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "12px",
                      padding: "9px 14px",
                      borderBottom:
                        idx < displayed.length - 1
                          ? "1px solid var(--border-subtle, #f1f5f9)"
                          : "none",
                      fontSize: "0.84rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          fontSize: "0.68rem",
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: "4px",
                          background: "var(--primary-50, #eff8fa)",
                          color: "var(--primary-700, #005166)",
                          flexShrink: 0,
                          letterSpacing: "0.03em",
                        }}
                      >
                        {extBadgeLabel(file.fileType || file.filename.split(".").pop() || "")}
                      </span>
                      <span
                        style={{
                          color: "var(--text, #0f172a)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={file.relativePath}
                      >
                        {file.relativePath}
                      </span>
                    </div>
                    <span style={{ color: "var(--text-muted, #64748b)", fontSize: "0.78rem", flexShrink: 0 }}>
                      {formatBytes(file.sizeBytes)}
                    </span>
                  </div>
                ))}
                {remaining > 0 && (
                  <div
                    style={{
                      padding: "8px 14px",
                      fontSize: "0.78rem",
                      color: "var(--text-muted, #64748b)",
                      background: "var(--bg-subtle, #f8fafc)",
                      textAlign: "center",
                    }}
                  >
                    Showing {displayed.length} of {filteredPreviewFiles.length} files ({remaining} more)
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>
    );
  }

  // Connect mode: Step 2 (Preview & Nanvi Confirmation) vs Step 1 (Drag & Drop Zone)
  const hasCandidates = candidates.length > 0;
  const displayedDropped = filteredCandidateFiles.slice(0, MAX_RENDERED_PREVIEW_ROWS);
  const remainingDropped = filteredCandidateFiles.length - displayedDropped.length;

  return (
    <Modal
      title={hasCandidates ? "Confirm Folder Connection" : "Connect Local Folder"}
      size="lg"
      onClose={() => {
        if (!connecting) onClose();
      }}
      footer={
        hasCandidates ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={connecting}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setDropError(null);
                setSearchTerm("");
                onCandidatesChange([]);
              }}
              disabled={connecting}
            >
              Choose Different Folder
            </Button>
            <Button
              variant="primary"
              loading={connecting}
              disabled={totalSupported === 0 || connecting}
              onClick={() => void onConfirmConnect(candidates)}
            >
              {connecting
                ? "Connecting..."
                : candidates.length > 1
                  ? `Connect ${candidates.length} Folders`
                  : "Connect Folder"}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose} disabled={browsingWithPicker}>
            Cancel
          </Button>
        )
      }
    >
      {!hasCandidates ? (
        <div style={{ display: "grid", gap: "16px" }}>
          <div
            data-testid="nanvi-folder-dropzone"
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={(e) => void handleDrop(e)}
            style={{
              padding: "36px 24px",
              borderRadius: "14px",
              border: `2px dashed ${isDragOver ? "var(--primary-600, #006583)" : "var(--border-input, #94a3b8)"}`,
              background: isDragOver
                ? "var(--primary-50, #eff8fa)"
                : "var(--bg-subtle, #f8fafc)",
              textAlign: "center",
              transition: "all 0.16s ease",
              display: "grid",
              gap: "12px",
              justifyItems: "center",
            }}
          >
            <div
              style={{
                width: "56px",
                height: "56px",
                borderRadius: "14px",
                background: isDragOver ? "var(--primary-600, #006583)" : "var(--primary-100, #d8edf2)",
                color: isDragOver ? "#ffffff" : "var(--primary-700, #005166)",
                display: "grid",
                placeItems: "center",
                transition: "all 0.16s ease",
              }}
            >
              {extractingDrop ? <Loader2 size={26} className="animate-spin" /> : <Folder size={26} />}
            </div>

            <div>
              <div
                style={{
                  fontSize: "1.05rem",
                  fontWeight: 700,
                  color: "var(--text, #0f172a)",
                  marginBottom: "6px",
                }}
              >
                {extractingDrop
                  ? "Reading folder contents..."
                  : isDragOver
                    ? "Release to preview folder & files"
                    : "Drag & drop your folder here"}
              </div>
              <p
                style={{
                  margin: "0 auto",
                  maxWidth: "460px",
                  fontSize: "0.88rem",
                  color: "var(--text-secondary, #334155)",
                  lineHeight: 1.5,
                }}
              >
                Open Windows Explorer or Mac Finder and drag any folder (or files) into this window to
                preview its contents before connecting.
              </p>
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: "8px",
                marginTop: "4px",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "4px 10px",
                  borderRadius: "9999px",
                  background: "var(--success-bg, #f0fdf4)",
                  border: "1px solid var(--success-border, #bbf7d0)",
                  color: "var(--success-fg, #15803d)",
                  fontSize: "0.76rem",
                  fontWeight: 600,
                }}
              >
                <ShieldCheck size={13} />
                No browser upload warning
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "4px 10px",
                  borderRadius: "9999px",
                  background: "var(--bg-surface, #ffffff)",
                  border: "1px solid var(--border, #e2e8f0)",
                  color: "var(--text-secondary, #334155)",
                  fontSize: "0.76rem",
                  fontWeight: 600,
                }}
              >
                Works in Chrome, Edge, Firefox & Safari
              </span>
            </div>
          </div>

          {dropError && (
            <div
              role="alert"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "10px 14px",
                borderRadius: "8px",
                background: "var(--danger-bg, #fef2f2)",
                border: "1px solid var(--danger-border, #fecaca)",
                color: "var(--danger-fg, #b91c1c)",
                fontSize: "0.84rem",
                fontWeight: 500,
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{dropError}</span>
            </div>
          )}

          {onBrowseWithPicker && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "10px",
                padding: "12px 14px",
                borderRadius: "10px",
                background: "var(--bg-sunken, #f1f5f9)",
                border: "1px solid var(--border, #e2e8f0)",
              }}
            >
              <div style={{ fontSize: "0.8rem", color: "var(--text-secondary, #334155)", lineHeight: 1.4 }}>
                <strong>On mobile/tablet or prefer manual browse?</strong>
                <div style={{ color: "var(--text-muted, #64748b)", fontSize: "0.75rem" }}>
                  Standard browser pickers show your browser&apos;s built-in permission prompt.
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                loading={browsingWithPicker}
                onClick={() => void onBrowseWithPicker()}
              >
                Browse with Browser Picker
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: "grid", gap: "14px" }}>
          {/* Nanvi Branded Confirmation Banner */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "12px",
              padding: "14px 16px",
              borderRadius: "12px",
              background: "var(--primary-50, #eff8fa)",
              border: "1px solid var(--primary-200, #b5dce5)",
            }}
          >
            <div
              style={{
                width: "38px",
                height: "38px",
                borderRadius: "10px",
                background: "var(--primary-600, #006583)",
                color: "#ffffff",
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              <CheckCircle2 size={20} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: "0.98rem", color: "var(--text, #0f172a)" }}>
                {candidates.length > 1
                  ? `Would you like to connect these ${candidates.length} folders to Nanvi?`
                  : `Would you like to connect "${candidates[0].folderName}" to Nanvi?`}
              </div>
              <div style={{ fontSize: "0.82rem", color: "var(--text-secondary, #334155)", marginTop: "3px" }}>
                Review the detected documents below. Only supported files are indexed into your personal
                Nanvi workspace for search and AI answers.
              </div>
            </div>
          </div>

          {/* Folder Summary Chips */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
            {candidates.map((c, idx) => (
              <div
                key={`${c.folderName}-${idx}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "6px 12px",
                  borderRadius: "8px",
                  background: "var(--bg-subtle, #f8fafc)",
                  border: "1px solid var(--border, #e2e8f0)",
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  color: "var(--text, #0f172a)",
                }}
              >
                <Folder size={14} style={{ color: "var(--primary-600, #006583)" }} />
                <span>{c.folderName}</span>
                <span style={{ color: "var(--text-muted, #64748b)", fontWeight: 500 }}>
                  ({c.supportedCount} {c.supportedCount === 1 ? "file" : "files"} · {formatBytes(c.totalSizeBytes)})
                </span>
              </div>
            ))}
            {totalSkipped > 0 && (
              <span style={{ fontSize: "0.78rem", color: "var(--text-muted, #64748b)" }}>
                · {totalSkipped} unsupported or system {totalSkipped === 1 ? "file" : "files"} excluded
              </span>
            )}
          </div>

          {totalSupported === 0 ? (
            <div
              role="alert"
              style={{
                padding: "16px",
                borderRadius: "10px",
                background: "var(--warning-bg, #fffbeb)",
                border: "1px solid var(--warning-border, #fde68a)",
                color: "var(--warning-fg, #b45309)",
                fontSize: "0.86rem",
                lineHeight: 1.5,
              }}
            >
              No supported documents were found in this folder. Supported formats: PDF, Word
              (.docx), Excel (.xlsx/.csv), PowerPoint (.pptx), TXT, Markdown, JSON, HTML/XML, and
              images.
            </div>
          ) : (
            <>
              {flatCandidateFiles.length > 6 && (
                <div style={{ position: "relative" }}>
                  <Search
                    size={15}
                    style={{
                      position: "absolute",
                      left: "12px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "var(--text-muted, #64748b)",
                    }}
                  />
                  <input
                    type="search"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder={`Search ${flatCandidateFiles.length} files...`}
                    style={{
                      width: "100%",
                      padding: "8px 12px 8px 34px",
                      borderRadius: "8px",
                      border: "1px solid var(--border, #e2e8f0)",
                      background: "var(--bg-surface, #ffffff)",
                      color: "var(--text, #0f172a)",
                      fontSize: "0.86rem",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              )}

              {/* Scrollable File Preview List */}
              <div
                style={{
                  maxHeight: "240px",
                  overflowY: "auto",
                  borderRadius: "10px",
                  border: "1px solid var(--border, #e2e8f0)",
                  background: "var(--bg-surface, #ffffff)",
                }}
              >
                {displayedDropped.map((file, idx) => (
                  <div
                    key={`${file.relativePath}-${idx}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "12px",
                      padding: "8px 14px",
                      borderBottom:
                        idx < displayedDropped.length - 1
                          ? "1px solid var(--border-subtle, #f1f5f9)"
                          : "none",
                      fontSize: "0.83rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "9px", minWidth: 0, flex: 1 }}>
                      <FileText
                        size={14}
                        style={{ color: "var(--primary-600, #006583)", flexShrink: 0 }}
                      />
                      <span
                        style={{
                          fontSize: "0.68rem",
                          fontWeight: 700,
                          padding: "2px 6px",
                          borderRadius: "4px",
                          background: "var(--bg-sunken, #f1f5f9)",
                          color: "var(--text-secondary, #334155)",
                          flexShrink: 0,
                        }}
                      >
                        {extBadgeLabel(file.ext)}
                      </span>
                      <span
                        style={{
                          color: "var(--text, #0f172a)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={file.relativePath}
                      >
                        {file.relativePath}
                      </span>
                    </div>
                    <span style={{ color: "var(--text-muted, #64748b)", fontSize: "0.78rem", flexShrink: 0 }}>
                      {formatBytes(file.size)}
                    </span>
                  </div>
                ))}
                {remainingDropped > 0 && (
                  <div
                    style={{
                      padding: "8px 14px",
                      fontSize: "0.78rem",
                      color: "var(--text-muted, #64748b)",
                      background: "var(--bg-subtle, #f8fafc)",
                      textAlign: "center",
                    }}
                  >
                    Showing {displayedDropped.length} of {filteredCandidateFiles.length} files ({remainingDropped} more)
                  </div>
                )}
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "0.78rem",
                  color: "var(--text-muted, #64748b)",
                }}
              >
                <span>
                  Total ready to connect: <strong>{totalSupported} files</strong> ({formatBytes(totalBytes)})
                </span>
                <span>Indexed privately for your account</span>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}


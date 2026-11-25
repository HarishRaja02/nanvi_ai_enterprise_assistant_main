import { memo, useMemo, useState } from "react";
import { Check, Copy, Download, RefreshCw, Sparkles, FileText, Eye } from "lucide-react";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { MarkdownContent } from "./MarkdownContent";
import { SourceList } from "./SourceList";
import { TraceDisclosure } from "./TraceDisclosure";
import { BentoMetrics } from "./BentoMetrics";
import { SourceSelector } from "./SourceSelector";
import { FileResultsTable } from "./FileResultsTable";
import { cleanBrowserDisplayPath } from "../../lib/browserFolderSync";
import { generateFollowupSuggestions } from "../../lib/followupSuggestions";
import { parseSummaryAndExcerpts } from "../../lib/formatExcerpt";
import { useCountdown } from "../../hooks/useCountdown";
import { copyText } from "../../lib/clipboard";
import { formatTime, humanize, initials } from "../../lib/format";
import type { ContextMetric } from "../../lib/contextIntelligence";
import type { SourceView } from "../../lib/sources";
import type { Message, FileResultItem } from "../../types";
import type { NanviApiClient, UserIdentity } from "../../api";

type Props = {
  message: Message;
  api?: NanviApiClient;
  identity?: UserIdentity | null;
  userQuery?: string;
  onOpenSource: (source: SourceView) => void;
  onDownload: (reportId: string) => void;
  onRetry: (messageId: string) => void;
  onFollowup?: (prompt: string) => void;
  onSelectSource?: (query: string, source: string) => void;
};

function UserHead({ time, identity }: { time: number; identity?: UserIdentity | null }) {
  const rawName = identity?.name || identity?.subject;
  const name = rawName && rawName.toLowerCase() !== "user" ? rawName : "You";
  const userInitials = initials(name === "You" ? "User" : name) || "U";

  return (
    <div className="msg-head msg-head-user">
      <time className="msg-time" dateTime={new Date(time).toISOString()}>
        {formatTime(time)}
      </time>
      <span className="msg-author">{name}</span>
      <span className="avatar avatar-user" aria-hidden="true">
        {userInitials}
      </span>
    </div>
  );
}

function AssistantHead({ time, capability, dataSource }: { time: number; capability?: string; dataSource?: string }) {
  const isDocSearch = capability && (capability.includes("document_search") || capability.includes("file_search"));
  const isReport = capability && capability.includes("report");
  const isRag = capability && (capability.includes("knowledge") || capability.includes("rag"));
  const isData = capability && (capability.includes("database") || capability.includes("data"));
  const isWeb = capability && capability.includes("web_search");
  const isEmail = capability && capability.includes("email");
  const isSynthetic = dataSource === "synthetic";

  return (
    <div className="msg-head msg-head-assistant">
      <span className="avatar avatar-bot" aria-hidden="true">N</span>
      <span className="msg-author">Nanvi Assistant</span>
      {capability && (
        <Badge
          tone={isDocSearch ? "primary" : isReport ? "primary" : isRag ? "accent" : isData ? "primary" : isWeb ? "accent" : "neutral"}
          className={isRag ? "rag-badge" : undefined}
        >
          {isDocSearch
            ? "🔍 Document Search"
            : isReport
              ? "📄 Document Generator"
              : isRag
                ? "Document Search"
                : isData
                  ? "📊 Database Query"
                  : isWeb
                    ? "🌐 Web Search"
                    : isEmail
                      ? "✉️ Email Search"
                      : humanize(capability)}
        </Badge>
      )}
      {isSynthetic && (
        <Badge tone="warning" className="synthetic-badge">
          ⚠️ Synthetic Data
        </Badge>
      )}
      <time className="msg-time" dateTime={new Date(time).toISOString()}>
        {formatTime(time)}
      </time>
    </div>
  );
}

function ErrorMessage({ message, onRetry }: { message: Message; onRetry: (id: string) => void }) {
  const wait = useCountdown(message.retryAfter);
  return (
    <div className="msg msg-assistant">
      <Alert
        tone="danger"
        title="Nanvi couldn't complete that request"
        actions={
          <Button
            size="sm"
            variant="secondary"
            icon={RefreshCw}
            disabled={wait > 0}
            onClick={() => onRetry(message.id)}
          >
            {wait > 0 ? `Retry in ${wait}s` : "Retry request"}
          </Button>
        }
      >
        {message.text}
      </Alert>
    </div>
  );
}

function extractKeyMetrics(text: string): ContextMetric[] {
  const metrics: ContextMetric[] = [];
  // Match currency values e.g. $120,450
  const currencyMatches = text.match(/(\$|€|£|₹)\s?[\d,]+(\.\d+)?(\s?[MKmk]|\s?million|\s?billion)?/g);
  if (currencyMatches && currencyMatches.length > 0) {
    const uniqueCurrencies = Array.from(new Set(currencyMatches)).slice(0, 2);
    uniqueCurrencies.forEach((val, idx) => {
      metrics.push({
        id: `m-cur-${idx}`,
        label: idx === 0 ? "Total / Value" : "Related Amount",
        value: val,
        tone: "primary",
      });
    });
  }

  // Match percentages
  const pctMatches = text.match(/\b\d+(\.\d+)?%/g);
  if (pctMatches && pctMatches.length > 0) {
    metrics.push({
      id: "m-pct",
      label: "Rate / Variance",
      value: pctMatches[0],
      tone: "accent",
    });
  }

  return metrics;
}

function MessageItemBase({
  message,
  api,
  identity,
  userQuery,
  onOpenSource,
  onDownload,
  onRetry,
  onFollowup,
  onSelectSource,
}: Props) {
  const notify = useToast();
  const [copied, setCopied] = useState(false);

  // Extract key figures for Bento highlight if present
  const metrics = useMemo(() => {
    if (message.role !== "assistant" || message.error) return [];
    return extractKeyMetrics(message.text);
  }, [message]);
  const isDocumentAnswer = Boolean(message.capability?.includes("knowledge") || message.capability?.includes("rag"));

  if (message.role === "user") {
    const copyUser = async () => {
      const ok = await copyText(message.text);
      if (ok) notify("Question copied to clipboard.", "success");
    };

    return (
      <div className="msg msg-user">
        <UserHead time={message.createdAt} identity={identity} />
        <div className="user-bubble" title="Click to copy question" onClick={copyUser}>
          {message.text}
        </div>
      </div>
    );
  }

  if (message.error) return <ErrorMessage message={message} onRetry={onRetry} />;

  const copy = async () => {
    const ok = await copyText(message.text);
    if (ok) {
      setCopied(true);
      notify("Answer copied to clipboard.", "success");
      setTimeout(() => setCopied(false), 2000);
    } else {
      notify("Couldn't copy the answer.", "danger");
    }
  };

  // Derive effective file results from structured payload, message sources, or bracketed file citations
  const effectiveFileResults: FileResultItem[] = useMemo(() => {
    const normalizePathKey = (p: string) =>
      cleanBrowserDisplayPath(p).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();

    if (message.fileResults && message.fileResults.length > 0) {
      const seen = new Set<string>();
      const cleaned: FileResultItem[] = [];
      for (const item of message.fileResults) {
        const cleanPath = cleanBrowserDisplayPath(item.full_path || item.path);
        const key = normalizePathKey(cleanPath || item.name);
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        cleaned.push({
          ...item,
          name: item.name.replace(/^\[[^\]]+\]\s*/, "").trim() || item.name,
          path: cleanPath,
          full_path: cleanPath,
          display_path: item.display_path ? cleanBrowserDisplayPath(item.display_path) : cleanPath,
          open_url: item.open_url ? cleanBrowserDisplayPath(item.open_url) : cleanPath,
        });
      }
      return cleaned;
    }
    const derived: FileResultItem[] = [];
    const seen = new Set<string>();

    // 1. Check sources for files
    if (message.sources && message.sources.length > 0) {
      for (const s of message.sources) {
        const rawTitle = (s.title || "").replace(/^\[[^\]]+\]\s*/, "").replace(/\s*\([^)]*\)$/, "").trim();
        const loc = cleanBrowserDisplayPath((s.location || s.href || "").replace(/^Uploads\/Uploads\//i, "Uploads/"));
        const fn = (rawTitle.split(/[\\/]/).pop() || rawTitle).replace(/^\[[^\]]+\]\s*/, "").trim();
        const key = normalizePathKey(loc || fn);
        if (loc && (loc.includes("\\") || loc.includes("/") || fn.includes("."))) {
          if (key && !seen.has(key)) {
            seen.add(key);
            derived.push({
              name: fn,
              path: loc,
              full_path: loc,
              display_path: loc,
              type: fn.split(".").pop() || "file",
              open_url: loc,
              source: "knowledge",
            });
          }
        }
      }
    }

    // 2. Check message text for file header citations: [folder / filename.ext (location)]
    const regex = /\[(?:(.*?)\s*\/\s*)?(.+?\.(?:pdf|docx|xlsx|csv|txt|md|pptx|png|jpe?g|webp|bmp|tiff?|gif))(?:\s*\(([^\)]+)\))?\]/gi;
    let m;
    while ((m = regex.exec(message.text || "")) !== null) {
      const folder = m[1]?.trim();
      const filename = m[2]?.trim();
      const loc = m[3]?.trim();
      const full = cleanBrowserDisplayPath(loc || (folder ? `${folder}/${filename}` : filename));
      const key = normalizePathKey(full || filename);
      if (filename && !seen.has(key)) {
        seen.add(key);
        derived.push({
          name: filename,
          path: full,
          full_path: full,
          display_path: full,
          type: filename.split(".").pop() || "file",
          open_url: full,
          source: "knowledge",
        });
      }
    }

    return derived;
  }, [message.fileResults, message.sources, message.text]);

  // Clean summary text to display below file results (strip redundant raw markdown tables only, preserving excerpts & notices)
  // Clean summary text to display below file results (strip redundant raw markdown tables & duplicate lead-ins)
  const cleanSummaryText = useMemo(() => {
    if (!message.text) return "";
    let cleaned = message.text.replace(/\r\n?/g, "\n");
    cleaned = cleaned.replace(/(?:^|\n)[ \t]*\|[ \t]*File Name[ \t]*\|[ \t]*(?:File Path|Path)[ \t]*\|[^\n]*\n[ \t]*\|[ \t:-]*(?:\|[ \t:-]*)*\|?[ \t]*(?:\n[ \t]*\|[^\n]*)*/gi, "");
    cleaned = cleaned.replace(/(?:^|\n)[ \t]*\|[ \t]*#[ \t]*\|[ \t]*File Name[ \t]*\|[^\n]*\n[ \t]*\|[ \t:-]*(?:\|[ \t:-]*)*\|?[ \t]*(?:\n[ \t]*\|[^\n]*)*/gi, "");
    // Strip redundant "Found N matching documents in Local Storage:" header only when substantive summary text follows (not excerpts-only)
    const strippedMatchHdr = cleaned.replace(
      /^\s*(?:Found|Showing)\s+(?:\*\*)?\d+(?:[–-]\d+)?(?:\*\*)?(?:\s+of\s+(?:\*\*)?\d+(?:\*\*)?)?\s+matching documents?\s+in\s+(?:\*\*)?Local Storage(?:\*\*)?:?\s*\n+/i,
      "",
    ).trim();
    if (strippedMatchHdr && !/^(?:\*\*|#+\s*)?(?:Relevant Document Excerpts|Document Highlights|Key Excerpts)/i.test(strippedMatchHdr)) {
      cleaned = strippedMatchHdr;
    }
    cleaned = cleaned.replace(/^\s*(?:\*\*)?Structured Invoice Summary(?:\s*\([^)]*\))?:?(?:\*\*)?\s*\n+/i, "");
    return cleaned.trim();
  }, [message.text]);

  const parsedSummary = useMemo(
    () => parseSummaryAndExcerpts(cleanSummaryText),
    [cleanSummaryText],
  );

  const openMatchedPreview = (filename: string) => {
    const match = effectiveFileResults.find(
      (f) => f.name.toLowerCase() === filename.toLowerCase(),
    );
    if (!match) return;
    window.dispatchEvent(new CustomEvent("nanvi:preview-file", { detail: match }));
  };

  // Generate contextual follow-up suggestions based on query + response + domain
  const followupSuggestions = useMemo(() => {
    if (message.role !== "assistant" || message.error) return [];
    return generateFollowupSuggestions({
      userQuery,
      responseText: message.text || "",
      capability: message.capability,
      hasFiles: effectiveFileResults.length > 0,
      hasTables: (message.text || "").includes("|"),
      fileNames: effectiveFileResults.map((f) => f.name),
    });
  }, [message.role, message.error, message.text, message.capability, userQuery, effectiveFileResults]);

  return (
    <article className="msg msg-assistant" aria-label="Answer from Nanvi">
      <AssistantHead time={message.createdAt} capability={message.capability} dataSource={message.dataSource} />

      {/* Render Bento Metrics Strip if key figures are detected */}
      {metrics.length > 1 && !isDocumentAnswer && !message.fileResults?.length && (
        <BentoMetrics metrics={metrics} title="Key Figures Detected" className="msg-bento-metrics" />
      )}

      {/* Interactive Source Selection Buttons */}
      {message.sourceSelectionRequired && onSelectSource && (
        <SourceSelector
          onSelect={(source) => onSelectSource(message.pendingSearchQuery || message.text, source)}
        />
      )}

      {/* RESULTS FIRST: Display relevant source files first, summary / explanation below */}
      {effectiveFileResults && effectiveFileResults.length > 0 ? (
        <div className="file-search-result-block">
          {/* Section 1 & Section 2 Results Table */}
          <FileResultsTable
            files={effectiveFileResults}
            api={api}
            userQuery={userQuery}
          />

          {/* Summary / Explanation shown below file results */}
          {cleanSummaryText && (
            <div className="file-search-summary-block">
              <div className="file-summary-title">Summary & Explanation</div>
              {parsedSummary.proseBefore && (
                <div className="summary-lead-prose">
                  <MarkdownContent text={parsedSummary.proseBefore} />
                </div>
              )}
              {parsedSummary.excerpts.length > 0 && (
                <div className="summary-excerpts-section">
                  {parsedSummary.excerptsHeading && (
                    <div className="summary-excerpts-heading">{parsedSummary.excerptsHeading}</div>
                  )}
                  <div className="summary-excerpts-list">
                    {parsedSummary.excerpts.map((item, idx) => {
                      const canPreview = effectiveFileResults.some(
                        (f) => f.name.toLowerCase() === item.filename.toLowerCase(),
                      );
                      return (
                        <div key={`${item.filename}-${idx}`} className="summary-excerpt-card">
                          <div className="excerpt-card-header">
                            <span className="excerpt-ext-badge">{item.extBadge}</span>
                            {canPreview ? (
                              <button
                                type="button"
                                className="excerpt-filename excerpt-filename-btn"
                                onClick={() => openMatchedPreview(item.filename)}
                                title={`Preview ${item.filename}`}
                              >
                                {item.filename}
                              </button>
                            ) : (
                              <span className="excerpt-filename">{item.filename}</span>
                            )}
                            {item.locationLabel && (
                              <span className="excerpt-loc-badge">{item.locationLabel}</span>
                            )}
                          </div>
                          <p className="excerpt-body">{item.text}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {parsedSummary.proseAfter && (
                <div className="summary-after-prose">
                  <MarkdownContent text={parsedSummary.proseAfter} />
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        /* Render Markdown & Interactive Tables */
        <>
          {message.sources && message.sources.length > 0 && message.text?.includes("|") && (
            <div className="msg-top-sources-bar">
              <span className="top-sources-label">
                <FileText size={13} />
                <span>Source Files:</span>
              </span>
              {message.sources.map((s, idx) => (
                <button
                  key={s.id || idx}
                  type="button"
                  className="top-source-chip"
                  onClick={() => onOpenSource(s)}
                  title={`Preview source document: ${s.title}`}
                >
                  <Eye size={12} />
                  <span>{s.title}</span>
                </button>
              ))}
            </div>
          )}
          <MarkdownContent text={message.text} />
        </>
      )}

      {/* Render Interactive Source Cards only when no fileResults table is displayed */}
      {message.sources && message.sources.length > 0 && !effectiveFileResults?.length && (
        <SourceList sources={message.sources} onOpen={onOpenSource} api={api} />
      )}

      {/* Render Backend Trace Disclosure */}
      {message.trace && message.trace.length > 0 && <TraceDisclosure steps={message.trace} />}

      {/* Contextual Follow-up Suggestions: domain-aware, clickable questions */}
      {followupSuggestions.length > 0 && onFollowup && (
        <div className="msg-followup-container" role="group" aria-label="Suggested follow-up questions">
          <div className="msg-followup-header">
            <Sparkles size={13} className="followup-sparkle-icon" aria-hidden="true" />
            <span className="followup-title">Suggested follow-ups</span>
          </div>
          <div className="msg-followup-pills">
            {followupSuggestions.map((suggestion, idx) => (
              <button
                key={idx}
                type="button"
                className="msg-followup-pill"
                onClick={() => onFollowup(suggestion)}
                title={`Ask: "${suggestion}"`}
              >
                <span>{suggestion}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Interactive Actions Bar - ChatGPT style */}
      <div className="msg-actions">
        <Button
          variant="ghost"
          size="sm"
          icon={copied ? Check : Copy}
          onClick={() => void copy()}
        >
          {copied ? "Copied" : "Copy answer"}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          icon={RefreshCw}
          onClick={() => onRetry(message.id)}
          title="Regenerate this response"
        >
          Regenerate
        </Button>

        {message.reportId && (
          <Button
            variant="secondary"
            size="sm"
            icon={Download}
            onClick={() => onDownload(message.reportId!)}
          >
            Download report
          </Button>
        )}
      </div>
    </article>
  );
}

export const MessageItem = memo(MessageItemBase);

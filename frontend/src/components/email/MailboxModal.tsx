import React, { useState, useEffect } from "react";
import {
  Mail,
  CheckCircle2,
  RefreshCw,
  Unplug,
  ExternalLink,
  Sparkles,
  ShieldCheck,
  Folder,
  Send,
  ArrowLeft,
  Paperclip,
  Download,
  CornerUpLeft,
  Plus,
  Inbox,
  AlertTriangle,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { GoogleIcon } from "../../login/components/GoogleIcon";
import { BrandLogo } from "../brand/BrandLogo";
import type {
  NanviApiClient,
  EmailStatusResponse,
  EmailAccount,
  EmailFolder,
  EmailMessageSummary,
  EmailMessageDetail,
} from "../../api";
import { useToast } from "../ui/Toast";

type Props = {
  api: NanviApiClient;
  open: boolean;
  onClose: () => void;
  onAskPrompt?: (prompt: string) => void;
};

type ViewMode = "accounts" | "browse" | "detail" | "compose";

export function MailboxModal({ api, open, onClose, onAskPrompt }: Props) {
  const notify = useToast();
  const [view, setView] = useState<ViewMode>("accounts");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<EmailStatusResponse | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  // Selected account for browsing / sending
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(undefined);

  // Yahoo Connect Form State
  const [showYahooForm, setShowYahooForm] = useState(false);
  const [yahooEmail, setYahooEmail] = useState("");
  const [yahooPassword, setYahooPassword] = useState("");

  // Outlook Direct Connect Form State
  const [showOutlookForm, setShowOutlookForm] = useState(false);
  const [outlookEmail, setOutlookEmail] = useState("");
  const [outlookPassword, setOutlookPassword] = useState("");

  // Manual Corporate / IMAP Form State
  const [showManual, setShowManual] = useState(false);
  const [manualEmail, setManualEmail] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualProvider, setManualProvider] = useState("google");

  // Browsing State
  const [folders, setFolders] = useState<EmailFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState("inbox");
  const [messages, setMessages] = useState<EmailMessageSummary[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Message Detail State
  const [activeMessage, setActiveMessage] = useState<EmailMessageDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Compose / Reply State
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [replyMessageId, setReplyMessageId] = useState<string | null>(null);
  const [replyAll, setReplyAll] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [sending, setSending] = useState(false);

  const loadStatus = async () => {
    try {
      setLoading(true);
      const res = await api.emailStatus();
      setStatus(res);
      if (res.account?.id && !selectedAccountId) {
        setSelectedAccountId(res.account.id);
      }
    } catch (err) {
      console.warn("Could not load email status:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      loadStatus();
    }
  }, [open]);

  // Load folders & messages when switching to browse view
  useEffect(() => {
    if (open && view === "browse") {
      loadFoldersAndMessages();
    }
  }, [view, selectedAccountId, selectedFolderId]);

  const loadFoldersAndMessages = async () => {
    try {
      setLoadingMessages(true);
      const [folderList, msgList] = await Promise.all([
        api.getEmailFolders(selectedAccountId).catch(() => [{ id: "inbox", name: "Inbox", total_count: 0, unread_count: 0 }]),
        api.getEmailMessages({
          folder_id: selectedFolderId,
          account_id: selectedAccountId,
          query: searchQuery || undefined,
        }),
      ]);
      setFolders(folderList);
      setMessages(msgList.messages || []);
    } catch (err) {
      console.warn("Failed to load messages:", err);
      notify("Failed to retrieve emails.", "error");
    } finally {
      setLoadingMessages(false);
    }
  };

  const handleOpenMessage = async (msgId: string) => {
    try {
      setLoadingDetail(true);
      setView("detail");
      const detail = await api.getEmailMessage(msgId, selectedAccountId);
      setActiveMessage(detail);
    } catch (err) {
      notify("Could not load full message details.", "error");
      setView("browse");
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleStartReply = (msg: EmailMessageDetail) => {
    setReplyMessageId(msg.id);
    const replySub = msg.subject.toLowerCase().startsWith("re:") ? msg.subject : `Re: ${msg.subject}`;
    setComposeSubject(replySub);
    setComposeTo(msg.sender?.address || "");
    setComposeBody(`\n\n--- On ${msg.received_at || "recent"}, ${msg.sender?.name || msg.sender?.address} wrote:\n${msg.body_text || msg.body_preview || ""}`);
    setConfirmSend(false);
    setView("compose");
  };

  const handleStartCompose = () => {
    setReplyMessageId(null);
    setComposeTo("");
    setComposeSubject("");
    setComposeBody("");
    setConfirmSend(false);
    setView("compose");
  };

  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmSend) {
      notify("Please check the confirmation box before sending.", "error");
      return;
    }
    if (!composeTo.trim()) {
      notify("Recipient address is required.", "error");
      return;
    }
    if (!composeSubject.trim()) {
      notify("Subject is required.", "error");
      return;
    }

    try {
      setSending(true);
      if (replyMessageId) {
        await api.replyEmail({
          message_id: replyMessageId,
          body_text: composeBody,
          reply_all: replyAll,
          account_id: selectedAccountId,
          confirmed: true,
        });
        notify("Reply sent successfully!", "success");
      } else {
        await api.sendEmail({
          to: composeTo.split(",").map((s) => s.trim()).filter(Boolean),
          subject: composeSubject,
          body_text: composeBody,
          account_id: selectedAccountId,
          confirmed: true,
        });
        notify("Email sent successfully!", "success");
      }
      setView("browse");
      loadFoldersAndMessages();
    } catch (err: any) {
      notify(err.message || "Failed to send email.", "error");
    } finally {
      setSending(false);
    }
  };

  const handleDownloadAttachment = async (attachmentId: string, filename: string) => {
    if (!activeMessage) return;
    try {
      notify(`Downloading ${filename}...`, "info");
      const res = await api.downloadAttachment(activeMessage.id, attachmentId, selectedAccountId);
      const byteCharacters = atob(res.data_base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: res.content_type || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.name || filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify(`Downloaded ${res.name || filename}`, "success");
    } catch (err) {
      notify("Failed to download attachment.", "error");
    }
  };

  const handleConnectGoogle = async () => {
    try {
      setConnecting(true);
      const isDesktop = Boolean((window as any).electronAPI?.isDesktop || window.location.protocol === "file:");
      const origin = !isDesktop && window.location.origin && window.location.origin !== "null" && !window.location.origin.startsWith("file:")
        ? window.location.origin
        : undefined;
      const { auth_url } = await api.googleAuthUrl(origin);
      if (isDesktop && (window as any).electronAPI?.openExternal) {
        await (window as any).electronAPI.openExternal(auth_url);
        notify("Opening Google Sign-In in your browser. Please approve access to continue.", "info");
        setConnecting(false);
      } else {
        window.location.href = auth_url;
      }
    } catch {
      notify("Failed to initiate Google authorization. Please check server settings.", "error");
      setConnecting(false);
    }
  };

  const handleConnectMicrosoft = async () => {
    if (!status?.is_microsoft_oauth_configured) {
      setShowOutlookForm(true);
      notify("Microsoft OAuth is not configured in server .env. Enter your Outlook credentials directly below.", "info");
      return;
    }
    try {
      setConnecting(true);
      const isDesktop = Boolean((window as any).electronAPI?.isDesktop || window.location.protocol === "file:");
      const origin = !isDesktop && window.location.origin && window.location.origin !== "null" && !window.location.origin.startsWith("file:")
        ? `${window.location.origin}/auth/microsoft/callback`
        : "http://localhost:5173/auth/microsoft/callback";
      const { auth_url } = await api.microsoftAuthUrl(origin);
      if (isDesktop && (window as any).electronAPI?.openExternal) {
        await (window as any).electronAPI.openExternal(auth_url);
        notify("Opening Microsoft Sign-In in your browser. Please approve access to continue.", "info");
        setConnecting(false);
      } else {
        window.location.href = auth_url;
      }
    } catch {
      setShowOutlookForm(true);
      notify("OAuth unavailable. You can connect directly using your Outlook credentials.", "info");
      setConnecting(false);
    }
  };

  const handleConnectOutlook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!outlookEmail.trim() || !outlookPassword.trim()) {
      notify("Outlook email and password / App Password are required.", "error");
      return;
    }
    try {
      setConnecting(true);
      const res = await api.connectOutlookMailbox(outlookEmail.trim(), outlookPassword.trim());
      notify(`Connected Outlook mailbox: ${res.account.email_address}`, "success");
      setShowOutlookForm(false);
      setOutlookEmail("");
      setOutlookPassword("");
      await loadStatus();
    } catch (err: any) {
      notify(err.message || "Failed to connect Outlook mailbox. Verify your credentials.", "error");
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectYahoo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!yahooEmail.trim() || !yahooPassword.trim()) {
      notify("Yahoo email and App-Specific Password are required.", "error");
      return;
    }
    try {
      setConnecting(true);
      const res = await api.connectYahooMailbox(yahooEmail.trim(), yahooPassword.trim());
      notify(`Connected Yahoo mailbox: ${res.account.email_address}`, "success");
      setShowYahooForm(false);
      setYahooEmail("");
      setYahooPassword("");
      await loadStatus();
    } catch (err: any) {
      notify(err.message || "Failed to connect Yahoo Mail. Please verify your App Password.", "error");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async (accountId?: string) => {
    if (!window.confirm("Are you sure you want to disconnect this mailbox?")) {
      return;
    }
    try {
      setDisconnectingId(accountId || "default");
      await api.disconnectEmail(accountId);
      notify("Mailbox disconnected successfully.", "success");
      await loadStatus();
    } catch {
      notify("Failed to disconnect mailbox.", "error");
    } finally {
      setDisconnectingId(null);
    }
  };

  const handleManualConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualEmail.trim()) {
      notify("Please enter a valid email address.", "error");
      return;
    }
    try {
      setConnecting(true);
      const res = await api.manualConnectEmail(manualEmail.trim(), manualName.trim() || undefined);
      notify(`Connected mailbox: ${res.account.email_address}`, "success");
      setShowManual(false);
      await loadStatus();
    } catch {
      notify("Failed to link mailbox.", "error");
    } finally {
      setConnecting(false);
    }
  };

  const handleQuickAsk = (prompt: string) => {
    onClose();
    onAskPrompt?.(prompt);
  };

  if (!open) return null;

  const connectedAccounts: EmailAccount[] = status?.accounts?.length
    ? status.accounts
    : status?.account
      ? [status.account]
      : [];

  const isConnected = connectedAccounts.length > 0;

  const getProviderIcon = (provider: string) => {
    const p = provider.toLowerCase();
    if (p.includes("google") || p.includes("gmail")) {
      return <GoogleIcon className="w-5 h-5" />;
    }
    if (p.includes("microsoft") || p.includes("outlook")) {
      return <BrandLogo name="microsoft" size={20} />;
    }
    if (p.includes("yahoo")) {
      return <BrandLogo name="yahoo" size={20} />;
    }
    return <Mail size={18} />;
  };

  return (
    <Modal
      title={
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", paddingRight: "2rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Mail size={20} style={{ color: "var(--primary-600)" }} />
            <span>Universal Enterprise Mailbox</span>
          </div>
          {isConnected && (
            <div style={{ display: "flex", gap: "0.25rem", background: "var(--bg-sunken)", padding: "2px", borderRadius: "var(--radius-md)" }}>
              <button
                type="button"
                onClick={() => setView("accounts")}
                style={{
                  padding: "4px 10px",
                  fontSize: "var(--text-xs)",
                  fontWeight: view === "accounts" ? "bold" : "normal",
                  background: view === "accounts" ? "var(--bg-surface)" : "transparent",
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
              >
                Accounts ({connectedAccounts.length})
              </button>
              <button
                type="button"
                onClick={() => setView("browse")}
                style={{
                  padding: "4px 10px",
                  fontSize: "var(--text-xs)",
                  fontWeight: view === "browse" ? "bold" : "normal",
                  background: view === "browse" ? "var(--bg-surface)" : "transparent",
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
              >
                Browse & Search
              </button>
              <button
                type="button"
                onClick={handleStartCompose}
                style={{
                  padding: "4px 10px",
                  fontSize: "var(--text-xs)",
                  fontWeight: view === "compose" ? "bold" : "normal",
                  background: view === "compose" ? "var(--bg-surface)" : "transparent",
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                }}
              >
                Compose
              </button>
            </div>
          )}
        </div>
      }
      onClose={onClose}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
            Zero-Trust Isolation • Read & Confirmed Send • TLS 1.3
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", minHeight: "360px" }}>
        {loading ? (
          <div style={{ padding: "var(--space-8) 0", textAlign: "center", color: "var(--text-secondary)" }}>
            <RefreshCw size={24} className="animate-spin" style={{ color: "var(--primary-600)", margin: "0 auto var(--space-2)" }} />
            <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>Connecting to multi-provider email service…</p>
          </div>
        ) : view === "browse" ? (
          /* BROWSE MAILBOX VIEW */
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
              {connectedAccounts.length > 1 && (
                <select
                  value={selectedAccountId || ""}
                  onChange={(e) => setSelectedAccountId(e.target.value)}
                  className="input"
                  style={{ width: "auto", fontSize: "var(--text-xs)" }}
                >
                  {connectedAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.email_address} ({a.provider})
                    </option>
                  ))}
                </select>
              )}

              <select
                value={selectedFolderId}
                onChange={(e) => setSelectedFolderId(e.target.value)}
                className="input"
                style={{ width: "auto", fontSize: "var(--text-xs)" }}
              >
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} {f.unread_count > 0 ? `(${f.unread_count})` : ""}
                  </option>
                ))}
              </select>

              <input
                type="text"
                placeholder="Search subject or content..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && loadFoldersAndMessages()}
                className="input"
                style={{ flex: 1, minWidth: "160px", fontSize: "var(--text-xs)" }}
              />

              <Button size="sm" variant="secondary" onClick={loadFoldersAndMessages} loading={loadingMessages}>
                Search
              </Button>
            </div>

            {loadingMessages ? (
              <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>
                <RefreshCw size={20} className="animate-spin" style={{ margin: "0 auto 8px" }} />
                <span>Loading messages...</span>
              </div>
            ) : messages.length === 0 ? (
              <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--text-muted)" }}>
                <Inbox size={32} style={{ margin: "0 auto 8px", opacity: 0.5 }} />
                <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>No messages found in this folder.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", maxHeight: "360px", overflowY: "auto" }}>
                {messages.map((m) => (
                  <div
                    key={m.id}
                    onClick={() => handleOpenMessage(m.id)}
                    style={{
                      padding: "var(--space-3)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-md)",
                      backgroundColor: "var(--bg-surface)",
                      cursor: "pointer",
                      transition: "background-color 0.15s",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-sunken)")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-surface)")}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                      <div style={{ fontWeight: 600, fontSize: "var(--text-sm)", color: "var(--text)" }}>
                        {m.subject || "(No Subject)"}
                      </div>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {m.received_at ? new Date(m.received_at).toLocaleDateString() : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                        From: {m.sender?.name || m.sender?.address || "Unknown"}
                      </span>
                      {m.has_attachments && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "2px", fontSize: "11px", color: "var(--primary-600)" }}>
                          <Paperclip size={12} />
                          {m.attachments?.length || 1} file(s)
                        </span>
                      )}
                    </div>
                    {m.body_preview && (
                      <p style={{ margin: "4px 0 0", fontSize: "var(--text-xs)", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.body_preview}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : view === "detail" ? (
          /* MESSAGE DETAIL VIEW */
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => setView("browse")}>
                Back to Messages
              </Button>
              {activeMessage && (
                <Button size="sm" variant="primary" icon={CornerUpLeft} onClick={() => handleStartReply(activeMessage)}>
                  Reply
                </Button>
              )}
            </div>

            {loadingDetail || !activeMessage ? (
              <div style={{ padding: "3rem", textAlign: "center" }}>
                <RefreshCw size={24} className="animate-spin" style={{ margin: "0 auto 8px" }} />
                <span>Loading email details...</span>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", maxHeight: "360px", overflowY: "auto" }}>
                <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: "var(--space-3)" }}>
                  <h3 style={{ margin: "0 0 8px", fontSize: "var(--text-lg)", color: "var(--text)" }}>
                    {activeMessage.subject}
                  </h3>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: "2px" }}>
                    <div><strong>From:</strong> {activeMessage.sender?.name ? `${activeMessage.sender.name} <${activeMessage.sender.address}>` : activeMessage.sender?.address}</div>
                    <div><strong>To:</strong> {activeMessage.to_recipients.map((r) => r.address).join(", ")}</div>
                    <div><strong>Date:</strong> {activeMessage.received_at ? new Date(activeMessage.received_at).toLocaleString() : "Unknown"}</div>
                  </div>
                </div>

                {/* Attachments Section */}
                {activeMessage.attachments?.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {activeMessage.attachments.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => handleDownloadAttachment(a.id, a.name)}
                        className="btn btn-secondary"
                        style={{ fontSize: "11px", padding: "4px 8px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      >
                        <Download size={12} />
                        <span>{a.name}</span>
                        {a.size_bytes && <span style={{ color: "var(--text-muted)" }}>({Math.round(a.size_bytes / 1024)} KB)</span>}
                      </button>
                    ))}
                  </div>
                )}

                {/* Email Body */}
                <div
                  style={{
                    padding: "var(--space-3)",
                    backgroundColor: "var(--bg-sunken)",
                    borderRadius: "var(--radius-md)",
                    fontSize: "var(--text-sm)",
                    color: "var(--text)",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {activeMessage.body_text || activeMessage.body_preview || "(Empty body)"}
                </div>
              </div>
            )}
          </div>
        ) : view === "compose" ? (
          /* COMPOSE / CONFIRMED SEND VIEW */
          <form onSubmit={handleSendEmail} style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => setView("browse")}>
                Back to Messages
              </Button>
              <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>
                {replyMessageId ? "Reply to Message" : "New Email"}
              </span>
            </div>

            <div>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 600, marginBottom: "2px" }}>To</label>
              <input
                type="text"
                placeholder="recipient@example.com"
                value={composeTo}
                onChange={(e) => setComposeTo(e.target.value)}
                className="input"
                style={{ fontSize: "var(--text-xs)" }}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 600, marginBottom: "2px" }}>Subject</label>
              <input
                type="text"
                placeholder="Subject"
                value={composeSubject}
                onChange={(e) => setComposeSubject(e.target.value)}
                className="input"
                style={{ fontSize: "var(--text-xs)" }}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 600, marginBottom: "2px" }}>Message Body</label>
              <textarea
                rows={6}
                value={composeBody}
                onChange={(e) => setComposeBody(e.target.value)}
                className="input"
                style={{ fontSize: "var(--text-xs)", fontFamily: "inherit" }}
              />
            </div>

            {/* Zero-Trust Explicit Confirmation Banner */}
            <div
              style={{
                padding: "var(--space-3)",
                backgroundColor: "#fffbeb",
                border: "1px solid #fef3c7",
                borderRadius: "var(--radius-md)",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#92400e", fontWeight: 600, fontSize: "var(--text-xs)" }}>
                <AlertTriangle size={14} /> Explicit User Confirmation Required
              </div>
              <p style={{ margin: 0, fontSize: "11px", color: "#78350f" }}>
                AI and background automation cannot silently dispatch emails without your explicit authorization.
              </p>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px", color: "#92400e", fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={confirmSend}
                  onChange={(e) => setConfirmSend(e.target.checked)}
                />
                <span>I confirm that I want to dispatch this outbound email now.</span>
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <Button type="button" variant="ghost" size="sm" onClick={() => setView("browse")}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" icon={Send} disabled={!confirmSend} loading={sending}>
                Send Email
              </Button>
            </div>
          </form>
        ) : (
          /* ACCOUNTS OVERVIEW & CONNECTOR VIEW */
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            {/* Connected Accounts List */}
            {connectedAccounts.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-semibold)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)" }}>
                    Connected Mailboxes ({connectedAccounts.length})
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setView("browse")}>
                    Open Inbox →
                  </Button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                  {connectedAccounts.map((acc) => (
                    <div
                      key={acc.id}
                      style={{
                        padding: "var(--space-3)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-lg)",
                        backgroundColor: "var(--bg-sunken)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "var(--space-3)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: "var(--radius-full)",
                            backgroundColor: "var(--bg-surface)",
                            border: "1px solid var(--border)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {getProviderIcon(acc.provider)}
                        </div>
                        <div>
                          <div style={{ fontWeight: "var(--weight-semibold)", color: "var(--text)", fontSize: "var(--text-sm)" }}>
                            {acc.display_name || acc.email_address}
                          </div>
                          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                            {acc.email_address} • <Badge tone="success">{acc.provider.toUpperCase()}</Badge>
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Unplug}
                          loading={disconnectingId === acc.id}
                          onClick={() => handleDisconnect(acc.id)}
                          className="btn-danger"
                        >
                          Disconnect
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Connect More Mailboxes Section */}
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", borderTop: connectedAccounts.length > 0 ? "1px solid var(--border)" : "none", paddingTop: connectedAccounts.length > 0 ? "var(--space-3)" : 0 }}>
              <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-semibold)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)" }}>
                Connect a New Mailbox
              </span>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2)" }}>
                {/* Google Workspace Button */}
                <button
                  type="button"
                  onClick={handleConnectGoogle}
                  disabled={connecting}
                  className="btn btn-secondary"
                  style={{
                    padding: "12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <GoogleIcon className="w-5 h-5" />
                  <span>Google Workspace</span>
                </button>

                {/* Microsoft 365 Button */}
                <button
                  type="button"
                  onClick={handleConnectMicrosoft}
                  disabled={connecting}
                  className="btn btn-secondary"
                  style={{
                    padding: "12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <BrandLogo name="microsoft" size={18} />
                  <span>Microsoft 365 / Outlook</span>
                </button>
              </div>

              {/* Yahoo Mail Connect Card */}
              <div
                style={{
                  padding: "var(--space-3)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--bg-surface)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <BrandLogo name="yahoo" size={18} />
                    <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>Yahoo Mail</span>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setShowYahooForm((p) => !p)}
                  >
                    {showYahooForm ? "Cancel" : "Connect with App Password"}
                  </Button>
                </div>

                {showYahooForm && (
                  <form onSubmit={handleConnectYahoo} style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div style={{ fontSize: "11px", color: "var(--text-secondary)", background: "var(--bg-sunken)", padding: "8px", borderRadius: "4px" }}>
                      Generate a 16-character App Password from <strong>Yahoo Security → App passwords</strong>. Spaces are automatically removed.
                    </div>
                    <input
                      type="email"
                      placeholder="your.name@yahoo.com"
                      value={yahooEmail}
                      onChange={(e) => setYahooEmail(e.target.value)}
                      className="input"
                      style={{ fontSize: "var(--text-xs)" }}
                    />
                    <input
                      type="password"
                      placeholder="16-character App Password (e.g. abcd efgh ijkl mnop)"
                      value={yahooPassword}
                      onChange={(e) => setYahooPassword(e.target.value)}
                      className="input"
                      style={{ fontSize: "var(--text-xs)" }}
                    />
                    <Button type="submit" variant="primary" size="sm" loading={connecting} block>
                      Authenticate & Save Yahoo Mailbox
                    </Button>
                  </form>
                )}
              </div>

              {/* Outlook / Office 365 Direct Connect Card */}
              {showOutlookForm && (
                <div
                  style={{
                    padding: "var(--space-3)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-md)",
                    backgroundColor: "var(--bg-surface)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <BrandLogo name="microsoft" size={18} />
                      <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>Outlook / Office 365 Direct Login</span>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => setShowOutlookForm(false)}>
                      Cancel
                    </Button>
                  </div>

                  <form onSubmit={handleConnectOutlook} style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div style={{ fontSize: "11px", color: "var(--text-secondary)", background: "var(--bg-sunken)", padding: "8px", borderRadius: "4px" }}>
                      Enter your Outlook, Hotmail, or Microsoft 365 address and password (or App Password if 2-Step Verification is active).
                    </div>
                    <input
                      type="email"
                      placeholder="your.name@outlook.com or corporate@company.com"
                      value={outlookEmail}
                      onChange={(e) => setOutlookEmail(e.target.value)}
                      className="input"
                      style={{ fontSize: "var(--text-xs)" }}
                    />
                    <input
                      type="password"
                      placeholder="Password or App Password"
                      value={outlookPassword}
                      onChange={(e) => setOutlookPassword(e.target.value)}
                      className="input"
                      style={{ fontSize: "var(--text-xs)" }}
                    />
                    <Button type="submit" variant="primary" size="sm" loading={connecting} block>
                      Authenticate & Save Outlook Mailbox
                    </Button>
                  </form>
                </div>
              )}

              {/* 1-Click Server Credential Fallbacks */}
              {(status?.has_enterprise_fallback || status?.has_microsoft_fallback || status?.has_yahoo_fallback) && (
                <div
                  style={{
                    padding: "var(--space-3)",
                    backgroundColor: "var(--primary-50)",
                    border: "1px solid var(--primary-100)",
                    borderRadius: "var(--radius-lg)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                  }}
                >
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                    Verified server credentials exist in .env. Link them instantly:
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {status?.has_enterprise_fallback && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            setConnecting(true);
                            const res = await api.connectSavedEmail();
                            notify(`Google mailbox connected: ${res.account.email_address}`, "success");
                            await loadStatus();
                          } catch {
                            notify("Failed to connect saved Google mailbox.", "error");
                          } finally {
                            setConnecting(false);
                          }
                        }}
                        disabled={connecting}
                        className="btn btn-primary btn-block"
                        style={{
                          minHeight: "36px",
                          fontSize: "var(--text-xs)",
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "6px",
                          cursor: "pointer",
                        }}
                      >
                        <CheckCircle2 size={16} />
                        <span>1-Click Connect Saved Google Account</span>
                      </button>
                    )}

                    {status?.has_microsoft_fallback && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            setConnecting(true);
                            const res = await api.connectSavedMicrosoftEmail();
                            notify(`Microsoft/Outlook mailbox connected: ${res.account.email_address}`, "success");
                            await loadStatus();
                          } catch {
                            notify("Failed to connect saved Microsoft mailbox.", "error");
                          } finally {
                            setConnecting(false);
                          }
                        }}
                        disabled={connecting}
                        className="btn btn-primary btn-block"
                        style={{
                          minHeight: "36px",
                          fontSize: "var(--text-xs)",
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "6px",
                          cursor: "pointer",
                        }}
                      >
                        <CheckCircle2 size={16} />
                        <span>1-Click Connect Saved Microsoft / Outlook Account</span>
                      </button>
                    )}

                    {status?.has_yahoo_fallback && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            setConnecting(true);
                            const res = await api.connectSavedYahooEmail();
                            notify(`Yahoo mailbox connected: ${res.account.email_address}`, "success");
                            await loadStatus();
                          } catch {
                            notify("Failed to connect saved Yahoo mailbox.", "error");
                          } finally {
                            setConnecting(false);
                          }
                        }}
                        disabled={connecting}
                        className="btn btn-primary btn-block"
                        style={{
                          minHeight: "36px",
                          fontSize: "var(--text-xs)",
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "6px",
                          cursor: "pointer",
                        }}
                      >
                        <CheckCircle2 size={16} />
                        <span>1-Click Connect Saved Yahoo Account</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Manual IMAP fallback */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowManual((p) => !p)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "var(--primary-600)",
                    fontSize: "var(--text-xs)",
                    textDecoration: "underline",
                    cursor: "pointer",
                  }}
                >
                  {showManual ? "Hide manual configuration" : "Or link corporate email directly →"}
                </button>

                {showManual && (
                  <form onSubmit={handleManualConnect} style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <input
                      type="email"
                      placeholder="corporate.user@company.com"
                      value={manualEmail}
                      onChange={(e) => setManualEmail(e.target.value)}
                      className="input"
                      style={{ fontSize: "var(--text-xs)" }}
                    />
                    <input
                      type="text"
                      placeholder="Display Name (Optional)"
                      value={manualName}
                      onChange={(e) => setManualName(e.target.value)}
                      className="input"
                      style={{ fontSize: "var(--text-xs)" }}
                    />
                    <Button type="submit" variant="primary" size="sm" loading={connecting} block>
                      Save Mailbox
                    </Button>
                  </form>
                )}
              </div>
            </div>

            {/* Quick Ask Questions */}
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", paddingTop: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-semibold)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)" }}>
                Ask Nanvi about your emails
              </span>
              <div style={{ display: "grid", gap: "var(--space-2)" }}>
                {[
                  "Check my latest unread emails",
                  "What emails did I receive today?",
                  "Find emails about Q1 financial results",
                ].map((q, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleQuickAsk(q)}
                    className="btn btn-secondary"
                    style={{
                      justifyContent: "space-between",
                      fontSize: "var(--text-xs)",
                      padding: "var(--space-2) var(--space-3)",
                      textAlign: "left",
                      height: "auto",
                      minHeight: "36px",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                      <Sparkles size={14} style={{ color: "var(--primary-600)" }} />
                      {q}
                    </span>
                    <span style={{ color: "var(--primary-600)", fontWeight: "var(--weight-medium)" }}>Ask →</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

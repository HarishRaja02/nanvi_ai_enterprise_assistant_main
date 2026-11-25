import { useEffect, useRef } from "react";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import { EmptyStateBento } from "./EmptyStateBento";
import { AiActivityIndicator } from "./AiActivityIndicator";
import type { PromptDef } from "../../lib/prompts";
import type { SourceView } from "../../lib/sources";
import type { Message, ResumedConversation } from "../../types";
import type { NanviApiClient, UserIdentity } from "../../api";

type Props = {
  messages: Message[];
  busy: boolean;
  resumed: ResumedConversation | null;
  loadingHistory?: boolean;
  starters: PromptDef[];
  focusToken: number;
  ragEnabled?: boolean;
  onToggleRag?: (enabled: boolean) => void;
  api?: NanviApiClient;
  identity?: UserIdentity | null;
  onSend: (text: string, rag?: boolean, activeDocumentId?: string) => Promise<boolean>;
  onRetry: (messageId: string) => void;
  onOpenSource: (source: SourceView) => void;
  onDownload: (reportId: string) => void;
  onNewConversation: () => void;
  onOpenVoiceMode?: () => void;
  onSelectSource?: (query: string, source: string) => void;
};

export function ChatView({
  messages,
  busy,
  resumed,
  loadingHistory = false,
  starters,
  focusToken,
  ragEnabled = true,
  onToggleRag,
  api,
  identity,
  onSend,
  onRetry,
  onOpenSource,
  onDownload,
  onNewConversation,
  onOpenVoiceMode,
  onSelectSource,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const empty = messages.length === 0 && !busy && !loadingHistory;

  useEffect(() => {
    if (messages.length === 0 && !busy) return; // keep empty state anchored at the top
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    endRef.current?.scrollIntoView?.({ block: "end", behavior: reduce ? "auto" : "smooth" });
  }, [messages.length, busy]);

  const composerNode = (
    <Composer
      busy={busy}
      onSend={onSend}
      focusToken={focusToken}
      ragEnabled={ragEnabled}
      onToggleRag={onToggleRag}
      api={api}
      onOpenVoiceMode={onOpenVoiceMode}
    />
  );

  return (
    <div className={`chat${empty ? " is-empty" : ""}`}>
      <div className={`chat-scroll${empty ? " chat-empty-scroll" : ""}`}>
        <div className={`thread${empty ? " chat-empty-thread" : ""}`}>
          {loadingHistory && (
            <div
              className="history-loading"
              role="status"
              style={{
                padding: "var(--space-6) 0",
                color: "var(--text-secondary)",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
              }}
            >
              <span className="dots" aria-hidden="true">
                <i /><i /><i />
              </span>
              <span>Loading conversation history…</span>
            </div>
          )}

          {resumed && !loadingHistory && messages.length === 0 && (
            <Alert
              tone="info"
              title={`Continuing “${resumed.title}”`}
              actions={
                <Button size="sm" variant="secondary" onClick={onNewConversation}>
                  Start a new conversation
                </Button>
              }
            >
              Earlier messages in this conversation aren't available. Your next message is added to it.
            </Alert>
          )}

          {resumed && !loadingHistory && messages.length > 0 && (
            <Alert
              tone="info"
              title={`Continuing “${resumed.title}”`}
              actions={
                <Button size="sm" variant="secondary" onClick={onNewConversation}>
                  Start new conversation
                </Button>
              }
            >
              Showing earlier messages from this conversation. Your next message continues here.
            </Alert>
          )}

          {/* Centered empty state with greeting, pill search bar, and starter actions */}
          {empty && (
            <EmptyStateBento
              starters={starters}
              onPick={(p) => void onSend(p)}
              disabled={busy}
              composer={composerNode}
            />
          )}

          {/* Messages list */}
          {!empty && (
            <div className="messages" role="log" aria-live="polite" aria-label="Conversation messages">
              {messages.map((m, idx) => {
                let userQuery = m.userQuery;
                if (!userQuery && m.role === "assistant") {
                  for (let i = idx - 1; i >= 0; i--) {
                    if (messages[i].role === "user") {
                      userQuery = messages[i].text;
                      break;
                    }
                  }
                }
                return (
                  <MessageItem
                    key={m.id}
                    message={m}
                    userQuery={userQuery}
                    api={api}
                    identity={identity}
                    onOpenSource={onOpenSource}
                    onDownload={onDownload}
                    onRetry={onRetry}
                    onFollowup={(p) => void onSend(p)}
                    onSelectSource={onSelectSource}
                  />
                );
              })}

              {/* Progressive Multi-Stage AI Activity Stepper */}
              {busy && (
                <div className="msg msg-assistant" role="status">
                  <AiActivityIndicator ragEnabled={ragEnabled} />
                </div>
              )}
            </div>
          )}

          {!empty && <div ref={endRef} />}
        </div>
      </div>

      {/* Floating pill searchbar dock during active conversations */}
      {!empty && (
        <div className="floating-composer-dock">
          <div className="floating-composer-inner">
            {composerNode}
          </div>
        </div>
      )}
    </div>
  );
}

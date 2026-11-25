import { useCallback, useEffect, useState } from "react";
import type { NanviApiClient, UserIdentity } from "../api";
import type { ConversationSummary } from "../types";

export function useHistory(api: NanviApiClient, identity: UserIdentity | null) {
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!identity) return;
    setLoading(true);
    setError("");
    try {
      const response = await api.history();
      setHistory(response.conversations ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversation history is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [api, identity]);

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      try {
        await api.deleteConversation(conversationId);
        setHistory((prev) => prev.filter((c) => c.conversation_id !== conversationId));
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to delete conversation.");
        return false;
      }
    },
    [api]
  );

  useEffect(() => {
    if (identity) void reload();
    else { setHistory([]); setError(""); }
  }, [identity, reload]);

  return { history, loading, error, reload };
  return { history, loading, error, reload, deleteConversation };
}

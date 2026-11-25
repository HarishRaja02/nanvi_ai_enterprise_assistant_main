/**
 * Determines whether a user query is asking for email retrieval/inbox check
 * rather than searching for local documents/files that contain the word "email".
 */
export function isEmailQuery(query: string): boolean {
  if (!query || typeof query !== "string") return false;
  const q = query.trim().toLowerCase();

  // If query explicitly asks for documents, files, folders, or specific file types, treat as document query
  const isExplicitFileQuery = /\b(files?|documents?|folder|folders|directory|docx?|pdf|pptx?|xlsx?|csv|txt|json|html|source|code|script)\b/i.test(q);
  if (isExplicitFileQuery) {
    return false;
  }

  // Common direct action phrases targeting email / inbox / mail / outlook / yahoo
  if (/\b(check|show|get|fetch|list|read|view|find|display|pull|summarize|update\s+me\s+on)\b.*\b(emails?|gmail|inbox|messages?|mails?|mailes?|mailbox|outlook|yahoo|microsoft)\b/i.test(q)) {
    return true;
  }

  // Natural language inquiry about mailbox / inbox
  if (/\b(what(?:'s|\s+is)?\s+(?:in|on)\s+(?:my\s+)?(?:inbox|email|emails|mailbox|outlook|yahoo|microsoft))\b/i.test(q)) {
    return true;
  }

  // Temporal / status qualifiers: recent, latest, unread, new
  if (/\b(recent|latest|unread|new|top\s+\d+)\s+(emails?|gmail|inbox|messages?|mails?|mailes?|mailbox|outlook|yahoo|microsoft)\b/i.test(q)) {
    return true;
  }
  if (/\b(emails?|gmail|inbox|messages?|mails?|mailes?|mailbox|outlook|yahoo|microsoft)\s+(recent|latest|unread|new)\b/i.test(q)) {
    return true;
  }

  // Exact standalone email inquiries
  if (/^(emails?|email\s+briefing|inbox|my\s+inbox|recent\s+email|recent\s+emails|recent\s+maile?s?|check\s+email|check\s+my\s+email|outlook|my\s+outlook|check\s+outlook|check\s+my\s+outlook)$/i.test(q)) {
    return true;
  }

  // Sender specific queries e.g. "emails from Sarah"
  if (/\b(emails?|messages?|mails?|mailes?)\s+(?:from|by)\s+[a-z]+/i.test(q)) {
    return true;
  }

  // Generic intent: mentions email/inbox with intent to check/update/read
  if (/\b(email|emails|inbox|mailbox|outlook|yahoo|microsoft)\b/i.test(q) && /\b(check|recent|unread|latest|update|summary|briefing|find|show|get|pull)\b/i.test(q)) {
    return true;
  }

  return false;
}


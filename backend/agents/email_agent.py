"""EmailAgent implementation for unified multi-provider message management (Gmail, Outlook, Yahoo, IMAP)."""
from __future__ import annotations

import logging
import re
from typing import Any

from backend.agents.interfaces import Agent
from backend.agents.models import AgentRequest, AgentResponse, Capability
from backend.agents.security_gateway import SecureToolGateway
from backend.core.config import settings
from backend.sources.models import SourceReference, SourceType
from backend.sources.service import SourceReferenceService

logger = logging.getLogger(__name__)


def _format_provider_label(provider: str | None) -> str:
    p = (provider or "").lower()
    if p in ("google", "gmail"):
        return "Gmail"
    elif p in ("microsoft365", "microsoft", "outlook", "m365"):
        return "Outlook"
    elif p in ("yahoo", "yahoo_mail"):
        return "Yahoo"
    elif p in ("imap", "imap_inbox"):
        return "IMAP"
    return "Email"


class EmailAgent(Agent):
    capability = Capability.EMAIL

    def __init__(
        self,
        email_service=None,
        source_references: SourceReferenceService | None = None,
        gateway: SecureToolGateway | None = None,
    ):
        self._email = email_service
        self._sources = source_references
        self._gateway = gateway

    def run(self, request: AgentRequest) -> AgentResponse:
        if self._email is None:
            return AgentResponse(
                self.capability,
                "Email service is not configured for this environment.",
                (),
            )

        from backend.integrations.email.exceptions import EmailAccessDenied, EmailAuthExpired, EmailProviderError
        from backend.integrations.email.models import EmailProviderContext, EmailSearchRequest
        from backend.integrations.email.unified_resolver import UnifiedEmailResolver

        q_lower = request.query.casefold()

        # Check if user specifically requested email
        is_explicit_email = bool(
            re.search(r"\b(email|emails|mail|inbox|gmail|outlook|yahoo)\b", request.query, flags=re.IGNORECASE)
        )

        # 1. Draft reply / compose detection — Never auto-send without confirmation!
        draft_match = re.search(
            r"\b(?:draft|write|compose|prepare)\s+(?:a\s+)?(?:reply|response|email|message)\s+(?:to\s+)?([^.\n\r]+?)(?:\s+(?:saying|with|that)\s+([^.\n\r]+))?$",
            request.query,
            flags=re.IGNORECASE,
        )
        if draft_match:
            recipient = draft_match.group(1).strip()
            body_text = (draft_match.group(2) or "I will review this and follow up shortly.").strip()
            draft_preview = (
                f"📝 **Prepared Draft Reply**\n\n"
                f"• **To:** {recipient}\n"
                f"• **Content:** \"{body_text}\"\n\n"
                f"⚠️ **Security Notice:** Nanvi requires explicit confirmation before sending emails. "
                f"Would you like me to send this email? Please reply 'Confirm' or open your Mailbox to proceed."
            )
            return AgentResponse(
                self.capability,
                draft_preview,
                (),
                data_source="live",
            )

        # 2. Extract provider hints
        provider_hint = None
        if "gmail" in q_lower or "google" in q_lower:
            provider_hint = "google"
        elif any(k in q_lower for k in ("outlook", "microsoft", "m365", "office365", "office 365")):
            provider_hint = "microsoft365"
        elif "yahoo" in q_lower:
            provider_hint = "yahoo"
        elif "imap" in q_lower:
            provider_hint = "imap"

        # 3. Extract folder hints
        folder_hint = "inbox"
        if re.search(r"\b(sent|outbox|sent messages|sent emails)\b", q_lower):
            folder_hint = "sent"
        elif re.search(r"\b(draft|drafts)\b", q_lower):
            folder_hint = "drafts"
        elif re.search(r"\b(trash|deleted|bin)\b", q_lower):
            folder_hint = "trash"

        # 4. Strip common conversational noise words to get the actual target topic / sender
        noise_pattern = (
            r"\b(what|did|does|do|is|was|are|were|say|said|tell|summarize|summary|explain|about|regarding|"
            r"check|show|get|read|search|find|view|list|any|my|me|the|our|for|recent|resent|latest|last|new|incoming|unread|"
            r"emails?|mails?|maile|mailes|inbox|mailbox|gmail|google|outlook|microsoft|m365|office365|o365|yahoo|imap|"
            r"files?|documents?|please|could|would|can|you|how|who|when|where|in|on|of|to|from|by|sent|received|with|and|or|update|status)\b"
        )
        clean_q = re.sub(noise_pattern, " ", request.query, flags=re.IGNORECASE)
        clean_q = re.sub(r"[\"\'\?\!\.,;:]", " ", clean_q)
        clean_q = " ".join(clean_q.split()).strip()
        filename_match = re.search(
            r"(?i)(?<![\w])([A-Za-z0-9_-]+\.(?:pdf|docx|xlsx|csv|txt|md|pptx|png|jpe?g|webp|bmp|tiff?|gif))(?![\w])",
            request.query,
        )
        email_search_query = f"filename:{filename_match.group(1)}" if filename_match else clean_q

        # 5. Discover user's connected mailboxes across all providers
        user_id = getattr(request.user, "user_id", None) or getattr(request.user, "subject", "user")
        tenant_id = getattr(request.user, "tenant_id", "enterprise-tenant") or "enterprise-tenant"
        resolver = UnifiedEmailResolver()
        mailboxes = resolver.discover_mailboxes(user_id, tenant_id)

        target_mailboxes = mailboxes
        if provider_hint:
            target_mailboxes = [
                mb for mb in mailboxes
                if mb.provider.lower() == provider_hint
                or (provider_hint == "microsoft365" and mb.provider.lower() in ("microsoft", "microsoft365", "outlook"))
            ]

        # If user explicitly asked for a provider they have not connected
        if provider_hint and not target_mailboxes and mailboxes:
            prov_name = "Microsoft 365 / Outlook" if provider_hint == "microsoft365" else provider_hint.capitalize()
            connected_names = ", ".join(f"{_format_provider_label(mb.provider)} ({mb.email_address})" for mb in mailboxes)
            return AgentResponse(
                self.capability,
                f"No {prov_name} account is connected. You currently have: {connected_names}. You can connect your {prov_name} account in **Settings → Connections**.",
                (),
                data_source="live",
            )

        import backend.core.config as cfg
        if not mailboxes and (cfg.settings.is_production or not cfg.settings.allows_synthetic_data):
            return AgentResponse(
                self.capability,
                "No Gmail account is connected. Click Connect Mailbox to connect your Google Workspace / Gmail, Microsoft 365, or Yahoo Mail account.",
                (),
                data_source="live",
            )

        messages = []
        search_failed = False
        auth_expired = False
        target_account_id = target_mailboxes[0].account_id if (provider_hint and target_mailboxes) else None

        if email_search_query:
            try:
                if hasattr(self._email, "search_all"):
                    messages = self._email.search_all(
                        request.user,
                        EmailSearchRequest(query=email_search_query, folder=folder_hint, max_results=5),
                        account_id=target_account_id,
                    )
                else:
                    context = EmailProviderContext(
                        user_id=user_id,
                        tenant_id=tenant_id,
                        access_token="live_auth",
                        granted_scopes=frozenset({"gmail.readonly", "email", "Mail.Read"}),
                    )
                    messages = self._email.search(
                        request.user,
                        context,
                        EmailSearchRequest(query=email_search_query, folder=folder_hint, max_results=5),
                    )
            except EmailAuthExpired as exc:
                logger.warning("Email search authorization expired: %s", exc)
                auth_expired = True
            except Exception as exc:
                logger.warning("Email search for '%s' failed: %s", email_search_query, exc)
                search_failed = True

        # If combined multi-word search yielded nothing, retry with the strongest individual term(s)
        if not messages and not auth_expired and not search_failed and email_search_query and " " in email_search_query and hasattr(self._email, "search_all"):
            sub_terms = [t for t in email_search_query.split() if len(t) > 2]
            for term in sub_terms[:3]:
                try:
                    hits = self._email.search_all(
                        request.user,
                        EmailSearchRequest(query=term, folder=folder_hint, max_results=5),
                        account_id=target_account_id,
                    )
                    if hits:
                        messages = hits
                        break
                except Exception:
                    pass

        # Fallback to recent inbox messages if specific search yielded nothing or if query was just asking to check mail
        if not messages and not auth_expired and (is_explicit_email or not clean_q):
            try:
                if hasattr(self._email, "search_all"):
                    messages = self._email.search_all(
                        request.user,
                        EmailSearchRequest(query="", folder=folder_hint, max_results=5),
                        account_id=target_account_id,
                    )
                else:
                    context = EmailProviderContext(
                        user_id=user_id,
                        tenant_id=tenant_id,
                        access_token="live_auth",
                        granted_scopes=frozenset({"gmail.readonly", "email", "Mail.Read"}),
                    )
                    messages = self._email.search(
                        request.user,
                        context,
                        EmailSearchRequest(query="", folder=folder_hint, max_results=5),
                    )
            except EmailAuthExpired as exc:
                logger.warning("Recent email authorization expired: %s", exc)
                auth_expired = True
            except Exception as exc:
                logger.warning("Recent email inbox fetch failed: %s", exc)

        if auth_expired:
            return AgentResponse(
                self.capability,
                "Your email account connection has expired or requires reauthorization. Please reconnect your account in **Settings → Connections**.",
                (),
                data_source="live",
            )

        if not messages:
            if search_failed:
                return AgentResponse(
                    self.capability,
                    "Email search failed because mailbox access was denied or unavailable. Reconnect the mailbox in **Settings**.",
                    (),
                    data_source="live",
                )
            if is_explicit_email:
                if mailboxes:
                    addrs = ", ".join(f"**{mb.email_address}**" for mb in (target_mailboxes or mailboxes))
                    return AgentResponse(
                        self.capability,
                        f"No relevant messages or email attachments found in your connected mailbox ({addrs}).",
                        (),
                        data_source="live",
                    )
                return AgentResponse(
                    self.capability,
                    "No Gmail account is connected. Click Connect Mailbox to connect your Google Workspace / Gmail account.",
                    (),
                    data_source="live",
                )
            if any(w in request.query.casefold() for w in ("resume", "candidate", "applicant", "hiring", "interview")):
                return AgentResponse(
                    self.capability,
                    "No relevant messages or email attachments found in your authorized mailbox.",
                    (),
                    data_source="live",
                )
            return AgentResponse(self.capability, "", (), data_source="live")

        is_synthetic = not bool(mailboxes)
        if is_synthetic:
            account_tag = " (Synthetic Demo Inbox)"
            lines = [
                f"Here are sample messages{account_tag} for **\"{request.query}\"** (Note: Showing synthetic sample data because no live mailbox is connected):",
                "",
            ]
        else:
            addrs = ", ".join(f"**{mb.email_address}**" for mb in (target_mailboxes or mailboxes))
            lines = [
                f"Here are the relevant messages ({addrs}) for **\"{request.query}\"**:",
                "",
            ]

        sources: list[SourceReference] = []

        for idx, msg in enumerate(messages, start=1):
            sender_str = f"{msg.sender.name} <{msg.sender.address}>" if msg.sender else "Unknown Sender"
            date_str = msg.received_at.strftime("%b %d, %Y") if msg.received_at else "Recent"
            prov_name = _format_provider_label(getattr(msg, "provider", None) or getattr(msg, "source", None))
            lines.append(f"{idx}. 📧 **[{prov_name}] {msg.subject}**")
            lines.append(f"   • *From:* {sender_str} | *Date:* {date_str}")
            body_excerpt = (getattr(msg, "body_text", None) or msg.body_preview or "").strip()
            if body_excerpt:
                excerpt_clean = " ".join(body_excerpt.split())
                if len(excerpt_clean) > 1000:
                    excerpt_clean = excerpt_clean[:1000] + "..."
                lines.append(f"   • *Content:* {excerpt_clean}")
            if msg.attachments:
                attachment_names = ", ".join(f"`{attachment.name}`" for attachment in msg.attachments)
                lines.append(f"   • *Attachments:* {attachment_names}")
            lines.append("")

            web_link = msg.web_link or ""
            sources.append(
                SourceReference(
                    reference_id=f"{prov_name.lower()}-{msg.id}",
                    source_type=SourceType.EMAIL,
                    display_name=f"[{prov_name}] {msg.subject}",
                    title=f"{msg.subject}",
                    location=f"{prov_name} ({getattr(msg, 'account_email', None) or 'Mailbox'}): {sender_str}",
                    href=web_link,
                )
            )
            for attachment in msg.attachments:
                sources.append(
                    SourceReference(
                        reference_id=f"{prov_name.lower()}-{msg.id}-attachment-{attachment.id}",
                        source_type=SourceType.EMAIL,
                        display_name=f"[{prov_name} attachment] {attachment.name}",
                        title=attachment.name,
                        location=f"{prov_name}: {msg.subject} — {sender_str}",
                        mime_type=attachment.content_type,
                        href=web_link,
                    )
                )

        return AgentResponse(
            self.capability,
            "\n".join(lines),
            tuple(sources),
            data_source="synthetic" if is_synthetic else "live",
        )

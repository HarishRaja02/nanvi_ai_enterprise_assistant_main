"""Unified Multi-Provider Email Resolver and Application Service.

Bridges across all connected enterprise email providers (Google Workspace / Gmail,
Microsoft 365 / Outlook Graph API, Yahoo Mail, and Universal IMAP/TLS) to provide:
1. Multi-account discovery per user.
2. Transparent token refresh and error isolation per mailbox.
3. Cross-mailbox search and aggregation with normalized EmailMessage models.
4. Secure confirmed send/reply routing.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from backend.core.config import settings
from backend.observability.logging import log_event
from backend.security.audit import AuditLogger
from backend.security.authorization import AuthorizationService, Permission, Resource, UserAttributes
from backend.security.rate_limiting import RateLimiter
from .exceptions import EmailAccessDenied, EmailAuthExpired, EmailProviderError, EmailValidationError
from .models import (
    AttachmentMetadata,
    EmailAttachmentContent,
    EmailFolder,
    EmailMessage,
    EmailProviderContext,
    EmailReplyRequest,
    EmailSearchPage,
    EmailSearchRequest,
    EmailSendRequest,
    EmailThread,
)
from .provider import EmailProvider
from .repository import EmailRepository
from .service import EmailService, ProviderEmailRepository
from .user_account_service import UserEmailAccount, get_user_email_account_service

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class UnifiedEmailMailbox:
    """An active mailbox session bound to a specific user and provider."""
    account_id: str
    user_id: str
    tenant_id: str
    provider: str
    email_address: str
    display_name: str
    client: Any
    scopes: frozenset[str] = field(default_factory=frozenset)
    is_active: bool = True
    avatar_url: str | None = None
    connected_at: str = ""

    def make_context(self) -> EmailProviderContext:
        token = getattr(self.client, "_access_token", None) or "live_auth"
        if hasattr(self.client, "_account") and getattr(self.client._account, "access_token", None):
            token = self.client._account.access_token
        return EmailProviderContext(
            user_id=self.user_id,
            tenant_id=self.tenant_id,
            access_token=token,
            granted_scopes=self.scopes,
        )


class UnifiedEmailResolver:
    """Discovers, initializes, and manages multi-provider email clients for a user."""

    def __init__(self, account_service=None, connection_manager=None) -> None:
        self._accounts = account_service
        self._cm = connection_manager

    def _get_account_service(self):
        if self._accounts is None:
            self._accounts = get_user_email_account_service()
        return self._accounts

    def _get_connection_manager(self):
        if self._cm is None:
            try:
                from backend.connections.manager import get_connection_manager
                self._cm = get_connection_manager()
            except Exception:
                self._cm = None
        return self._cm

    def discover_mailboxes(
        self, user_id: str, tenant_id: str = "enterprise-tenant"
    ) -> list[UnifiedEmailMailbox]:
        """Discover all active connected mailboxes across local/DB stores and Connections Hub."""
        account_svc = self._get_account_service()
        accounts = account_svc.get_accounts(user_id, tenant_id=tenant_id)

        mailboxes: list[UnifiedEmailMailbox] = []
        seen_addresses: set[str] = set()

        # 1. Accounts from UserEmailAccountService (Google, Microsoft, Yahoo, IMAP)
        for acc in accounts:
            if not acc.is_active:
                continue
            em_lower = acc.email_address.lower()
            if em_lower in seen_addresses:
                continue
            seen_addresses.add(em_lower)

            prov = (acc.provider or "google").lower()
            client = self._build_client_for_account(acc, tenant_id)
            if client is None:
                continue

            import re
            granted_scopes = frozenset(
                s.strip() for s in re.split(r"[\s,]+", acc.scopes or "email") if s.strip()
            )
            mailboxes.append(
                UnifiedEmailMailbox(
                    account_id=acc.id,
                    user_id=user_id,
                    tenant_id=tenant_id,
                    provider=prov,
                    email_address=acc.email_address,
                    display_name=acc.display_name or acc.email_address,
                    client=client,
                    scopes=granted_scopes,
                    is_active=acc.is_active,
                    avatar_url=acc.avatar_url,
                    connected_at=acc.connected_at,
                )
            )

        # 2. Accounts from Connections Hub
        cm = self._get_connection_manager()
        if cm:
            try:
                from backend.security.models import UserIdentity
                from backend.security.authorization.rbac import Role
                mock_user = UserIdentity(
                    subject=user_id,
                    issuer="internal",
                    tenant_id=tenant_id,
                    roles=frozenset({Role.SUPERIOR, Role.CEO, Role.EMPLOYEE, Role.IT_ADMIN}),
                )
                for p_id in ("google", "microsoft365", "outlook", "yahoo", "imap"):
                    try:
                        conn_client = cm.get_client_for_agent(p_id, mock_user)
                        h_acc = getattr(conn_client, "_account", None)
                        if h_acc and h_acc.email_address:
                            em = h_acc.email_address.lower()
                            if em not in seen_addresses:
                                seen_addresses.add(em)
                                import re
                                scopes = frozenset(
                                    s.strip() for s in re.split(r"[\s,]+", h_acc.scopes or "email") if s.strip()
                                )
                                mailboxes.append(
                                    UnifiedEmailMailbox(
                                        account_id=h_acc.id or f"hub-{p_id}-{em}",
                                        user_id=user_id,
                                        tenant_id=tenant_id,
                                        provider=p_id,
                                        email_address=h_acc.email_address,
                                        display_name=h_acc.display_name or h_acc.email_address,
                                        client=conn_client,
                                        scopes=scopes,
                                        is_active=True,
                                        avatar_url=h_acc.avatar_url,
                                        connected_at=h_acc.connected_at,
                                    )
                                )
                    except Exception:
                        pass
            except Exception as exc:
                logger.debug("Connections Hub discovery error: %s", exc)

        return mailboxes

    def _build_client_for_account(self, account: UserEmailAccount, tenant_id: str) -> Any:
        """Instantiate the concrete provider client bound to the account."""
        prov = (account.provider or "google").lower()
        try:
            if prov in ("google", "gmail"):
                from .gmail import GmailEmailProvider
                return GmailEmailProvider(account=account)
            elif prov in ("microsoft365", "outlook", "microsoft"):
                # Check if connected via OAuth tokens or via IMAP credentials
                has_oauth = bool(account.refresh_token or (account.access_token and account.access_token.startswith("ey")))
                if has_oauth:
                    from .graph import MicrosoftGraphEmailProvider
                    provider = MicrosoftGraphEmailProvider()
                    setattr(provider, "_account", account)
                    setattr(provider, "_access_token", account.access_token)
                    return provider
                else:
                    from .imap_provider import ImapEmailProvider
                    creds = {
                        "email": account.email_address,
                        "password": account.access_token,
                        "imap_host": "outlook.office365.com",
                        "smtp_host": "smtp.office365.com",
                    }
                    return ImapEmailProvider(
                        host="outlook.office365.com",
                        port=993,
                        smtp_host="smtp.office365.com",
                        smtp_port=587,
                        account=account,
                        credentials=creds,
                    )
            elif prov == "yahoo":
                from .imap_provider import ImapEmailProvider
                creds = {
                    "email": account.email_address,
                    "password": account.access_token,
                    "imap_host": "imap.mail.yahoo.com",
                    "smtp_host": "smtp.mail.yahoo.com",
                }
                return ImapEmailProvider(
                    host="imap.mail.yahoo.com",
                    port=993,
                    smtp_host="smtp.mail.yahoo.com",
                    smtp_port=465,
                    account=account,
                    credentials=creds,
                )
            elif prov == "imap":
                from .imap_provider import ImapEmailProvider
                creds = {
                    "email": account.email_address,
                    "password": account.access_token,
                }
                return ImapEmailProvider(
                    account=account,
                    credentials=creds,
                )
            else:
                from .gmail import GmailEmailProvider
                return GmailEmailProvider(account=account)
        except Exception as exc:
            logger.warning("Could not build client for provider '%s': %s", prov, exc)
            return None

    def get_mailbox(
        self, user_id: str, account_id: str | None = None, email_address: str | None = None, tenant_id: str = "enterprise-tenant"
    ) -> UnifiedEmailMailbox | None:
        """Find a specific mailbox for a user, or return the default active mailbox."""
        mailboxes = self.discover_mailboxes(user_id, tenant_id)
        if not mailboxes:
            return None
        if account_id:
            for mb in mailboxes:
                if mb.account_id == account_id:
                    return mb
        if email_address:
            em_low = email_address.lower()
            for mb in mailboxes:
                if mb.email_address.lower() == em_low:
                    return mb
        return mailboxes[0]


class MultiProviderEmailService:
    """Enterprise multi-account email coordinator. AI and API routes interact through this."""

    RESOURCE_ID = "user-mailbox"

    def __init__(
        self,
        resolver: UnifiedEmailResolver,
        authorization: AuthorizationService,
        audit_logger: AuditLogger,
        rate_limiter: RateLimiter | None = None,
        source_service=None,
    ) -> None:
        self._resolver = resolver
        self._authorization = authorization
        self._audit = audit_logger
        self._rate_limiter = rate_limiter
        self._source_service = source_service

    def _get_service_for_mailbox(self, mb: UnifiedEmailMailbox) -> EmailService:
        repo = ProviderEmailRepository(mb.client)
        return EmailService(
            repository=repo,
            authorization=self._authorization,
            audit_logger=self._audit,
            rate_limiter=self._rate_limiter,
            source_service=self._source_service,
        )

    def search(
        self,
        user: UserAttributes,
        context: EmailProviderContext | None,
        request: EmailSearchRequest,
        account_id: str | None = None,
    ) -> list[EmailMessage]:
        """Search adapter for compatibility with EmailService.search interface."""
        return self.search_all(user, request, account_id=account_id)

    def search_all(
        self,
        user: UserAttributes,
        request: EmailSearchRequest,
        account_id: str | None = None,
    ) -> list[EmailMessage]:
        """Search across one or all connected mailboxes with error isolation."""
        mailboxes = self._resolver.discover_mailboxes(user.user_id, user.tenant_id)
        if account_id:
            mailboxes = [mb for mb in mailboxes if mb.account_id == account_id]

        if not mailboxes:
            # Check if synthetic fallback is allowed
            if settings.is_production or not settings.allows_synthetic_data:
                return []
            # Return demo messages via GmailEmailProvider fallback
            from .gmail import GmailEmailProvider
            dummy_mb = UnifiedEmailMailbox(
                account_id="demo-fallback",
                user_id=user.user_id,
                tenant_id=user.tenant_id,
                provider="google",
                email_address="demo@nanvi.local",
                display_name="Demo Inbox",
                client=GmailEmailProvider(),
                scopes=frozenset({"gmail.readonly", "email"}),
            )
            svc = self._get_service_for_mailbox(dummy_mb)
            return svc.search(user, dummy_mb.make_context(), request)

        all_messages: list[EmailMessage] = []
        errors: list[str] = []

        for mb in mailboxes:
            try:
                svc = self._get_service_for_mailbox(mb)
                ctx = mb.make_context()
                msgs = svc.search(user, ctx, request)
                # Tag messages with mailbox metadata
                tagged = [
                    EmailMessage(
                        id=m.id,
                        conversation_id=m.conversation_id,
                        subject=m.subject,
                        sender=m.sender,
                        to_recipients=m.to_recipients,
                        cc_recipients=m.cc_recipients,
                        received_at=m.received_at,
                        sent_at=m.sent_at,
                        body_preview=m.body_preview,
                        has_attachments=m.has_attachments,
                        attachments=m.attachments,
                        web_link=m.web_link,
                        source=m.source or mb.provider,
                        body_text=m.body_text,
                        body_html_sanitized=m.body_html_sanitized,
                        folder=m.folder or "inbox",
                        account_id=mb.account_id,
                        account_email=mb.email_address,
                        provider=mb.provider,
                        message_id_header=m.message_id_header,
                        reply_to=m.reply_to,
                    )
                    for m in msgs
                ]
                all_messages.extend(tagged)
            except EmailAuthExpired as e_auth:
                logger.warning("Mailbox '%s' (%s) authorization expired: %s", mb.email_address, mb.provider, e_auth)
                errors.append(f"{mb.email_address}: authentication expired")
            except Exception as exc:
                logger.warning("Search failed on mailbox '%s' (%s): %s", mb.email_address, mb.provider, exc)
                errors.append(f"{mb.email_address}: {exc}")

        # If all mailboxes encountered auth expiration, raise EmailAuthExpired
        if errors and len(errors) == len(mailboxes) and not all_messages:
            raise EmailAuthExpired(f"Connected email accounts need reauthorization: {', '.join(errors)}")

        # Sort aggregated messages by received_at descending
        epoch_fallback = datetime(1970, 1, 1, tzinfo=timezone.utc)
        all_messages.sort(
            key=lambda m: m.received_at if m.received_at else epoch_fallback,
            reverse=True,
        )
        return all_messages[: request.max_results]

    def list_folders(
        self, user: UserAttributes, account_id: str | None = None
    ) -> list[EmailFolder]:
        """List folders for a specific connected mailbox or the primary active mailbox."""
        mb = self._resolver.get_mailbox(user.user_id, account_id=account_id, tenant_id=user.tenant_id)
        if not mb:
            return [EmailFolder(id="inbox", name="Inbox")]
        svc = self._get_service_for_mailbox(mb)
        return svc.list_folders(user, mb.make_context())

    def list_messages(
        self,
        user: UserAttributes,
        folder_id: str = "inbox",
        account_id: str | None = None,
        limit: int = 25,
        cursor: str | None = None,
    ) -> EmailSearchPage:
        """List messages in a folder for the specified or primary mailbox."""
        mb = self._resolver.get_mailbox(user.user_id, account_id=account_id, tenant_id=user.tenant_id)
        if not mb:
            return EmailSearchPage(messages=(), next_cursor=None)
        svc = self._get_service_for_mailbox(mb)
        return svc.list_messages(user, mb.make_context(), folder_id=folder_id, limit=limit, cursor=cursor)

    def get_message(
        self, user: UserAttributes, message_id: str, account_id: str | None = None
    ) -> EmailMessage:
        """Fetch a full email message by ID, checking targeted or all available mailboxes."""
        mailboxes = self._resolver.discover_mailboxes(user.user_id, user.tenant_id)
        if account_id:
            mailboxes = [mb for mb in mailboxes if mb.account_id == account_id]
        if not mailboxes:
            raise EmailProviderError("No connected email accounts available.")

        last_err: Exception | None = None
        for mb in mailboxes:
            try:
                svc = self._get_service_for_mailbox(mb)
                return svc.get_message(user, mb.make_context(), message_id)
            except Exception as exc:
                last_err = exc

        raise EmailProviderError(f"Email message '{message_id}' not found: {last_err}")

    def get_thread(
        self, user: UserAttributes, conversation_id: str, account_id: str | None = None
    ) -> EmailThread:
        """Fetch a full thread by conversation ID."""
        mailboxes = self._resolver.discover_mailboxes(user.user_id, user.tenant_id)
        if account_id:
            mailboxes = [mb for mb in mailboxes if mb.account_id == account_id]
        if not mailboxes:
            raise EmailProviderError("No connected email accounts available.")

        for mb in mailboxes:
            try:
                svc = self._get_service_for_mailbox(mb)
                return svc.get_thread(user, mb.make_context(), conversation_id)
            except Exception:
                pass

        raise EmailProviderError(f"Thread '{conversation_id}' not found in connected mailboxes.")

    def get_attachments(
        self, user: UserAttributes, message_id: str, account_id: str | None = None
    ) -> tuple[AttachmentMetadata, ...]:
        """Fetch attachments for a message."""
        mb = self._resolver.get_mailbox(user.user_id, account_id=account_id, tenant_id=user.tenant_id)
        if not mb:
            return ()
        svc = self._get_service_for_mailbox(mb)
        return svc.get_attachments(user, mb.make_context(), message_id)

    def download_attachment(
        self, user: UserAttributes, message_id: str, attachment_id: str, account_id: str | None = None
    ) -> EmailAttachmentContent:
        """Download attachment content with permission check."""
        mb = self._resolver.get_mailbox(user.user_id, account_id=account_id, tenant_id=user.tenant_id)
        if not mb:
            raise EmailProviderError("No connected mailbox found for downloading attachment.")
        svc = self._get_service_for_mailbox(mb)
        return svc.download_attachment(user, mb.make_context(), message_id, attachment_id)

    def send_email(
        self,
        user: UserAttributes,
        request: EmailSendRequest,
        confirmed: bool = False,
    ) -> EmailMessage:
        """Send an email from the designated or primary connected mailbox."""
        if not confirmed:
            raise EmailValidationError("Explicit user confirmation is required to send emails.")
        mb = self._resolver.get_mailbox(user.user_id, account_id=request.account_id, tenant_id=user.tenant_id)
        if not mb:
            raise EmailProviderError("No active email account connected to send message.")
        svc = self._get_service_for_mailbox(mb)
        return svc.send_email(user, mb.make_context(), request, confirmed=confirmed)

    def reply_email(
        self,
        user: UserAttributes,
        request: EmailReplyRequest,
        confirmed: bool = False,
    ) -> EmailMessage:
        """Reply to an existing email message."""
        if not confirmed:
            raise EmailValidationError("Explicit user confirmation is required to reply to emails.")
        mb = self._resolver.get_mailbox(user.user_id, account_id=request.account_id, tenant_id=user.tenant_id)
        if not mb:
            raise EmailProviderError("No active email account connected to reply to message.")
        svc = self._get_service_for_mailbox(mb)
        return svc.reply_email(user, mb.make_context(), request, confirmed=confirmed)

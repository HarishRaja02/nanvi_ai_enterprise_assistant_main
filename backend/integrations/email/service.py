from __future__ import annotations
from backend.security.audit import AuditLogger
from backend.security.authorization import AuthorizationService, Permission, Resource, UserAttributes
from backend.security.rate_limiting import RateLimiter, RateLimitExceeded
from .exceptions import EmailAccessDenied, EmailRateLimited, EmailValidationError, EmailProviderError
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
from .repository import EmailRepository
from backend.observability.logging import log_event
import logging
import time

logger = logging.getLogger(__name__)

ALLOWED_READ_SCOPES = frozenset({
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://mail.google.com/",
    "https://graph.microsoft.com/mail.read",
    "https://graph.microsoft.com/mail.readwrite",
    "gmail.readonly",
    "email",
    "mail.read",
    "mail.readwrite",
    "mail-read",
    "mail-search",
    "imap-read",
    "*",
})

ALLOWED_SEND_SCOPES = frozenset({
    "https://www.googleapis.com/auth/gmail.send",
    "https://mail.google.com/",
    "https://graph.microsoft.com/mail.send",
    "https://graph.microsoft.com/mail.readwrite",
    "gmail.send",
    "mail.send",
    "mail.readwrite",
    "mail-send",
    "smtp-send",
    "email",
    "*",
})


class EmailService:
    """Security-aware email application service; AI/tools call this, never Graph directly."""

    RESOURCE_ID = "user-mailbox"

    def __init__(self, repository: EmailRepository, authorization: AuthorizationService,
                 audit_logger: AuditLogger, rate_limiter: RateLimiter | None = None, source_service=None):
        self._repository = repository
        self._authorization = authorization
        self._audit = audit_logger
        self._rate_limiter = rate_limiter
        self._source_service = source_service

    def _authorize(self, user: UserAttributes, context: EmailProviderContext, operation: str) -> None:
        if not context.access_token:
            self._audit.record("email_access", "deny", user.user_id, user.tenant_id, self.RESOURCE_ID,
                               {"operation": operation, "reason": "Delegated mailbox token missing"})
            raise EmailAccessDenied("Email access denied")

        is_send_op = operation in ("send_email", "reply_email")
        required_scopes = ALLOWED_SEND_SCOPES if is_send_op else ALLOWED_READ_SCOPES
        required_perm = Permission.EMAIL_SEND if is_send_op else Permission.EMAIL_READ

        normalized_granted = {str(s).strip().lower() for s in (context.granted_scopes or ())}
        if not normalized_granted or not (normalized_granted & required_scopes):
            reason = f"Required email {'send' if is_send_op else 'read'} scope is missing"
            self._audit.record("email_access", "deny", user.user_id, user.tenant_id, self.RESOURCE_ID,
                               {"operation": operation, "reason": reason})
            raise EmailAccessDenied(f"Email access denied: {reason.lower()}")

        if context.user_id != user.user_id or context.tenant_id != user.tenant_id:
            self._audit.record("email_access", "deny", user.user_id, user.tenant_id, self.RESOURCE_ID,
                               {"operation": operation, "reason": "Provider context does not match authenticated principal"})
            raise EmailAccessDenied("Email access denied: provider context mismatch")

        resource = Resource(resource_id=self.RESOURCE_ID, resource_type="email_mailbox",
                            tenant_id=context.tenant_id, owner_id=context.user_id)
        decision = self._authorization.authorize(user, required_perm, resource)
        if not decision.allowed:
            self._audit.record("email_access", "deny", user.user_id, user.tenant_id, self.RESOURCE_ID,
                               {"operation": operation, "reason": decision.reason})
            raise EmailAccessDenied("Email access denied by authorization policy")

    def _check_rate_limit(self, user: UserAttributes, operation: str) -> None:
        if self._rate_limiter is None:
            return
        try:
            self._rate_limiter.check(f"email:{user.tenant_id}:{user.user_id}")
        except RateLimitExceeded as exc:
            self._audit.record("email_access", "deny", user.user_id, user.tenant_id, self.RESOURCE_ID,
                               {"operation": operation, "reason": "application rate limit exceeded"})
            raise EmailRateLimited("Email request rate limit exceeded") from exc

    def search(self, user: UserAttributes, context: EmailProviderContext, request: EmailSearchRequest) -> list[EmailMessage]:
        return list(self.search_page(user, context, request).messages)

    def search_page(self, user: UserAttributes, context: EmailProviderContext, request: EmailSearchRequest) -> EmailSearchPage:
        self._authorize(user, context, "search")
        self._check_rate_limit(user, "search")
        started = time.perf_counter()
        try:
            page = self._repository.search_page(context, request)
        except EmailRateLimited:
            log_event(logger, "external_email_api_failed", logging.WARNING, actor_id=user.user_id, tenant_id=user.tenant_id, operation="search", failure="rate_limited", duration_ms=round((time.perf_counter() - started) * 1000, 2))
            self._audit.record("email_access", "deny", user.user_id, user.tenant_id, self.RESOURCE_ID,
                               {"operation": "search", "reason": "provider rate limit exceeded"})
            raise
        except Exception as exc:
            log_event(logger, "external_email_api_failed", logging.ERROR, actor_id=user.user_id, tenant_id=user.tenant_id, operation="search", failure=type(exc).__name__, duration_ms=round((time.perf_counter() - started) * 1000, 2))
            self._audit.record("email_access", "error", user.user_id, user.tenant_id, self.RESOURCE_ID,
                               {"operation": "search", "reason": type(exc).__name__, "duration_ms": round((time.perf_counter() - started) * 1000, 2)})
            if isinstance(exc, (EmailAccessDenied, EmailRateLimited, EmailProviderError, ValueError)):
                raise
            raise EmailProviderError("Email provider request failed") from exc
        log_event(logger, "external_email_api_completed", actor_id=user.user_id, tenant_id=user.tenant_id, operation="search", result_count=len(page.messages), duration_ms=round((time.perf_counter() - started) * 1000, 2))
        self._audit.record("email_access", "allow", user.user_id, user.tenant_id, self.RESOURCE_ID,
                           {"operation": "search", "result_count": len(page.messages),
                            "has_next_page": bool(page.next_cursor),
                            "date_filtered": bool(request.after or request.before),
                            "sender_filtered": bool(request.sender),
                            "recipient_filtered": bool(request.recipient),
                            "subject_filtered": bool(request.subject),
                            "attachment_filtered": request.has_attachments is not None,
                            "semantic_query": bool(request.query)})
        return page

    def source_references(self, user: UserAttributes, request_id: str,
                          messages: tuple[EmailMessage, ...]) -> tuple:
        """Create permission-checked, frontend-safe source references for email evidence."""
        if self._source_service is None:
            return ()
        from backend.analysis.models import DataLineage
        lineage = tuple(
            DataLineage(
                source_type="email",
                source_id=message.id,
                source_label=message.subject or "Email message",
                columns=(),
                query=None,
                tenant_id=user.tenant_id,
                owner_id=user.user_id,
                resource_type="email_mailbox",
            )
            for message in messages
        )
        return self._source_service.from_lineage(user, request_id, lineage)

    def get_thread(self, user: UserAttributes, context: EmailProviderContext, conversation_id: str) -> EmailThread:
        self._authorize(user, context, "thread")
        self._check_rate_limit(user, "thread")
        result = self._repository.get_thread(context, conversation_id)
        self._audit.record("email_access", "allow", user.user_id, user.tenant_id, self.RESOURCE_ID,
                           {"operation": "thread", "conversation_id_hash": hash(conversation_id), "message_count": len(result.messages)})
        return result

    def get_message(self, user: UserAttributes, context: EmailProviderContext, message_id: str) -> EmailMessage:
        self._authorize(user, context, "message")
        self._check_rate_limit(user, "message")
        result = self._repository.get_message(context, message_id)
        self._audit.record("email_access", "allow", user.user_id, user.tenant_id, self.RESOURCE_ID,
                           {"operation": "message", "message_id_hash": hash(message_id)})
        return result

    def list_folders(self, user: UserAttributes, context: EmailProviderContext) -> list[EmailFolder]:
        self._authorize(user, context, "list_folders")
        self._check_rate_limit(user, "list_folders")
        started = time.perf_counter()
        folders = self._repository.list_folders(context)
        self._audit.record("email_access", "allow", user.user_id, user.tenant_id, self.RESOURCE_ID,
                           {"operation": "list_folders", "folder_count": len(folders), "duration_ms": round((time.perf_counter() - started) * 1000, 2)})
        return folders

    def list_messages(
        self,
        user: UserAttributes,
        context: EmailProviderContext,
        folder_id: str = "inbox",
        limit: int = 25,
        cursor: str | None = None,
    ) -> EmailSearchPage:
        self._authorize(user, context, "list_messages")
        self._check_rate_limit(user, "list_messages")
        started = time.perf_counter()
        page = self._repository.list_messages(context, folder_id=folder_id, limit=limit, cursor=cursor)
        self._audit.record("email_access", "allow", user.user_id, user.tenant_id, self.RESOURCE_ID,
                           {"operation": "list_messages", "folder_id": folder_id, "result_count": len(page.messages), "duration_ms": round((time.perf_counter() - started) * 1000, 2)})
        return page

    def get_attachments(self, user: UserAttributes, context: EmailProviderContext, message_id: str) -> tuple[AttachmentMetadata, ...]:
        self._authorize(user, context, "get_attachments")
        self._check_rate_limit(user, "get_attachments")
        result = self._repository.get_attachments(context, message_id)
        self._audit.record("email_access", "allow", user.user_id, user.tenant_id, self.RESOURCE_ID,
                           {"operation": "get_attachments", "message_id_hash": hash(message_id), "count": len(result)})
        return result

    def download_attachment(
        self, user: UserAttributes, context: EmailProviderContext, message_id: str, attachment_id: str
    ) -> EmailAttachmentContent:
        self._authorize(user, context, "download_attachment")
        self._check_rate_limit(user, "download_attachment")
        started = time.perf_counter()
        content = self._repository.download_attachment(context, message_id, attachment_id)
        self._audit.record("email_access", "allow", user.user_id, user.tenant_id, self.RESOURCE_ID,
                           {"operation": "download_attachment", "attachment_id": attachment_id, "size_bytes": content.size_bytes, "duration_ms": round((time.perf_counter() - started) * 1000, 2)})
        return content

    def send_email(
        self,
        user: UserAttributes,
        context: EmailProviderContext,
        request: EmailSendRequest,
        confirmed: bool = False,
    ) -> EmailMessage:
        if not confirmed:
            raise EmailValidationError("Explicit confirmation is required to send emails.")
        self._authorize(user, context, "send_email")
        self._check_rate_limit(user, "send_email")
        started = time.perf_counter()
        try:
            sent_msg = self._repository.send_email(context, request)
        except Exception as exc:
            self._audit.record("email_send", "error", user.user_id, user.tenant_id, self.RESOURCE_ID,
                               {"operation": "send_email", "error": str(exc), "duration_ms": round((time.perf_counter() - started) * 1000, 2)})
            raise
        self._audit.record("email_send", "allow", user.user_id, user.tenant_id, self.RESOURCE_ID,
                           {"operation": "send_email", "subject": request.subject, "recipient_count": len(request.to_recipients), "duration_ms": round((time.perf_counter() - started) * 1000, 2)})
        return sent_msg

    def reply_email(
        self,
        user: UserAttributes,
        context: EmailProviderContext,
        request: EmailReplyRequest,
        confirmed: bool = False,
    ) -> EmailMessage:
        if not confirmed:
            raise EmailValidationError("Explicit confirmation is required to reply to emails.")
        self._authorize(user, context, "reply_email")
        self._check_rate_limit(user, "reply_email")
        started = time.perf_counter()
        try:
            sent_msg = self._repository.reply_email(context, request)
        except Exception as exc:
            self._audit.record("email_send", "error", user.user_id, user.tenant_id, self.RESOURCE_ID,
                               {"operation": "reply_email", "error": str(exc), "duration_ms": round((time.perf_counter() - started) * 1000, 2)})
            raise
        self._audit.record("email_send", "allow", user.user_id, user.tenant_id, self.RESOURCE_ID,
                           {"operation": "reply_email", "message_id": request.message_id, "duration_ms": round((time.perf_counter() - started) * 1000, 2)})
        return sent_msg


class ProviderEmailRepository(EmailRepository):
    """Adapter that keeps the service independent of Microsoft Graph, Gmail, or IMAP."""

    def __init__(self, provider):
        self._provider = provider

    def search(self, context, request):
        return self._provider.search(context, request)

    def search_page(self, context, request):
        if hasattr(self._provider, "search_page"):
            return self._provider.search_page(context, request)
        from .models import EmailSearchPage
        return EmailSearchPage(tuple(self._provider.search(context, request)), None)

    def get_thread(self, context, conversation_id):
        return self._provider.get_thread(context, conversation_id)

    def get_message(self, context, message_id):
        return self._provider.get_message(context, message_id)

    def list_folders(self, context):
        if hasattr(self._provider, "list_folders"):
            return self._provider.list_folders(context)
        return [EmailFolder(id="inbox", name="Inbox")]

    def list_messages(self, context, folder_id="inbox", limit=25, cursor=None):
        if hasattr(self._provider, "list_messages"):
            return self._provider.list_messages(context, folder_id=folder_id, limit=limit, cursor=cursor)
        return self.search_page(context, EmailSearchRequest(max_results=limit, cursor=cursor))

    def get_attachments(self, context, message_id):
        if hasattr(self._provider, "get_attachments"):
            return self._provider.get_attachments(context, message_id)
        msg = self.get_message(context, message_id)
        return msg.attachments

    def download_attachment(self, context, message_id, attachment_id):
        if hasattr(self._provider, "download_attachment"):
            return self._provider.download_attachment(context, message_id, attachment_id)
        raise EmailProviderError("Attachment download not supported by provider")

    def send_email(self, context, request):
        if hasattr(self._provider, "send_email"):
            return self._provider.send_email(context, request)
        raise EmailProviderError("Email sending not supported by provider")

    def reply_email(self, context, request):
        if hasattr(self._provider, "reply_email"):
            return self._provider.reply_email(context, request)
        raise EmailProviderError("Email reply not supported by provider")

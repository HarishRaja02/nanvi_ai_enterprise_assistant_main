from __future__ import annotations
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote, urlparse
import base64
import httpx
import re

from .models import (
    AttachmentMetadata,
    EmailAddress,
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
from .exceptions import EmailAuthExpired, EmailProviderError, EmailRateLimited, EmailValidationError
from backend.core.resilience import RetryPolicy, retry_idempotent
from backend.observability.logging import log_event
import logging
import time

logger = logging.getLogger(__name__)


GRAPH_BASE = "https://graph.microsoft.com/v1.0"
_GRAPH_HOST = "graph.microsoft.com"
_GRAPH_MESSAGES_PATH = "/v1.0/me/messages"


def _address(value: dict[str, Any] | None) -> EmailAddress | None:
    if not value:
        return None
    ea = value.get("emailAddress") or {}
    address = ea.get("address")
    return EmailAddress(address=address, name=ea.get("name")) if address else None


def _addresses(values: list[dict[str, Any]] | None) -> tuple[EmailAddress, ...]:
    result = []
    for value in values or []:
        item = _address(value)
        if item:
            result.append(item)
    return tuple(result)


def _dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise EmailProviderError("Microsoft Graph returned an invalid email timestamp") from exc


def _message(data: dict[str, Any]) -> EmailMessage:
    attachments = tuple(
        AttachmentMetadata(
            id=str(a.get("id", "")), name=str(a.get("name", "")),
            content_type=a.get("contentType"), size_bytes=a.get("size"),
            is_inline=bool(a.get("isInline", False)),
        )
        for a in data.get("attachments", [])
        if isinstance(a, dict)
    )
    body_info = data.get("body") or {}
    raw_content = body_info.get("content") or ""
    content_type = (body_info.get("contentType") or "").lower()
    body_text = None
    body_html = None
    if content_type == "html":
        body_html = raw_content
        body_text = re.sub(r"<[^>]+>", " ", raw_content)
        body_text = " ".join(body_text.split()).strip()
    else:
        body_text = raw_content

    cleaned_html = None
    if body_html:
        cleaned = re.sub(r"(?is)<script[^>]*>.*?</script>", "", body_html)
        cleaned = re.sub(r"(?is)<style[^>]*>.*?</style>", "", cleaned)
        cleaned = re.sub(r"(?i)\son\w+\s*=\s*['\"][^'\"]*['\"]", "", cleaned)
        cleaned_html = re.sub(r"(?i)\son\w+\s*=\s*[^\s>]+", "", cleaned)

    return EmailMessage(
        id=str(data.get("id", "")), conversation_id=data.get("conversationId"),
        subject=data.get("subject") or "", sender=_address(data.get("from")),
        to_recipients=_addresses(data.get("toRecipients")),
        cc_recipients=_addresses(data.get("ccRecipients")),
        received_at=_dt(data.get("receivedDateTime")), sent_at=_dt(data.get("sentDateTime")),
        body_preview=data.get("bodyPreview"),
        has_attachments=bool(data.get("hasAttachments", False)), attachments=attachments,
        web_link=data.get("webLink"), source="microsoft_graph",
        body_text=body_text,
        body_html_sanitized=cleaned_html,
        folder="inbox",
    )


def _cursor_encode(next_link: str) -> str:
    raw = next_link.encode("utf-8")
    if len(raw) > 8192:
        raise EmailProviderError("Microsoft Graph returned an unexpectedly large continuation link")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _cursor_decode(cursor: str) -> str:
    if not cursor or len(cursor) > 12000:
        raise EmailValidationError("Invalid email pagination cursor")
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        url = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise EmailValidationError("Invalid email pagination cursor") from exc
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != _GRAPH_HOST or parsed.port not in (None, 443):
        raise EmailValidationError("Invalid email pagination cursor")
    if parsed.path != _GRAPH_MESSAGES_PATH:
        raise EmailValidationError("Invalid email pagination cursor")
    if parsed.fragment or parsed.username or parsed.password:
        raise EmailValidationError("Invalid email pagination cursor")
    return url


class MicrosoftGraphEmailProvider(EmailProvider):
    """Microsoft Graph delegated-mail provider.

    The caller supplies a short-lived delegated access token in an opaque context.
    This class does not expose client secrets, refresh tokens, passwords, or Graph
    credentials to callers or future AI tools.
    """

    def __init__(self, http_client: httpx.Client | None = None, timeout: float = 15.0, retry_policy: RetryPolicy | None = None):
        self._client = http_client or httpx.Client(timeout=timeout)
        self._retry_policy = retry_policy or RetryPolicy(attempts=2)
        self._account = None
        self._access_token = None

    def _resolve_access_token(self, context: EmailProviderContext, force_refresh: bool = False) -> str:
        acc = getattr(self, "_account", None)
        token = getattr(self, "_access_token", None) or context.access_token

        if not force_refresh and token and token != "live_auth":
            if acc and hasattr(acc, "is_token_expired") and not acc.is_token_expired():
                return token
            elif not acc:
                return token

        # Attempt to refresh token using refresh_token if available
        ref_token = getattr(acc, "refresh_token", None) if acc else None
        if not ref_token and context.user_id:
            try:
                from backend.integrations.email.user_account_service import get_user_email_account_service
                account_svc = get_user_email_account_service()
                user_accs = account_svc.get_accounts(context.user_id)
                for a in user_accs:
                    if (a.provider or "").lower() in ("microsoft365", "outlook") and a.refresh_token:
                        ref_token = a.refresh_token
                        acc = a
                        break
            except Exception:
                pass

        if not ref_token:
            from backend.core.config import settings
            ref_token = getattr(settings, "microsoft_refresh_token", "") or ""

        if ref_token:
            try:
                from backend.connections.providers.microsoft import Microsoft365Provider
                ms_provider = Microsoft365Provider()
                new_token, expires_in = ms_provider.refresh_access_token(ref_token)
                if new_token:
                    self._access_token = new_token
                    if acc:
                        setattr(acc, "access_token", new_token)
                        setattr(acc, "token_expires_at", time.time() + expires_in)
                        try:
                            from backend.integrations.email.user_account_service import get_user_email_account_service
                            get_user_email_account_service().update_tokens(acc.id, new_token, expires_in)
                        except Exception:
                            pass
                    return new_token
            except Exception as r_err:
                logger.warning("Could not refresh Microsoft Graph token: %s", r_err)

        return token or ""

    def _get(self, context: EmailProviderContext, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        token = self._resolve_access_token(context)
        if not token:
            from backend.core.config import settings
            if not settings.is_production and settings.allows_synthetic_data:
                return {"value": []}
            raise EmailProviderError("A delegated Graph access token is required")

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "ConsistencyLevel": "eventual",
        }

        def operation():
            try:
                response = self._client.get(
                    f"{GRAPH_BASE}{path}", params=params,
                    headers=headers,
                )
                if response.status_code == 401:
                    fresh = self._resolve_access_token(context, force_refresh=True)
                    if fresh and fresh != token:
                        headers["Authorization"] = f"Bearer {fresh}"
                        response = self._client.get(
                            f"{GRAPH_BASE}{path}", params=params,
                            headers=headers,
                        )
                return self._handle_response(response)
            except httpx.TimeoutException as exc:
                raise EmailProviderError("Microsoft Graph request timed out") from exc
            except httpx.HTTPError as exc:
                raise EmailProviderError("Microsoft Graph request failed") from exc

        started = time.perf_counter()
        try:
            data = retry_idempotent(operation, policy=self._retry_policy, retry_if=lambda exc: self._retryable(exc))
        except EmailRateLimited:
            log_event(logger, "external_api_failed", logging.WARNING, provider="microsoft_graph", operation="mail_read", failure="rate_limited", duration_ms=round((time.perf_counter() - started) * 1000, 2))
            raise
        except EmailProviderError as exc:
            log_event(logger, "external_api_failed", logging.ERROR, provider="microsoft_graph", operation="mail_read", failure=type(exc).__name__, duration_ms=round((time.perf_counter() - started) * 1000, 2))
            raise
        log_event(logger, "external_api_completed", provider="microsoft_graph", operation="mail_read", duration_ms=round((time.perf_counter() - started) * 1000, 2))
        return data

    @staticmethod
    def _retryable(exc: Exception) -> bool:
        if isinstance(exc, EmailProviderError) and not isinstance(exc, EmailRateLimited):
            cause = exc.__cause__
            return isinstance(cause, (httpx.TimeoutException, httpx.TransportError))
        return False

    def _get_url(self, context: EmailProviderContext, url: str) -> dict[str, Any]:
        token = self._resolve_access_token(context)
        if not token:
            from backend.core.config import settings
            if not settings.is_production and settings.allows_synthetic_data:
                return {"value": []}
            raise EmailProviderError("A delegated Graph access token is required")

        validated = _cursor_decode(_cursor_encode(url))
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "ConsistencyLevel": "eventual",
        }

        def operation():
            try:
                response = self._client.get(
                    validated,
                    headers=headers,
                )
                if response.status_code == 401:
                    fresh = self._resolve_access_token(context, force_refresh=True)
                    if fresh and fresh != token:
                        headers["Authorization"] = f"Bearer {fresh}"
                        response = self._client.get(validated, headers=headers)
                return self._handle_response(response)
            except httpx.TimeoutException as exc:
                raise EmailProviderError("Microsoft Graph request timed out") from exc
            except httpx.HTTPError as exc:
                raise EmailProviderError("Microsoft Graph request failed") from exc
        started = time.perf_counter()
        try:
            data = retry_idempotent(operation, policy=self._retry_policy, retry_if=lambda exc: self._retryable(exc))
        except EmailRateLimited:
            log_event(logger, "external_api_failed", logging.WARNING, provider="microsoft_graph", operation="mail_read_pagination", failure="rate_limited", duration_ms=round((time.perf_counter() - started) * 1000, 2))
            raise
        except EmailProviderError as exc:
            log_event(logger, "external_api_failed", logging.ERROR, provider="microsoft_graph", operation="mail_read_pagination", failure=type(exc).__name__, duration_ms=round((time.perf_counter() - started) * 1000, 2))
            raise
        log_event(logger, "external_api_completed", provider="microsoft_graph", operation="mail_read_pagination", duration_ms=round((time.perf_counter() - started) * 1000, 2))
        return data

    @staticmethod
    def _handle_response(response: httpx.Response) -> dict[str, Any]:
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            retry_seconds: int | None = None
            if retry_after:
                try:
                    retry_seconds = max(0, int(retry_after))
                except ValueError:
                    try:
                        dt = parsedate_to_datetime(retry_after)
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        retry_seconds = max(0, int((dt - datetime.now(timezone.utc)).total_seconds()))
                    except (TypeError, ValueError, OverflowError):
                        retry_seconds = None
            raise EmailRateLimited(retry_after_seconds=retry_seconds)
        if response.status_code in (401, 403):
            raise EmailAuthExpired("Microsoft Graph rejected the mailbox authorization")
        if response.status_code >= 400:
            raise EmailProviderError(f"Microsoft Graph request failed with HTTP {response.status_code}")
        try:
            data = response.json()
        except ValueError as exc:
            raise EmailProviderError("Microsoft Graph returned an invalid response") from exc
        if not isinstance(data, dict):
            raise EmailProviderError("Microsoft Graph returned an unexpected response")
        return data

    @staticmethod
    def _validate_request(request: EmailSearchRequest) -> None:
        if request.max_results < 1 or request.max_results > 100:
            raise EmailValidationError("max_results must be between 1 and 100")
        for name in ("query", "sender", "recipient", "subject"):
            value = getattr(request, name)
            if value and len(value) > 320:
                raise EmailValidationError(f"{name} is invalid")
        if request.after and request.before and request.after >= request.before:
            raise EmailValidationError("after must be earlier than before")

    def search_page(self, context: EmailProviderContext, request: EmailSearchRequest) -> EmailSearchPage:
        self._validate_request(request)
        if request.cursor:
            data = self._get_url(context, _cursor_decode(request.cursor))
        else:
            params: dict[str, Any] = {
                "$top": request.max_results,
                "$select": "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,hasAttachments,webLink",
                "$orderby": "receivedDateTime desc",
            }
            filters = []
            sender_is_display_name = bool(request.sender and "@" not in request.sender)
            if request.sender and not sender_is_display_name:
                escaped = request.sender.replace("'", "''")
                filters.append(f"from/emailAddress/address eq '{escaped}'")
            if request.recipient:
                escaped = request.recipient.replace("'", "''")
                filters.append(f"(toRecipients/any(r:r/emailAddress/address eq '{escaped}') or ccRecipients/any(r:r/emailAddress/address eq '{escaped}'))")
            if request.subject:
                escaped = request.subject.replace("'", "''")
                filters.append(f"subject eq '{escaped}'")
            if request.after:
                filters.append(f"receivedDateTime ge {request.after.isoformat()}")
            if request.before:
                filters.append(f"receivedDateTime lt {request.before.isoformat()}")
            if request.has_attachments is not None:
                filters.append(f"hasAttachments eq {'true' if request.has_attachments else 'false'}")

            kql_parts: list[str] = []
            if request.query:
                phrase = request.query.replace('"', '\\"').strip()
                if phrase:
                    kql_parts.append(phrase)
            if sender_is_display_name and request.sender:
                kql_parts.append(f"from:{request.sender.strip()}")

            if kql_parts:
                combined_kql = " ".join(kql_parts)
                params["$search"] = f'"{combined_kql}"'
                # Graph /me/messages forbids $orderby and $filter whenever $search is used
                params.pop("$orderby", None)
            elif filters:
                params["$filter"] = " and ".join(filters)
            data = self._get(context, "/me/messages", params)
        messages = tuple(_message(item) for item in data.get("value", []) if isinstance(item, dict))
        if not request.cursor and ("$search" in params):
            # Enforce structured filters client-side when $search was active
            filtered = []
            for m in messages:
                if request.sender:
                    s_low = request.sender.casefold()
                    m_addr = (m.sender.address if m.sender else "").casefold()
                    m_name = (m.sender.name or "" if m.sender else "").casefold()
                    if s_low not in m_addr and s_low not in m_name:
                        continue
                if request.recipient:
                    r_low = request.recipient.casefold()
                    all_recips = tuple(m.to_recipients) + tuple(m.cc_recipients)
                    if not any(r_low in (r.address or "").casefold() or r_low in (r.name or "").casefold() for r in all_recips):
                        continue
                if request.subject and request.subject.casefold() not in (m.subject or "").casefold():
                    continue
                if request.after and m.received_at and m.received_at < request.after:
                    continue
                if request.before and m.received_at and m.received_at >= request.before:
                    continue
                if request.has_attachments is not None and m.has_attachments != request.has_attachments:
                    continue
                filtered.append(m)
            messages = tuple(filtered)
        next_link = data.get("@odata.nextLink")
        next_cursor = _cursor_encode(next_link) if isinstance(next_link, str) and next_link else None
        return EmailSearchPage(messages=messages, next_cursor=next_cursor)

    def search(self, context: EmailProviderContext, request: EmailSearchRequest) -> list[EmailMessage]:
        return list(self.search_page(context, request).messages)

    def get_thread(self, context: EmailProviderContext, conversation_id: str) -> EmailThread:
        if not conversation_id or len(conversation_id) > 512:
            raise EmailValidationError("Invalid conversation id")
        escaped = conversation_id.replace("'", "''")
        params = {
            "$filter": f"conversationId eq '{escaped}'",
            "$orderby": "receivedDateTime asc",
            "$top": 100,
            "$select": "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,hasAttachments,webLink",
        }
        data = self._get(context, "/me/messages", params)
        messages = tuple(_message(item) for item in data.get("value", []) if isinstance(item, dict))
        return EmailThread(conversation_id=conversation_id, messages=messages)

    def get_message(self, context: EmailProviderContext, message_id: str) -> EmailMessage:
        if not message_id or len(message_id) > 1024:
            raise EmailValidationError("Invalid message id")
        params = {"$select": "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,hasAttachments,webLink,body"}
        safe_message_id = quote(message_id, safe="")
        return _message(self._get(context, f"/me/messages/{safe_message_id}", params))

    def _post(self, context: EmailProviderContext, path: str, json_data: dict[str, Any] | None = None) -> dict[str, Any]:
        token = self._resolve_access_token(context)
        if not token:
            raise EmailProviderError("A delegated Graph access token is required")

        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

        def operation():
            try:
                response = self._client.post(
                    f"{GRAPH_BASE}{path}",
                    json=json_data,
                    headers=headers,
                )
                if response.status_code == 401:
                    fresh = self._resolve_access_token(context, force_refresh=True)
                    if fresh and fresh != token:
                        headers["Authorization"] = f"Bearer {fresh}"
                        response = self._client.post(
                            f"{GRAPH_BASE}{path}",
                            json=json_data,
                            headers=headers,
                        )
                if response.status_code == 202:
                    return {"status": "accepted"}
                return self._handle_response(response)
            except httpx.TimeoutException as exc:
                raise EmailProviderError("Microsoft Graph request timed out") from exc
            except httpx.HTTPError as exc:
                raise EmailProviderError("Microsoft Graph request failed") from exc

        return retry_idempotent(operation, policy=self._retry_policy, retry_if=lambda exc: self._retryable(exc))

    def list_folders(self, context: EmailProviderContext) -> list[EmailFolder]:
        data = self._get(context, "/me/mailFolders", {"$top": 50})
        folders: list[EmailFolder] = []
        for item in data.get("value", []):
            if isinstance(item, dict):
                folders.append(
                    EmailFolder(
                        id=str(item.get("id", "")),
                        name=str(item.get("displayName", "")),
                        total_count=int(item.get("totalItemCount", 0)),
                        unread_count=int(item.get("unreadItemCount", 0)),
                    )
                )
        return folders or [EmailFolder(id="inbox", name="Inbox")]

    def list_messages(
        self,
        context: EmailProviderContext,
        folder_id: str = "inbox",
        limit: int = 25,
        cursor: str | None = None,
    ) -> EmailSearchPage:
        well_known = {"inbox", "sentitems", "drafts", "deleteditems", "junkemail", "archive"}
        path = f"/me/mailFolders/{folder_id}/messages" if folder_id.lower() in well_known else "/me/messages"
        params: dict[str, Any] = {
            "$top": min(limit, 50),
            "$select": "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,hasAttachments,webLink,body",
            "$orderby": "receivedDateTime desc",
        }
        data = self._get(context, path, params)
        messages = tuple(_message(item) for item in data.get("value", []) if isinstance(item, dict))
        next_link = data.get("@odata.nextLink")
        next_cursor = _cursor_encode(next_link) if isinstance(next_link, str) and next_link else None
        return EmailSearchPage(messages=messages, next_cursor=next_cursor)

    def get_attachments(self, context: EmailProviderContext, message_id: str) -> tuple[AttachmentMetadata, ...]:
        safe_id = quote(message_id, safe="")
        data = self._get(context, f"/me/messages/{safe_id}/attachments")
        results: list[AttachmentMetadata] = []
        for a in data.get("value", []):
            if isinstance(a, dict):
                results.append(
                    AttachmentMetadata(
                        id=str(a.get("id", "")),
                        name=str(a.get("name", "")),
                        content_type=a.get("contentType"),
                        size_bytes=a.get("size"),
                        is_inline=bool(a.get("isInline", False)),
                    )
                )
        return tuple(results)

    def download_attachment(
        self, context: EmailProviderContext, message_id: str, attachment_id: str
    ) -> EmailAttachmentContent:
        safe_msg_id = quote(message_id, safe="")
        safe_att_id = quote(attachment_id, safe="")
        data = self._get(context, f"/me/messages/{safe_msg_id}/attachments/{safe_att_id}")
        content_b64 = data.get("contentBytes", "")
        raw_bytes = base64.b64decode(content_b64) if content_b64 else b""
        return EmailAttachmentContent(
            id=attachment_id,
            name=str(data.get("name", "attachment")),
            content_type=data.get("contentType"),
            size_bytes=len(raw_bytes),
            data=raw_bytes,
        )

    def send_email(self, context: EmailProviderContext, request: EmailSendRequest) -> EmailMessage:
        import uuid
        payload = {
            "message": {
                "subject": request.subject,
                "body": {
                    "contentType": "HTML" if request.body_html else "Text",
                    "content": request.body_html or request.body_text,
                },
                "toRecipients": [
                    {"emailAddress": {"address": r.address, "name": r.name or r.address}}
                    for r in request.to_recipients
                ],
                "ccRecipients": [
                    {"emailAddress": {"address": r.address, "name": r.name or r.address}}
                    for r in request.cc_recipients
                ],
                "bccRecipients": [
                    {"emailAddress": {"address": r.address, "name": r.name or r.address}}
                    for r in request.bcc_recipients
                ],
            },
            "saveToSentItems": "true",
        }
        self._post(context, "/me/sendMail", payload)
        sent_id = f"sent-ms-{uuid.uuid4().hex[:8]}"
        return EmailMessage(
            id=sent_id,
            conversation_id=f"thread-{sent_id}",
            subject=request.subject,
            sender=EmailAddress(context.user_id),
            to_recipients=request.to_recipients,
            cc_recipients=request.cc_recipients,
            received_at=None,
            sent_at=datetime.now(timezone.utc),
            body_preview=request.body_text[:200],
            has_attachments=False,
            source="microsoft_graph",
            body_text=request.body_text,
            body_html_sanitized=request.body_html,
            folder="sentitems",
        )

    def reply_email(self, context: EmailProviderContext, request: EmailReplyRequest) -> EmailMessage:
        import uuid
        safe_id = quote(request.message_id, safe="")
        endpoint = f"/me/messages/{safe_id}/replyAll" if request.reply_all else f"/me/messages/{safe_id}/reply"
        self._post(context, endpoint, {"comment": request.body_text})
        sent_id = f"reply-ms-{uuid.uuid4().hex[:8]}"
        return EmailMessage(
            id=sent_id,
            conversation_id=f"thread-{sent_id}",
            subject="Re: Email Reply",
            sender=EmailAddress(context.user_id),
            to_recipients=(),
            cc_recipients=(),
            received_at=None,
            sent_at=datetime.now(timezone.utc),
            body_preview=request.body_text[:200],
            has_attachments=False,
            source="microsoft_graph",
            body_text=request.body_text,
            folder="sentitems",
        )

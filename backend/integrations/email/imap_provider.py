"""Universal IMAP & SMTP Email Provider for enterprise email boxes.

Supports ANY email provider worldwide (Gmail, Google Workspace, Microsoft 365,
Exchange, Yahoo, Zoho, and private corporate domains) via standard IMAP/TLS (993)
and SMTP/SSL (465).
"""
from __future__ import annotations

import email
import imaplib
import logging
import os
import re
import smtplib
import ssl
from datetime import datetime, timezone
from email.header import decode_header
from typing import Any

from .exceptions import EmailAccessDenied, EmailAuthExpired, EmailProviderError, EmailRateLimited
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
from .repository import EmailRepository

logger = logging.getLogger(__name__)

DEFAULT_IMAP_HOSTS = {
    "gmail.com": "imap.gmail.com",
    "googlemail.com": "imap.gmail.com",
    "outlook.com": "outlook.office365.com",
    "hotmail.com": "outlook.office365.com",
    "office365.com": "outlook.office365.com",
    "yahoo.com": "imap.mail.yahoo.com",
    "zoho.com": "imap.zoho.com",
    "icloud.com": "imap.mail.me.com",
}

DEFAULT_SMTP_HOSTS = {
    "gmail.com": "smtp.gmail.com",
    "googlemail.com": "smtp.gmail.com",
    "outlook.com": "smtp.office365.com",
    "hotmail.com": "smtp.office365.com",
    "office365.com": "smtp.office365.com",
    "yahoo.com": "smtp.mail.yahoo.com",
    "zoho.com": "smtp.zoho.com",
    "icloud.com": "smtp.mail.me.com",
}


def _decode_mime_header(header_val: str | None) -> str:
    if not header_val:
        return ""
    decoded_fragments = decode_header(header_val)
    parts = []
    for frag, enc in decoded_fragments:
        if isinstance(frag, bytes):
            try:
                parts.append(frag.decode(enc or "utf-8", errors="replace"))
            except Exception:
                parts.append(frag.decode("latin-1", errors="replace"))
        else:
            parts.append(str(frag))
    return "".join(parts)


def _parse_mime_message(msg_id: str, raw_email: bytes, source: str = "universal_imap") -> EmailMessage:
    parsed = email.message_from_bytes(raw_email)
    subject = _decode_mime_header(parsed.get("Subject", "(No Subject)"))
    sender_raw = _decode_mime_header(parsed.get("From", "Unknown"))
    date_str = parsed.get("Date", "")
    msg_date = datetime.now(timezone.utc)
    if date_str:
        try:
            from email.utils import parsedate_to_datetime
            msg_date = parsedate_to_datetime(date_str)
        except Exception:
            pass

    to_raw = _decode_mime_header(parsed.get("To", ""))
    cc_raw = _decode_mime_header(parsed.get("Cc", ""))

    to_recips = tuple(EmailAddress(r.strip()) for r in to_raw.split(",") if r.strip()) if to_raw else ()
    cc_recips = tuple(EmailAddress(r.strip()) for r in cc_raw.split(",") if r.strip()) if cc_raw else ()

    text_body = ""
    html_body = ""
    attachments: list[AttachmentMetadata] = []

    if parsed.is_multipart():
        for part in parsed.walk():
            fn = part.get_filename()
            if fn:
                att_name = _decode_mime_header(fn)
                content = part.get_payload(decode=True)
                size = len(content) if content else 0
                att_id = f"att-{len(attachments)+1}"
                attachments.append(
                    AttachmentMetadata(
                        id=att_id,
                        name=att_name,
                        content_type=part.get_content_type(),
                        size_bytes=size,
                    )
                )
            else:
                ct = part.get_content_type()
                payload = part.get_payload(decode=True)
                if payload:
                    decoded = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
                    if ct == "text/plain" and not text_body:
                        text_body = decoded
                    elif ct == "text/html" and not html_body:
                        html_body = decoded
    else:
        payload = parsed.get_payload(decode=True)
        if payload:
            decoded = payload.decode(parsed.get_content_charset() or "utf-8", errors="replace")
            if parsed.get_content_type() == "text/html":
                html_body = decoded
            else:
                text_body = decoded

    body_preview = " ".join((text_body or "").split())[:250]

    return EmailMessage(
        id=str(msg_id),
        conversation_id=str(parsed.get("Message-ID") or msg_id),
        subject=subject,
        sender=EmailAddress(sender_raw),
        to_recipients=to_recips,
        cc_recipients=cc_recips,
        received_at=msg_date,
        sent_at=msg_date,
        body_preview=body_preview,
        has_attachments=bool(attachments),
        attachments=tuple(attachments),
        source=source,
        body_text=text_body or None,
        body_html_sanitized=html_body or None,
        folder="inbox",
        message_id_header=parsed.get("Message-ID"),
    )


class ImapEmailProvider(EmailRepository, EmailProvider):
    """Universal IMAP provider connecting securely over TLS (port 993)."""

    def __init__(
        self,
        host: str | None = None,
        port: int = 993,
        smtp_host: str | None = None,
        smtp_port: int = 465,
        account: Any = None,
        credentials: dict[str, Any] | None = None,
    ) -> None:
        self._host = host
        self._port = port
        self._smtp_host = smtp_host
        self._smtp_port = smtp_port
        self._account = account
        self._credentials = credentials or {}

    def _resolve_creds(self, context: EmailProviderContext) -> tuple[str, str, str, str]:
        """Resolves (email, password, imap_host, smtp_host)."""
        email_addr = (
            self._credentials.get("email")
            or (self._account.email_address if self._account else None)
            or (context.user_id if "@" in context.user_id else "")
        )
        pwd = (
            self._credentials.get("password")
            or (self._account.access_token if self._account else None)
            or (context.access_token if context.access_token != "live_auth" else "")
        )
        domain = email_addr.split("@")[-1].lower() if "@" in email_addr else ""
        imap_h = self._credentials.get("imap_host") or self._host or DEFAULT_IMAP_HOSTS.get(domain, f"imap.{domain}")
        smtp_h = self._credentials.get("smtp_host") or self._smtp_host or DEFAULT_SMTP_HOSTS.get(domain, f"smtp.{domain}")
        return email_addr, pwd, imap_h, smtp_h

    def _get_imap_client(self, email_address: str, password_or_token: str, host: str | None = None) -> imaplib.IMAP4_SSL:
        domain = email_address.split("@")[-1].lower() if "@" in email_address else ""
        target_host = host or self._host or DEFAULT_IMAP_HOSTS.get(domain, f"imap.{domain}")
        try:
            client = imaplib.IMAP4_SSL(target_host, self._port, timeout=12.0)
            client.login(email_address, password_or_token)
            return client
        except imaplib.IMAP4.error as exc:
            logger.error("IMAP login failed for '%s' at '%s': %s", email_address, target_host, exc)
            raise EmailAuthExpired(f"IMAP authentication failed for {email_address}: {exc}") from exc
        except Exception as exc:
            logger.error("IMAP connection error for '%s' at '%s': %s", email_address, target_host, exc)
            raise EmailProviderError(f"Could not connect to mailbox via IMAP ({target_host}): {exc}") from exc

    def search_page_with_creds(
        self,
        email_address: str,
        password_or_token: str,
        request: EmailSearchRequest,
        host: str | None = None,
    ) -> EmailSearchPage:
        """Query mailbox via IMAP directly."""
        client = None
        try:
            client = self._get_imap_client(email_address, password_or_token, host)
            client.select("INBOX", readonly=True)

            criteria = []
            if request.query:
                criteria.append(f'TEXT "{request.query}"')
            if request.sender:
                criteria.append(f'FROM "{request.sender}"')
            if request.subject:
                criteria.append(f'SUBJECT "{request.subject}"')

            search_query = " ".join(criteria) if criteria else "ALL"
            typ, data = client.search(None, search_query)
            if typ != "OK":
                return EmailSearchPage(tuple(), next_cursor=None)

            msg_ids = data[0].split()
            msg_ids.reverse()
            limit = min(request.max_results, 25)
            selected_ids = msg_ids[:limit]

            messages: list[EmailMessage] = []
            for m_id in selected_ids:
                try:
                    _, fetch_data = client.fetch(m_id, "(RFC822)")
                    raw_email = None
                    for part in fetch_data:
                        if isinstance(part, tuple):
                            raw_email = part[1]
                            break
                    if raw_email:
                        messages.append(_parse_mime_message(m_id.decode(), raw_email))
                except Exception as parse_exc:
                    logger.debug("Could not parse IMAP message %s: %s", m_id, parse_exc)
                    continue

            return EmailSearchPage(tuple(messages), next_cursor=None)
        finally:
            if client:
                try:
                    client.close()
                    client.logout()
                except Exception:
                    pass

    def search_page(self, context: EmailProviderContext, request: EmailSearchRequest) -> EmailSearchPage:
        email_addr, pwd, imap_h, _ = self._resolve_creds(context)
        if not email_addr or not pwd:
            return EmailSearchPage(tuple(), next_cursor=None)
        return self.search_page_with_creds(email_addr, pwd, request, host=imap_h)

    def search(self, context: EmailProviderContext, request: EmailSearchRequest) -> list[EmailMessage]:
        return list(self.search_page(context, request).messages)

    def get_thread(self, context: EmailProviderContext, conversation_id: str) -> EmailThread:
        msg = self.get_message(context, conversation_id)
        return EmailThread(conversation_id=conversation_id, messages=(msg,))

    def get_message(self, context: EmailProviderContext, message_id: str) -> EmailMessage:
        email_addr, pwd, imap_h, _ = self._resolve_creds(context)
        if not email_addr or not pwd:
            raise EmailProviderError("IMAP credentials not configured for message fetch")
        client = None
        try:
            client = self._get_imap_client(email_addr, pwd, imap_h)
            client.select("INBOX", readonly=True)
            typ, fetch_data = client.fetch(message_id.encode(), "(RFC822)")
            if typ != "OK":
                raise EmailProviderError(f"IMAP message {message_id} fetch failed")
            raw_email = None
            for part in fetch_data:
                if isinstance(part, tuple):
                    raw_email = part[1]
                    break
            if not raw_email:
                raise EmailProviderError(f"IMAP message {message_id} payload empty")
            return _parse_mime_message(message_id, raw_email)
        finally:
            if client:
                try:
                    client.close()
                    client.logout()
                except Exception:
                    pass

    def list_folders(self, context: EmailProviderContext) -> list[EmailFolder]:
        email_addr, pwd, imap_h, _ = self._resolve_creds(context)
        if not email_addr or not pwd:
            return [EmailFolder(id="INBOX", name="Inbox")]
        client = None
        try:
            client = self._get_imap_client(email_addr, pwd, imap_h)
            typ, folder_data = client.list()
            if typ != "OK":
                return [EmailFolder(id="INBOX", name="Inbox")]
            folders: list[EmailFolder] = []
            for item in folder_data:
                if isinstance(item, bytes):
                    line = item.decode("utf-8", errors="replace")
                    match = re.search(r'\((?P<flags>[^)]*)\)\s+"(?P<delim>[^"]+)"\s+(?P<name>.*)', line)
                    if match:
                        f_name = match.group("name").strip().strip('"')
                        folders.append(EmailFolder(id=f_name, name=f_name))
            return folders or [EmailFolder(id="INBOX", name="Inbox")]
        except Exception as exc:
            logger.debug("IMAP list_folders error: %s", exc)
            return [EmailFolder(id="INBOX", name="Inbox")]
        finally:
            if client:
                try:
                    client.logout()
                except Exception:
                    pass

    def list_messages(
        self,
        context: EmailProviderContext,
        folder_id: str = "inbox",
        limit: int = 25,
        cursor: str | None = None,
    ) -> EmailSearchPage:
        return self.search_page(context, EmailSearchRequest(max_results=limit, cursor=cursor))

    def get_attachments(self, context: EmailProviderContext, message_id: str) -> tuple[AttachmentMetadata, ...]:
        msg = self.get_message(context, message_id)
        return msg.attachments

    def download_attachment(
        self, context: EmailProviderContext, message_id: str, attachment_id: str
    ) -> EmailAttachmentContent:
        msg = self.get_message(context, message_id)
        email_addr, pwd, imap_h, _ = self._resolve_creds(context)
        client = self._get_imap_client(email_addr, pwd, imap_h)
        try:
            client.select("INBOX", readonly=True)
            _, fetch_data = client.fetch(message_id.encode(), "(RFC822)")
            raw = None
            for p in fetch_data:
                if isinstance(p, tuple):
                    raw = p[1]
                    break
            if raw:
                parsed = email.message_from_bytes(raw)
                for part in parsed.walk():
                    fn = part.get_filename()
                    if fn:
                        content = part.get_payload(decode=True) or b""
                        return EmailAttachmentContent(
                            id=attachment_id,
                            name=_decode_mime_header(fn),
                            content_type=part.get_content_type(),
                            size_bytes=len(content),
                            data=content,
                        )
            raise EmailProviderError(f"Attachment {attachment_id} not found on IMAP message {message_id}")
        finally:
            try:
                client.logout()
            except Exception:
                pass

    def send_email(self, context: EmailProviderContext, request: EmailSendRequest) -> EmailMessage:
        email_addr, pwd, _, smtp_h = self._resolve_creds(context)
        if not email_addr or not pwd:
            raise EmailProviderError("SMTP credentials not configured to send email")

        import uuid
        msg = email.message.EmailMessage()
        msg["Subject"] = request.subject
        msg["From"] = email_addr
        msg["To"] = ", ".join(r.address for r in request.to_recipients)
        if request.cc_recipients:
            msg["Cc"] = ", ".join(r.address for r in request.cc_recipients)
        if request.bcc_recipients:
            msg["Bcc"] = ", ".join(r.address for r in request.bcc_recipients)
        if request.reply_to:
            msg["Reply-To"] = ", ".join(r.address for r in request.reply_to)
        msg.set_content(request.body_text)
        if request.body_html:
            msg.add_alternative(request.body_html, subtype="html")

        try:
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(smtp_h, self._smtp_port, context=ctx, timeout=12.0) as smtp:
                smtp.login(email_addr, pwd)
                smtp.send_message(msg)
        except Exception as exc:
            logger.error("SMTP sending failed for %s via %s: %s", email_addr, smtp_h, exc)
            raise EmailProviderError(f"SMTP sending failed ({smtp_h}): {exc}") from exc

        sent_id = f"sent-imap-{uuid.uuid4().hex[:8]}"
        return EmailMessage(
            id=sent_id,
            conversation_id=f"thread-{sent_id}",
            subject=request.subject,
            sender=EmailAddress(email_addr),
            to_recipients=request.to_recipients,
            cc_recipients=request.cc_recipients,
            received_at=None,
            sent_at=datetime.now(timezone.utc),
            body_preview=request.body_text[:200],
            has_attachments=False,
            source="universal_imap",
            body_text=request.body_text,
            body_html_sanitized=request.body_html,
            folder="sent",
        )

    def reply_email(self, context: EmailProviderContext, request: EmailReplyRequest) -> EmailMessage:
        orig = self.get_message(context, request.message_id)
        reply_subject = orig.subject if orig.subject.lower().startswith("re:") else f"Re: {orig.subject}"
        to_recips = (orig.sender,) if orig.sender else ()
        send_req = EmailSendRequest(
            to_recipients=to_recips,
            subject=reply_subject,
            body_text=request.body_text,
            body_html=request.body_html,
            cc_recipients=orig.cc_recipients if request.reply_all else (),
            reply_to=(orig.sender,) if orig.sender else (),
        )
        return self.send_email(context, send_req)


_imap_provider: ImapEmailProvider | None = None


def get_imap_email_provider() -> ImapEmailProvider:
    global _imap_provider
    if _imap_provider is None:
        _imap_provider = ImapEmailProvider()
    return _imap_provider

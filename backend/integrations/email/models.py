from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True)
class EmailAddress:
    address: str
    name: str | None = None


@dataclass(frozen=True)
class AttachmentMetadata:
    id: str
    name: str
    content_type: str | None
    size_bytes: int | None
    is_inline: bool = False


@dataclass(frozen=True)
class EmailMessage:
    id: str
    conversation_id: str | None
    subject: str
    sender: EmailAddress | None
    to_recipients: tuple[EmailAddress, ...]
    cc_recipients: tuple[EmailAddress, ...]
    received_at: datetime | None
    sent_at: datetime | None
    body_preview: str | None
    has_attachments: bool
    attachments: tuple[AttachmentMetadata, ...] = ()
    web_link: str | None = None
    source: str = "google_gmail"
    body_text: str | None = None
    body_html_sanitized: str | None = None
    folder: str = "inbox"
    account_id: str | None = None
    account_email: str | None = None
    provider: str | None = None
    message_id_header: str | None = None
    reply_to: tuple[EmailAddress, ...] = ()


@dataclass(frozen=True)
class EmailFolder:
    id: str
    name: str
    total_count: int = 0
    unread_count: int = 0


@dataclass(frozen=True)
class EmailAttachmentContent:
    id: str
    name: str
    content_type: str | None
    size_bytes: int | None
    data: bytes


@dataclass(frozen=True)
class EmailSendRequest:
    to_recipients: tuple[EmailAddress, ...]
    subject: str
    body_text: str
    body_html: str | None = None
    cc_recipients: tuple[EmailAddress, ...] = ()
    bcc_recipients: tuple[EmailAddress, ...] = ()
    reply_to: tuple[EmailAddress, ...] = ()
    account_id: str | None = None


@dataclass(frozen=True)
class EmailReplyRequest:
    message_id: str
    body_text: str
    body_html: str | None = None
    reply_all: bool = False
    account_id: str | None = None


@dataclass(frozen=True)
class EmailThread:
    conversation_id: str
    messages: tuple[EmailMessage, ...]


@dataclass(frozen=True)
class EmailSearchRequest:
    """Bounded mailbox search request.

    ``cursor`` is an opaque provider-issued continuation token. Callers must not
    provide arbitrary Graph URLs; the provider validates and decodes it.
    """
    query: str | None = None
    sender: str | None = None
    recipient: str | None = None
    subject: str | None = None
    after: datetime | None = None
    before: datetime | None = None
    has_attachments: bool | None = None
    max_results: int = 25
    cursor: str | None = None
    folder: str | None = None


@dataclass(frozen=True)
class EmailSearchPage:
    messages: tuple[EmailMessage, ...]
    next_cursor: str | None = None


@dataclass(frozen=True)
class EmailProviderContext:
    """Opaque provider context. Contains no client secret or mailbox password."""
    user_id: str
    tenant_id: str
    access_token: str
    granted_scopes: frozenset[str] = field(default_factory=frozenset)


from .user_account_service import UserEmailAccount  # noqa: E402

from __future__ import annotations
from abc import ABC, abstractmethod
from .exceptions import EmailProviderError
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


class EmailProvider(ABC):
    """Provider-neutral delegated mailbox contract. No credential access is exposed."""

    @abstractmethod
    def search(self, context: EmailProviderContext, request: EmailSearchRequest) -> list[EmailMessage]:
        raise NotImplementedError

    def search_page(self, context: EmailProviderContext, request: EmailSearchRequest) -> EmailSearchPage:
        return EmailSearchPage(tuple(self.search(context, request)), None)

    @abstractmethod
    def get_thread(self, context: EmailProviderContext, conversation_id: str) -> EmailThread:
        raise NotImplementedError

    @abstractmethod
    def get_message(self, context: EmailProviderContext, message_id: str) -> EmailMessage:
        raise NotImplementedError

    def list_folders(self, context: EmailProviderContext) -> list[EmailFolder]:
        return [EmailFolder(id="inbox", name="Inbox")]

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
        raise EmailProviderError("Attachment download not supported by provider")

    def send_email(self, context: EmailProviderContext, request: EmailSendRequest) -> EmailMessage:
        raise EmailProviderError("Email sending not supported by provider")

    def reply_email(self, context: EmailProviderContext, request: EmailReplyRequest) -> EmailMessage:
        raise EmailProviderError("Email reply not supported by provider")

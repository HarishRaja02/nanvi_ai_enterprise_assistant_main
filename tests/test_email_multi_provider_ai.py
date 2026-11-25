"""Tests for multi-provider AI routing, cross-mailbox search, security boundaries, and confirmation flows."""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from backend.agents.email_agent import EmailAgent
from backend.agents.models import AgentRequest, Capability
from backend.integrations.email.exceptions import EmailAuthExpired
from backend.integrations.email.models import (
    EmailAddress,
    EmailMessage,
    EmailReplyRequest,
    EmailSearchPage,
    EmailSearchRequest,
    EmailSendRequest,
)
from backend.integrations.email.unified_resolver import (
    MultiProviderEmailService,
    UnifiedEmailMailbox,
    UnifiedEmailResolver,
)
from backend.security.authorization import UserAttributes
from backend.security.authorization.rbac import Role


@pytest.fixture
def mock_user() -> UserAttributes:
    return UserAttributes(
        user_id="user-ai-01",
        tenant_id="tenant-ai-corp",
        department="Engineering",
        roles=frozenset({Role.EMPLOYEE}),
    )


@pytest.fixture
def other_user() -> UserAttributes:
    return UserAttributes(
        user_id="user-ai-02",
        tenant_id="tenant-other-corp",
        department="Finance",
        roles=frozenset({Role.EMPLOYEE}),
    )


def test_cross_provider_search_aggregates_gmail_outlook_yahoo(mock_user):
    """UnifiedEmailResolver aggregates results across Gmail, Outlook, and Yahoo with badges."""
    now = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
    earlier = datetime(2026, 10, 15, 10, 0, tzinfo=timezone.utc)
    earliest = datetime(2026, 10, 14, 9, 0, tzinfo=timezone.utc)

    # Gmail message
    gmail_msg = EmailMessage(
        id="gmail-101",
        conversation_id="conv-1",
        subject="Project Alpha Deployment",
        sender=EmailAddress("lead@google.com", "Google Lead"),
        to_recipients=(EmailAddress("user@nanvi.com", "Me"),),
        cc_recipients=(),
        received_at=now,
        sent_at=now,
        body_preview="Alpha deployment succeeded.",
        has_attachments=False,
    )
    # Outlook message
    outlook_msg = EmailMessage(
        id="outlook-202",
        conversation_id="conv-2",
        subject="Quarterly Financial Sync",
        sender=EmailAddress("cfo@partner.com", "Partner CFO"),
        to_recipients=(EmailAddress("user@nanvi.com", "Me"),),
        cc_recipients=(),
        received_at=earlier,
        sent_at=earlier,
        body_preview="Sync scheduled for Friday.",
        has_attachments=False,
    )
    # Yahoo message
    yahoo_msg = EmailMessage(
        id="yahoo-303",
        conversation_id="conv-3",
        subject="Vendor Contract Signed",
        sender=EmailAddress("vendor@yahoo.com", "Vendor Rep"),
        to_recipients=(EmailAddress("user@nanvi.com", "Me"),),
        cc_recipients=(),
        received_at=earliest,
        sent_at=earliest,
        body_preview="Contract copy attached.",
        has_attachments=False,
    )

    client_gmail = MagicMock()
    client_gmail.search.return_value = [gmail_msg]
    client_gmail.search_page.return_value = EmailSearchPage(messages=(gmail_msg,), next_cursor=None)
    client_outlook = MagicMock()
    client_outlook.search.return_value = [outlook_msg]
    client_outlook.search_page.return_value = EmailSearchPage(messages=(outlook_msg,), next_cursor=None)
    client_yahoo = MagicMock()
    client_yahoo.search.return_value = [yahoo_msg]
    client_yahoo.search_page.return_value = EmailSearchPage(messages=(yahoo_msg,), next_cursor=None)

    mb_gmail = UnifiedEmailMailbox(
        account_id="acc-gmail-1",
        user_id=mock_user.user_id,
        tenant_id=mock_user.tenant_id,
        provider="google",
        email_address="user@gmail.com",
        display_name="Work Gmail",
        client=client_gmail,
        scopes=frozenset({"gmail.readonly", "email"}),
    )
    mb_outlook = UnifiedEmailMailbox(
        account_id="acc-outlook-2",
        user_id=mock_user.user_id,
        tenant_id=mock_user.tenant_id,
        provider="microsoft365",
        email_address="user@outlook.com",
        display_name="Corporate Outlook",
        client=client_outlook,
        scopes=frozenset({"Mail.Read", "email"}),
    )
    mb_yahoo = UnifiedEmailMailbox(
        account_id="acc-yahoo-3",
        user_id=mock_user.user_id,
        tenant_id=mock_user.tenant_id,
        provider="yahoo",
        email_address="user@yahoo.com",
        display_name="Secondary Yahoo",
        client=client_yahoo,
        scopes=frozenset({"mail-read", "email"}),
    )

    resolver = MagicMock(spec=UnifiedEmailResolver)
    resolver.discover_mailboxes.return_value = [mb_gmail, mb_outlook, mb_yahoo]

    auth = MagicMock()
    auth.has_permission.return_value = True
    auth.authorize.return_value = MagicMock(allowed=True)
    audit = MagicMock()
    multi_service = MultiProviderEmailService(resolver=resolver, authorization=auth, audit_logger=audit)

    agent = EmailAgent(email_service=multi_service)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(UnifiedEmailResolver, "discover_mailboxes", lambda s, u, t: [mb_gmail, mb_outlook, mb_yahoo])

        req = AgentRequest(request_id="req-cross", user=mock_user, query="show all my recent emails")
        resp = agent.run(req)

        assert resp.data_source == "live"
        assert "[Gmail] Project Alpha Deployment" in resp.content
        assert "[Outlook] Quarterly Financial Sync" in resp.content
        assert "[Yahoo] Vendor Contract Signed" in resp.content

        sources = {s.display_name for s in resp.sources}
        assert "[Gmail] Project Alpha Deployment" in sources
        assert "[Outlook] Quarterly Financial Sync" in sources
        assert "[Yahoo] Vendor Contract Signed" in sources


def test_targeted_provider_hint_routes_to_specific_mailbox(mock_user):
    """Specifying 'outlook' in user query restricts search to Microsoft 365 / Outlook only."""
    client_gmail = MagicMock()
    client_outlook = MagicMock()

    mb_gmail = UnifiedEmailMailbox(
        account_id="acc-gmail-1",
        user_id=mock_user.user_id,
        tenant_id=mock_user.tenant_id,
        provider="google",
        email_address="user@gmail.com",
        display_name="Work Gmail",
        client=client_gmail,
    )
    mb_outlook = UnifiedEmailMailbox(
        account_id="acc-outlook-2",
        user_id=mock_user.user_id,
        tenant_id=mock_user.tenant_id,
        provider="microsoft365",
        email_address="user@outlook.com",
        display_name="Corporate Outlook",
        client=client_outlook,
        scopes=frozenset({"Mail.Read", "email"}),
    )

    out_msg = EmailMessage(
        id="out-1",
        conversation_id="c-1",
        subject="Executive Review",
        sender=EmailAddress("boss@company.com", "CEO"),
        to_recipients=(),
        cc_recipients=(),
        received_at=datetime.now(timezone.utc),
        sent_at=datetime.now(timezone.utc),
        body_preview="Review draft.",
        has_attachments=False,
    )
    client_outlook.search.return_value = [out_msg]
    client_outlook.search_page.return_value = EmailSearchPage(messages=(out_msg,), next_cursor=None)

    resolver = MagicMock(spec=UnifiedEmailResolver)
    resolver.discover_mailboxes.return_value = [mb_gmail, mb_outlook]

    auth = MagicMock()
    auth.has_permission.return_value = True
    auth.authorize.return_value = MagicMock(allowed=True)
    audit = MagicMock()
    multi_service = MultiProviderEmailService(resolver=resolver, authorization=auth, audit_logger=audit)
    agent = EmailAgent(email_service=multi_service)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(UnifiedEmailResolver, "discover_mailboxes", lambda s, u, t: [mb_gmail, mb_outlook])

        req = AgentRequest(request_id="req-target", user=mock_user, query="check my outlook emails for review")
        resp = agent.run(req)

        assert "[Outlook] Executive Review" in resp.content
        client_gmail.search.assert_not_called()


def test_draft_reply_never_auto_sends_without_confirmation(mock_user):
    """EmailAgent preparing a reply outputs a draft preview and strictly enforces confirmation."""
    mock_email_service = MagicMock()
    agent = EmailAgent(email_service=mock_email_service)

    req = AgentRequest(
        request_id="req-draft",
        user=mock_user,
        query="draft a reply to Sarah saying I will attend the sync tomorrow",
    )
    resp = agent.run(req)

    assert "Prepared Draft Reply" in resp.content
    assert "Sarah" in resp.content
    assert "I will attend the sync tomorrow" in resp.content
    assert "confirmation" in resp.content.lower()

    # Outbound send/reply must NEVER be called automatically
    mock_email_service.send_email.assert_not_called()
    mock_email_service.reply_email.assert_not_called()


def test_expired_auth_returns_clear_reconnect_guidance(mock_user):
    """When a mailbox authorization has expired, fail-closed with reconnect guidance."""
    mock_email_service = MagicMock()
    mock_email_service.search_all.side_effect = EmailAuthExpired("Token expired")
    agent = EmailAgent(email_service=mock_email_service)

    mb = UnifiedEmailMailbox(
        account_id="acc-exp-1",
        user_id=mock_user.user_id,
        tenant_id=mock_user.tenant_id,
        provider="google",
        email_address="user@gmail.com",
        display_name="Work Gmail",
        client=MagicMock(),
    )

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(UnifiedEmailResolver, "discover_mailboxes", lambda s, u, t: [mb])

        req = AgentRequest(request_id="req-exp", user=mock_user, query="check my recent emails")
        resp = agent.run(req)

        assert "expired or requires reauthorization" in resp.content
        assert "Settings → Connections" in resp.content
        assert resp.data_source == "live"


def test_multi_provider_tenant_isolation(mock_user, other_user, tmp_path):
    """Tenant isolation ensures a user cannot discover or search another tenant's mailboxes."""
    from backend.integrations.email.user_account_service import UserEmailAccountService, UserEmailAccount

    uas = UserEmailAccountService(storage_path=tmp_path / "accounts.json")
    acc1 = UserEmailAccount(
        id="acc-t1",
        user_id=mock_user.user_id,
        tenant_id=mock_user.tenant_id,
        provider="google",
        email_address="user1@tenant1.com",
        access_token="tok1",
    )
    acc2 = UserEmailAccount(
        id="acc-t2",
        user_id=other_user.user_id,
        tenant_id=other_user.tenant_id,
        provider="microsoft365",
        email_address="user2@tenant2.com",
        access_token="tok2",
    )

    uas.save_account(acc1)
    uas.save_account(acc2)

    resolver = UnifiedEmailResolver(account_service=uas, connection_manager=None)

    # User 1 should only see tenant 1 mailbox
    mbs_u1 = resolver.discover_mailboxes(mock_user.user_id, mock_user.tenant_id)
    assert len(mbs_u1) == 1
    assert mbs_u1[0].email_address == "user1@tenant1.com"

    # User 2 should only see tenant 2 mailbox
    mbs_u2 = resolver.discover_mailboxes(other_user.user_id, other_user.tenant_id)
    assert len(mbs_u2) == 1
    assert mbs_u2[0].email_address == "user2@tenant2.com"


def test_auto_link_yahoo_and_outlook_from_settings(mock_user, tmp_path, monkeypatch):
    """When Yahoo or Outlook credentials exist in server settings, /status auto-links them."""
    import dataclasses
    from backend.api.email_routes import get_mailbox_status
    from backend.core.config import settings
    from backend.integrations.email.user_account_service import UserEmailAccountService
    from backend.security.models import UserIdentity

    uas = UserEmailAccountService(storage_path=tmp_path / "accounts_autolink.json")
    monkeypatch.setattr("backend.api.email_routes.get_user_email_account_service", lambda: uas)

    patched_settings = dataclasses.replace(
        settings,
        yahoo_email="auto-user@yahoo.com",
        yahoo_app_password="abcd efgh ijkl mnop",
        outlook_email="auto-user@outlook.com",
        outlook_password="outlook-secret-pwd",
    )
    monkeypatch.setattr("backend.core.config.settings", patched_settings)

    user_ident = UserIdentity(
        subject=mock_user.user_id,
        issuer="internal",
        tenant_id=mock_user.tenant_id,
        roles=frozenset({"Employee"}),
    )

    status = get_mailbox_status(user=user_ident)
    assert status["connected"] is True
    providers = [a["provider"] for a in status["accounts"]]
    assert "yahoo" in providers
    assert "outlook" in providers
    assert status["has_yahoo_fallback"] is True
    assert status["has_microsoft_fallback"] is True


def test_build_client_binds_credentials_for_yahoo_and_outlook(tmp_path):
    """UnifiedEmailResolver instantiates ImapEmailProvider with credentials bound for Yahoo and Outlook."""
    from backend.integrations.email.imap_provider import ImapEmailProvider
    from backend.integrations.email.user_account_service import UserEmailAccount, UserEmailAccountService

    uas = UserEmailAccountService(storage_path=tmp_path / "accounts_build.json")
    y_acc = UserEmailAccount(
        id="acc-y1",
        user_id="u1",
        tenant_id="t1",
        provider="yahoo",
        email_address="user@yahoo.com",
        access_token="16charapppwd",
    )
    o_acc = UserEmailAccount(
        id="acc-o1",
        user_id="u1",
        tenant_id="t1",
        provider="outlook",
        email_address="user@outlook.com",
        access_token="outlookpwd",
    )

    resolver = UnifiedEmailResolver(account_service=uas)
    y_client = resolver._build_client_for_account(y_acc, "t1")
    assert isinstance(y_client, ImapEmailProvider)
    assert y_client._credentials["email"] == "user@yahoo.com"
    assert y_client._credentials["password"] == "16charapppwd"
    assert y_client._credentials["imap_host"] == "imap.mail.yahoo.com"

    o_client = resolver._build_client_for_account(o_acc, "t1")
    assert isinstance(o_client, ImapEmailProvider)
    assert o_client._credentials["email"] == "user@outlook.com"
    assert o_client._credentials["password"] == "outlookpwd"
    assert o_client._credentials["imap_host"] == "outlook.office365.com"

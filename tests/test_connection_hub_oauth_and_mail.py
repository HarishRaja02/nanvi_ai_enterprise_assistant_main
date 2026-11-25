"""Verification tests for Connection Hub OAuth redirects (Google, MS365, Outlook, Dropbox, Supabase)
and live Gmail + Microsoft Graph email data delivery."""
from __future__ import annotations

import dataclasses
from datetime import datetime, timezone
from unittest.mock import MagicMock
import urllib.parse

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

import backend.connections.oauth_routes as oauth_routes_mod
import backend.core.config as config_mod
from backend.agents.email_agent import EmailAgent
from backend.agents.models import AgentRequest, Capability
from backend.chat.service import ChatService, DeterministicTestAnswerer, InMemoryConversationStore
from backend.connections.base import AuthType
from backend.connections.encryption import CredentialEncryptionService
from backend.connections.manager import ConnectionManager
from backend.connections.providers.cloud_storage import DropboxProvider
from backend.connections.providers.supabase import SupabaseProvider
from backend.connections.registry import get_provider_registry
from backend.integrations.email.gmail import GmailEmailProvider
from backend.integrations.email.graph import MicrosoftGraphEmailProvider
from backend.integrations.email.models import (
    EmailAddress,
    EmailMessage,
    EmailProviderContext,
    EmailSearchRequest,
    EmailSendRequest,
)
from backend.integrations.email.unified_resolver import (
    MultiProviderEmailService,
    UnifiedEmailMailbox,
    UnifiedEmailResolver,
)
from backend.main import app
from backend.security.audit import AuditLogger, InMemoryAuditSink
from backend.security.authorization import AuthorizationService, UserAttributes
from backend.security.authorization.rbac import Role
from backend.security.dependencies import get_current_user, get_optional_current_user
from backend.security.models import UserIdentity


def _patch_settings(monkeypatch: pytest.MonkeyPatch, **kwargs):
    new_settings = dataclasses.replace(config_mod.settings, **kwargs)
    monkeypatch.setattr(config_mod, "settings", new_settings)
    for mod in (oauth_routes_mod,):
        if hasattr(mod, "settings"):
            monkeypatch.setattr(mod, "settings", new_settings)
    return new_settings


@pytest.fixture
def test_user() -> UserIdentity:
    return UserIdentity(
        subject="oauth-verify-user",
        issuer="test",
        email="verify@nanvi.local",
        name="Verify User",
        tenant_id="enterprise-tenant",
        department="Engineering",
        roles=frozenset({Role.EMPLOYEE, Role.IT_ADMIN}),
    )


def test_google_connection_hub_callback_not_hijacked_by_frontend_redirect_uri(monkeypatch, test_user):
    _patch_settings(
        monkeypatch,
        google_client_id="gid-123",
        google_client_secret="gsec-123",
        google_redirect_uri="http://localhost:5173",
    )
    app.dependency_overrides[get_current_user] = lambda: test_user
    try:
        client = TestClient(app)
        resp = client.get(
            "/api/connections/oauth/google/authorize?redirect_after=http://127.0.0.1:5173/oauth-complete",
            headers={"Host": "nanviaienterpriseassistant.vercel.app", "X-Forwarded-Proto": "https"},
        )
        assert resp.status_code == 200
        auth_url = resp.json()["authorization_url"]
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(auth_url).query)
        assert qs["redirect_uri"][0] == "https://nanviaienterpriseassistant.vercel.app/api/connections/oauth/google/callback"
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_desktop_redirect_after_loopback_allowed_and_untrusted_blocked(monkeypatch, test_user):
    _patch_settings(
        monkeypatch,
        microsoft_client_id="ms-cid",
        microsoft_client_secret="ms-csec",
    )
    cm = oauth_routes_mod.get_connection_manager()
    ms_prov = cm._registry.get_provider("microsoft365")
    orig_handle = ms_prov.handle_callback
    app.dependency_overrides[get_current_user] = lambda: test_user
    app.dependency_overrides[get_optional_current_user] = lambda: test_user
    try:
        client = TestClient(app)
        # 1. Valid desktop loopback redirect_after
        resp = client.get(
            "/api/connections/oauth/microsoft365/authorize?redirect_after=http://127.0.0.1:5173/oauth-complete",
            headers={"Host": "nanviaienterpriseassistant.vercel.app", "X-Forwarded-Proto": "https"},
        )
        assert resp.status_code == 200
        state = urllib.parse.parse_qs(urllib.parse.urlparse(resp.json()["authorization_url"]).query)["state"][0]

        ms_prov.handle_callback = lambda **kwargs: {
            "account_identifier": "verify@outlook.com",
            "display_name": "Microsoft 365 (verify@outlook.com)",
            "credentials": {
                "access_token": "ms-access-xyz",
                "refresh_token": "ms-refresh-xyz",
                "token_expires_at": 9999999999.0,
            },
            "metadata_safe": {"email": "verify@outlook.com", "name": "Verify User"},
            "granted_scopes": ["Mail.Read", "Files.Read.All"],
        }
        cb = client.get(
            f"/api/connections/oauth/microsoft365/callback?code=ms-code-1&state={state}",
            headers={"Host": "nanviaienterpriseassistant.vercel.app", "X-Forwarded-Proto": "https"},
            follow_redirects=False,
        )
        assert cb.status_code in (302, 307)
        loc = cb.headers["location"]
        assert loc.startswith("http://127.0.0.1:5173/oauth-complete")
        assert "connected=microsoft365&status=success" in loc

        # 2. Verify malicious redirect_after is stripped in favor of safe app host
        resp_evil = client.get(
            "/api/connections/oauth/microsoft365/authorize?redirect_after=https://evil.example/steal",
            headers={"Host": "nanviaienterpriseassistant.vercel.app", "X-Forwarded-Proto": "https"},
        )
        state_evil = urllib.parse.parse_qs(urllib.parse.urlparse(resp_evil.json()["authorization_url"]).query)["state"][0]
        cb_evil = client.get(
            f"/api/connections/oauth/microsoft365/callback?code=ms-code-2&state={state_evil}",
            headers={"Host": "nanviaienterpriseassistant.vercel.app", "X-Forwarded-Proto": "https"},
            follow_redirects=False,
        )
        assert cb_evil.status_code in (302, 307)
        assert cb_evil.headers["location"].startswith("https://nanviaienterpriseassistant.vercel.app/?tab=connections")
    finally:
        ms_prov.handle_callback = orig_handle
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_optional_current_user, None)


def test_dropbox_oauth_flow_pkce_refresh_and_file_search(monkeypatch):
    # Unconfigured -> setup required
    _patch_settings(monkeypatch, dropbox_client_id="", dropbox_client_secret="")
    meta_unconf = DropboxProvider().get_metadata()
    assert meta_unconf.auth_type == AuthType.OAUTH2
    assert meta_unconf.available is False
    assert meta_unconf.available_reason == "not_configured"

    # Configured -> full OAuth2 + PKCE + offline refresh + file search
    _patch_settings(monkeypatch, dropbox_client_id="dbx-key", dropbox_client_secret="dbx-sec")
    mock_http = MagicMock(spec=httpx.Client)
    tok_resp = MagicMock(status_code=200)
    tok_resp.json.return_value = {
        "access_token": "dbx-access-1",
        "refresh_token": "dbx-refresh-1",
        "expires_in": 14400,
        "scope": "files.metadata.read files.content.read",
    }
    me_resp = MagicMock(status_code=200)
    me_resp.json.return_value = {"email": "team@company.com", "name": {"display_name": "Team Dropbox"}, "account_id": "dbid:123"}
    search_resp = MagicMock(status_code=200)
    search_resp.json.return_value = {
        "matches": [
            {"metadata": {"metadata": {".tag": "file", "id": "id:1", "name": "Q1_Invoice.pdf", "path_display": "/Finance/Q1_Invoice.pdf", "size": 2048}}}
        ]
    }
    mock_http.post.side_effect = [tok_resp, me_resp, search_resp]

    prov = DropboxProvider(http_client=mock_http)
    meta = prov.get_metadata()
    assert meta.available is True
    assert meta.auth_type == AuthType.OAUTH2

    auth_url = prov.get_authorization_url(
        user_id="u1",
        tenant_id="t1",
        redirect_uri="https://app.example.com/api/connections/oauth/dropbox/callback",
        state="st-1",
        pkce_verifier="verifier_0123456789abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    )
    parsed = urllib.parse.urlparse(auth_url)
    qs = urllib.parse.parse_qs(parsed.query)
    assert parsed.netloc == "www.dropbox.com"
    assert qs["token_access_type"][0] == "offline"
    assert qs["code_challenge_method"][0] == "S256"

    cb_res = prov.handle_callback(
        code="dbx-code",
        state="st-1",
        redirect_uri="https://app.example.com/api/connections/oauth/dropbox/callback",
        pkce_verifier="verifier_0123456789abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    )
    assert cb_res["account_identifier"] == "team@company.com"
    assert cb_res["credentials"]["refresh_token"] == "dbx-refresh-1"

    client = prov.get_client(decrypted_credentials=cb_res["credentials"], metadata_safe=cb_res["metadata_safe"])
    hits = client.search_files("Invoice")
    assert len(hits) == 1
    assert hits[0]["name"] == "Q1_Invoice.pdf"


def test_supabase_oauth_optional_flow(monkeypatch):
    _patch_settings(monkeypatch, supabase_oauth_client_id="", supabase_oauth_client_secret="")
    assert SupabaseProvider().get_metadata().auth_type == AuthType.API_KEY

    _patch_settings(monkeypatch, supabase_oauth_client_id="sb-cid", supabase_oauth_client_secret="sb-csec")
    mock_http = MagicMock(spec=httpx.Client)
    tok_resp = MagicMock(status_code=200)
    tok_resp.json.return_value = {"access_token": "sbp_oauth_tok", "refresh_token": "sbp_ref", "expires_in": 3600}
    proj_resp = MagicMock(status_code=200)
    proj_resp.json.return_value = [{"id": "abcdefproj", "name": "ProdDB"}]
    keys_resp = MagicMock(status_code=200)
    keys_resp.json.return_value = [{"name": "service_role", "api_key": "sb_secret_discovered"}]
    mock_http.post.return_value = tok_resp
    mock_http.get.side_effect = [proj_resp, keys_resp]

    sb = SupabaseProvider(http_client=mock_http)
    assert sb.get_metadata().auth_type == AuthType.OAUTH2
    auth_url = sb.get_authorization_url(
        user_id="u1",
        tenant_id="t1",
        redirect_uri="https://app.example.com/api/connections/oauth/supabase/callback",
        state="s2",
        pkce_verifier="verifier_0123456789abcdefghijklmnopqrstuvwxyz",
    )
    assert "api.supabase.com/v1/oauth/authorize" in auth_url

    cb = sb.handle_callback(code="sb-code", state="s2", redirect_uri="https://app.example.com/api/connections/oauth/supabase/callback")
    assert cb["account_identifier"] == "abcdefproj"
    assert cb["credentials"]["supabase_url"] == "https://abcdefproj.supabase.co"
    assert cb["credentials"]["supabase_key"] == "sb_secret_discovered"


def test_graph_display_name_sender_search_omits_orderby_and_post_resolves_token():
    captured: list[tuple[str, dict | None]] = []
    req = httpx.Request("GET", "https://graph.microsoft.com/v1.0/me/messages")
    resp = httpx.Response(
        200,
        request=req,
        json={
            "value": [
                {
                    "id": "ms-1",
                    "conversationId": "conv-1",
                    "subject": "Q1 Budget Review",
                    "from": {"emailAddress": {"name": "Arjun Mehta", "address": "arjun@company.com"}},
                    "toRecipients": [],
                    "ccRecipients": [],
                    "receivedDateTime": "2026-11-18T09:00:00Z",
                    "bodyPreview": "Approved",
                    "body": {"contentType": "text", "content": "Approved the Q1 budget of 12 lakhs."},
                    "hasAttachments": False,
                }
            ]
        },
    )
    post_resp = httpx.Response(202, request=httpx.Request("POST", "https://graph.microsoft.com/v1.0/me/sendMail"))

    class MockClient:
        def get(self, url, params=None, headers=None):
            captured.append((url, dict(params or {})))
            return resp

        def post(self, url, json=None, headers=None):
            captured.append((url, headers))
            return post_resp

    provider = MicrosoftGraphEmailProvider(http_client=MockClient())
    provider._access_token = "resolved-ms-token"
    ctx = EmailProviderContext("u1", "t1", "live_auth", frozenset({"Mail.Read", "Mail.Send"}))

    # Display name sender ("Arjun", no @) should use KQL $search without $orderby or $filter
    msgs = provider.search(ctx, EmailSearchRequest(sender="Arjun", query="budget"))
    assert len(msgs) == 1
    assert "12 lakhs" in (msgs[0].body_text or "")
    _, sent_params = captured[0]
    assert "$orderby" not in sent_params
    assert "$filter" not in sent_params
    assert "from:Arjun" in sent_params["$search"]

    # Send email resolves _access_token cleanly when ctx.access_token == "live_auth"
    provider.send_email(
        ctx,
        EmailSendRequest(to_recipients=(EmailAddress("dest@company.com"),), subject="Hi", body_text="Hello"),
    )
    assert captured[1][1]["Authorization"] == "Bearer resolved-ms-token"


def test_gmail_live_search_applies_filters_and_extracts_body_text():
    import base64

    captured_urls: list[str] = []
    b64_body = base64.urlsafe_b64encode(b"Invoice #INV-99 is overdue by 14 days.").decode("ascii")

    class MockGmailClient:
        def get(self, url, headers=None):
            captured_urls.append(url)
            req = httpx.Request("GET", url)
            if "/messages?" in url:
                return httpx.Response(200, request=req, json={"messages": [{"id": "gm-1"}]})
            return httpx.Response(
                200,
                request=req,
                json={
                    "id": "gm-1",
                    "threadId": "th-1",
                    "snippet": "Invoice #INV-99...",
                    "payload": {
                        "headers": [
                            {"name": "Subject", "value": "Overdue Notice"},
                            {"name": "From", "value": "billing@acme.com"},
                            {"name": "To", "value": "ceo@nanvi.local"},
                        ],
                        "mimeType": "text/plain",
                        "body": {"data": b64_body},
                    },
                },
            )

    gmail = GmailEmailProvider(http_client=MockGmailClient())
    ctx = EmailProviderContext("u1", "t1", "ya29.valid-test-token", frozenset({"gmail.readonly"}))
    msgs = gmail.search(
        ctx,
        EmailSearchRequest(query="invoice", sender="billing@acme.com", has_attachments=True),
    )
    assert len(msgs) == 1
    assert "overdue by 14 days" in (msgs[0].body_text or "")
    assert "from%3Abilling%40acme.com" in captured_urls[0]
    assert "has%3Aattachment" in captured_urls[0]


def test_chat_service_preserves_outlook_topic_search_and_honest_date_zero_match(monkeypatch):
    from backend.integrations.email.models import EmailSearchPage
    outlook_client = MagicMock()
    inv_msg = EmailMessage(
        id="ms-inv-1",
        conversation_id="conv-inv",
        subject="Overdue Invoice #882",
        sender=EmailAddress("arjun@partner.com", "Arjun"),
        to_recipients=(EmailAddress("user@company.com"),),
        cc_recipients=(),
        received_at=datetime(2026, 11, 18, 10, 0, tzinfo=timezone.utc),
        sent_at=datetime(2026, 11, 18, 10, 0, tzinfo=timezone.utc),
        body_preview="Please settle overdue invoice #882.",
        has_attachments=False,
        body_text="Full body: Overdue invoice #882 for $14,500 due Nov 10.",
        source="microsoft_graph",
        provider="outlook",
    )
    outlook_client.search.return_value = [inv_msg]
    outlook_client.search_page.return_value = EmailSearchPage(messages=(inv_msg,), next_cursor=None)

    mb = UnifiedEmailMailbox(
        account_id="acc-ms-1",
        user_id="test-u1",
        tenant_id="enterprise-tenant",
        provider="outlook",
        email_address="user@company.com",
        display_name="Outlook",
        client=outlook_client,
        scopes=frozenset({"Mail.Read", "Mail.Send"}),
    )
    monkeypatch.setattr(UnifiedEmailResolver, "discover_mailboxes", lambda self, u, t="enterprise-tenant": [mb])

    user = UserAttributes(user_id="test-u1", tenant_id="enterprise-tenant", department="Finance", roles=frozenset({Role.CEO}))
    svc = ChatService(orchestrator=MagicMock(), answerer=DeterministicTestAnswerer(), store=InMemoryConversationStore())

    # 1. Preserves topic keyword ("overdue invoice") when checking Outlook
    ans, _, _ = svc._handle_direct_email_query(user, "find overdue invoice emails in my outlook")
    sent_req = outlook_client.search.call_args[0][1]
    assert "overdue invoice" in sent_req.query.lower()
    assert "Overdue Invoice #882" in ans

    # 2. Honest zero-match for non-matching date (does NOT fall back to unrelated date)
    ans_date, _, _ = svc._handle_direct_email_query(user, "check my outlook emails on Nov 1")
    assert "No emails received on" in ans_date
    assert "Overdue Invoice #882" not in ans_date

    # 3. Outlook query with local_context routes to Capability.EMAIL too
    caps = svc._capabilities_for_query("summarize the budget email from Sarah in outlook", has_local_context=True)
    assert Capability.EMAIL in caps

    # 4. EmailAgent strips conversational noise words and exposes full body_text content
    agent = EmailAgent(email_service=MultiProviderEmailService(resolver=UnifiedEmailResolver(), authorization=AuthorizationService(), audit_logger=AuditLogger(InMemoryAuditSink())))
    agent_res = agent.run(AgentRequest("req-1", user, "what did Arjun say in outlook about the overdue invoice?"))
    assert "Overdue invoice #882 for $14,500 due Nov 10." in agent_res.content


def test_space_separated_and_graph_url_scopes_are_authorized():
    from backend.integrations.email.service import EmailService, ProviderEmailRepository
    from backend.integrations.email.models import EmailSearchPage
    from backend.integrations.email.user_account_service import UserEmailAccount

    class StubProvider:
        def search_page(self, context, request):
            return EmailSearchPage(messages=(), next_cursor=None)
        def get_thread(self, context, cid): raise NotImplementedError
        def get_message(self, context, mid): raise NotImplementedError

    acc = UserEmailAccount(
        id="acc-space-1",
        user_id="u-space",
        email_address="u@outlook.com",
        provider="microsoft365",
        access_token="tok-1",
        scopes="offline_access User.Read https://graph.microsoft.com/Mail.Read",
    )
    mock_svc = MagicMock()
    mock_svc.get_accounts.return_value = [acc]
    resolver = UnifiedEmailResolver(account_service=mock_svc, connection_manager=MagicMock())
    mbs = resolver.discover_mailboxes("u-space", "t-space")
    assert len(mbs) == 1
    assert "https://graph.microsoft.com/Mail.Read" in mbs[0].scopes

    email_svc = EmailService(
        repository=ProviderEmailRepository(StubProvider()),
        authorization=AuthorizationService(),
        audit_logger=AuditLogger(InMemoryAuditSink()),
    )
    u = UserAttributes(user_id="u-space", tenant_id="t-space", department="Eng", roles=frozenset({Role.EMPLOYEE}))
    assert email_svc.search(u, mbs[0].make_context(), EmailSearchRequest(query="hello")) == []



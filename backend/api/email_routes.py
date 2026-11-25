"""Email Integration API routes for multi-user mailbox authorization and Google/Microsoft/Yahoo/IMAP support.

Provides endpoints for initiating Google & Microsoft OAuth, exchanging authorization codes,
connecting Yahoo/IMAP mailboxes, managing accounts, checking status, browsing folders,
reading messages, and sending/replying to emails with zero-trust confirmation checks.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from backend.integrations.email.models import (
    EmailAddress,
    EmailMessage,
    EmailReplyRequest,
    EmailSearchRequest,
    EmailSendRequest,
)
from backend.integrations.email.oauth import get_google_oauth_service
from backend.integrations.email.user_account_service import (
    UserEmailAccount,
    get_user_email_account_service,
)
from backend.observability.logging import log_event
from backend.security.dependencies import get_current_user
from backend.security.models import UserIdentity
from backend.uecp import require_uecp_access

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/email", tags=["email"])


# ─── Pydantic Request Models ───────────────────────────────────────────────

class OAuthCallbackRequest(BaseModel):
    code: str = Field(min_length=1)
    state: str | None = None
    redirect_uri: str | None = None


class ManualConnectRequest(BaseModel):
    email_address: str = Field(min_length=3, max_length=255)
    display_name: str | None = None
    refresh_token: str | None = None
    access_token: str | None = None
    provider: str = "google"


class DisconnectRequest(BaseModel):
    account_id: str | None = None


class YahooConnectRequest(BaseModel):
    email_address: str = Field(min_length=3, max_length=255)
    app_password: str = Field(min_length=4, max_length=128)
    display_name: str | None = None


class OutlookConnectRequest(BaseModel):
    email_address: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=4, max_length=128)
    display_name: str | None = None


class SendEmailApiRequest(BaseModel):
    to: list[str] = Field(min_items=1)
    subject: str = Field(min_length=1, max_length=500)
    body_text: str
    body_html: str | None = None
    cc: list[str] = Field(default_factory=list)
    bcc: list[str] = Field(default_factory=list)
    reply_to: list[str] = Field(default_factory=list)
    account_id: str | None = None
    confirmed: bool = False


class ReplyEmailApiRequest(BaseModel):
    message_id: str = Field(min_length=1)
    body_text: str
    body_html: str | None = None
    reply_all: bool = False
    account_id: str | None = None
    confirmed: bool = False


# ─── Service & Serialization Helpers ───────────────────────────────────────

def _get_email_service():
    from backend.integrations.email.unified_resolver import MultiProviderEmailService, UnifiedEmailResolver
    from backend.security.audit import get_audit_logger
    from backend.security.authorization import get_authorization_service

    resolver = UnifiedEmailResolver()
    authz = get_authorization_service()
    audit = get_audit_logger()
    return MultiProviderEmailService(resolver=resolver, authorization=authz, audit_logger=audit)


def _user_to_attrs(user: UserIdentity):
    from backend.security.authorization import UserAttributes

    return UserAttributes(
        user_id=user.subject,
        tenant_id=user.tenant_id or "enterprise-tenant",
        roles=user.roles,
        department=user.department,
        clearance_level=user.clearance_level,
    )


def _serialize_message_summary(msg: EmailMessage) -> dict[str, Any]:
    return {
        "id": msg.id,
        "conversation_id": msg.conversation_id,
        "subject": msg.subject,
        "sender": {"address": msg.sender.address, "name": msg.sender.name} if msg.sender else None,
        "to_recipients": [{"address": r.address, "name": r.name} for r in msg.to_recipients],
        "received_at": msg.received_at.isoformat() if msg.received_at else None,
        "sent_at": msg.sent_at.isoformat() if msg.sent_at else None,
        "body_preview": msg.body_preview,
        "has_attachments": msg.has_attachments,
        "attachments": [
            {"id": a.id, "name": a.name, "content_type": a.content_type, "size_bytes": a.size_bytes}
            for a in msg.attachments
        ],
        "web_link": msg.web_link,
        "source": msg.source,
        "folder": msg.folder,
        "account_id": msg.account_id,
        "account_email": msg.account_email,
        "provider": msg.provider,
    }


def _serialize_message_detail(msg: EmailMessage) -> dict[str, Any]:
    data = _serialize_message_summary(msg)
    data["body_text"] = msg.body_text
    data["body_html_sanitized"] = msg.body_html_sanitized
    data["cc_recipients"] = [{"address": r.address, "name": r.name} for r in msg.cc_recipients]
    data["reply_to"] = [{"address": r.address, "name": r.name} for r in msg.reply_to]
    data["message_id_header"] = msg.message_id_header
    return data


# ─── Google OAuth Endpoints ───────────────────────────────────────────────

def _clean_redirect_uri(redirect_uri: str | None, default_uri: str) -> str:
    """Sanitize redirect_uri against 'null', 'file://', or malformed values from Electron/Chromium."""
    if not redirect_uri:
        return default_uri
    cleaned = str(redirect_uri).strip()
    if not cleaned or cleaned.lower() in ("null", "undefined", "none", "file://") or not cleaned.startswith(("http://", "https://")):
        return default_uri
    return cleaned


@router.get("/oauth/google/url")
def get_google_auth_url(
    redirect_uri: str | None = Query(default=None),
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, str]:
    """Generate a Google OAuth 2.0 authorization URL for connecting a mailbox."""
    from backend.core.config import settings
    oauth = get_google_oauth_service()
    effective_uri = _clean_redirect_uri(redirect_uri, settings.google_redirect_uri or "http://localhost:5173")
    try:
        url = oauth.generate_auth_url(
            user_id=user.subject,
            tenant_id=user.tenant_id or "enterprise-tenant",
            redirect_uri=effective_uri,
        )
        return {"auth_url": url, "redirect_uri": effective_uri}
    except Exception as exc:
        logger.error("Failed to generate Google auth URL: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate Google auth URL: {exc}",
        )


@router.post("/oauth/google/callback")
def handle_google_callback(
    body: OAuthCallbackRequest,
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, Any]:
    """Exchange authorization code from Google OAuth and save the connected mailbox."""
    from backend.core.config import settings
    oauth = get_google_oauth_service()
    account_service = get_user_email_account_service()

    redirect_uri = _clean_redirect_uri(body.redirect_uri, settings.google_redirect_uri or "http://localhost:5173")

    try:
        token_data = oauth.exchange_code(body.code, redirect_uri=redirect_uri)
    except Exception as exc:
        logger.error("Token exchange with Google failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Google authorization failed: {exc}",
        )

    access_token = token_data.get("access_token", "")
    refresh_token = token_data.get("refresh_token", "")
    expires_in = token_data.get("expires_in", 3600)
    scopes = token_data.get("scope", "gmail.readonly")

    userinfo = oauth.fetch_userinfo(access_token) if access_token else {}
    email_address = userinfo.get("email") or f"{user.subject}@gmail.com"
    display_name = userinfo.get("name") or user.name or "Google Workspace User"
    avatar_url = userinfo.get("picture")

    if not refresh_token:
        existing = account_service.get_active_account(user.subject)
        if existing and existing.refresh_token:
            refresh_token = existing.refresh_token

    account = UserEmailAccount(
        id=str(uuid.uuid4()),
        user_id=user.subject,
        tenant_id=user.tenant_id or "enterprise-tenant",
        email_address=email_address,
        display_name=display_name,
        provider="google",
        access_token=access_token,
        refresh_token=refresh_token,
        token_expires_at=time.time() + expires_in,
        scopes=scopes,
        avatar_url=avatar_url,
        is_active=True,
    )
    saved = account_service.save_account(account)

    log_event(
        logger,
        "email_account_connected",
        actor_id=user.subject,
        tenant_id=user.tenant_id,
        email_address=email_address,
        provider="google",
    )

    return {"status": "connected", "account": saved.to_safe_dict()}


@router.post("/oauth/google/connect-saved")
def connect_saved_mailbox(
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, Any]:
    """Connect the enterprise Gmail mailbox configured in the server environment."""
    from backend.core.config import settings
    if not settings.gmail_refresh_token or not settings.google_client_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No saved Gmail credentials configured on the server.",
        )
    oauth = get_google_oauth_service()
    account_service = get_user_email_account_service()

    try:
        access_token, expires_in = oauth.refresh_access_token(settings.gmail_refresh_token)
        userinfo = oauth.fetch_userinfo(access_token) if access_token else {}
    except Exception as exc:
        logger.error("Failed to connect saved Gmail account: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to refresh saved Google account: {exc}",
        )

    email_address = userinfo.get("email") or f"{user.subject}@gmail.com"
    display_name = userinfo.get("name") or user.name or "Google Workspace Account"
    avatar_url = userinfo.get("picture")

    saved = account_service.save_account(
        UserEmailAccount(
            id=str(uuid.uuid4()),
            user_id=user.subject,
            tenant_id=user.tenant_id or "enterprise-tenant",
            email_address=email_address,
            display_name=display_name,
            provider="google",
            access_token=access_token,
            refresh_token=settings.gmail_refresh_token,
            token_expires_at=time.time() + expires_in,
            scopes="gmail.readonly,email,profile",
            avatar_url=avatar_url,
            is_active=True,
        )
    )

    log_event(
        logger,
        "email_account_connected",
        actor_id=user.subject,
        tenant_id=user.tenant_id,
        email_address=email_address,
        provider="google",
    )

    return {"status": "connected", "account": saved.to_safe_dict()}


# ─── Microsoft 365 OAuth Endpoints ─────────────────────────────────────────

@router.get("/oauth/microsoft/url")
def get_microsoft_auth_url(
    redirect_uri: str | None = Query(default=None),
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, str]:
    """Generate Microsoft 365 OAuth URL."""
    from backend.connections.providers.microsoft import Microsoft365Provider
    from backend.core.config import settings
    provider = Microsoft365Provider()
    if isinstance(settings.cors_origins, (list, tuple)) and settings.cors_origins:
        origin = str(settings.cors_origins[0]).strip()
    elif isinstance(settings.cors_origins, str) and settings.cors_origins:
        origin = settings.cors_origins.split(",")[0].strip()
    else:
        origin = "http://localhost:5173"
    effective_uri = _clean_redirect_uri(redirect_uri, f"{origin}/auth/microsoft/callback")
    state = f"ms_{user.subject}_{uuid.uuid4().hex[:8]}"
    url = provider.get_authorization_url(
        user_id=user.subject,
        tenant_id=user.tenant_id or "enterprise-tenant",
        redirect_uri=effective_uri,
        state=state,
    )
    return {"auth_url": url, "redirect_uri": effective_uri, "state": state}


@router.post("/oauth/microsoft/callback")
def handle_microsoft_callback(
    body: OAuthCallbackRequest,
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, Any]:
    """Exchange Microsoft OAuth code and store connected mailbox."""
    from backend.connections.providers.microsoft import Microsoft365Provider
    from backend.core.config import settings
    provider = Microsoft365Provider()
    if isinstance(settings.cors_origins, (list, tuple)) and settings.cors_origins:
        origin = str(settings.cors_origins[0]).strip()
    elif isinstance(settings.cors_origins, str) and settings.cors_origins:
        origin = settings.cors_origins.split(",")[0].strip()
    else:
        origin = "http://localhost:5173"
    redirect_uri = _clean_redirect_uri(body.redirect_uri, f"{origin}/auth/microsoft/callback")

    res = provider.handle_callback(
        code=body.code,
        state=body.state or "",
        redirect_uri=redirect_uri,
    )
    creds = res.get("credentials", {})
    meta = res.get("metadata_safe", {})
    account_service = get_user_email_account_service()

    account = UserEmailAccount(
        id=str(uuid.uuid4()),
        user_id=user.subject,
        tenant_id=user.tenant_id or "enterprise-tenant",
        email_address=meta.get("email") or "m365-user@outlook.com",
        display_name=meta.get("name") or "Microsoft 365 Account",
        provider="microsoft365",
        access_token=creds.get("access_token", ""),
        refresh_token=creds.get("refresh_token", ""),
        token_expires_at=float(creds.get("token_expires_at", 0.0)),
        scopes=" ".join(res.get("granted_scopes", ["Mail.Read", "Mail.Send"])),
        avatar_url=None,
        is_active=True,
    )
    saved = account_service.save_account(account)
    return {"status": "connected", "account": saved.to_safe_dict()}


# ─── Yahoo & Outlook Direct Endpoints ─────────────────────────────────────

@router.post("/connect/yahoo")
def connect_yahoo_mailbox(
    body: YahooConnectRequest,
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, Any]:
    """Connect a Yahoo Mail account using a 16-character secure App Password."""
    from backend.connections.providers.yahoo import YahooMailProvider
    from backend.core.config import settings
    provider = YahooMailProvider()
    normalized_pwd = body.app_password.replace(" ", "").strip()
    try:
        conn_data = provider.connect({"email": body.email_address, "app_password": normalized_pwd})
        try:
            provider.test_connection(
                decrypted_credentials=conn_data["credentials"],
                metadata_safe=conn_data["metadata_safe"],
            )
        except Exception as test_exc:
            if settings.allows_synthetic_data or "unreachable" in str(test_exc).lower() or "timed out" in str(test_exc).lower():
                logger.warning("Yahoo connection test skipped/warned in sandbox/offline mode: %s", test_exc)
            else:
                raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Yahoo Mail connection failed: {exc}",
        )

    account_service = get_user_email_account_service()
    saved = account_service.save_account(
        UserEmailAccount(
            id=str(uuid.uuid4()),
            user_id=user.subject,
            tenant_id=user.tenant_id or "enterprise-tenant",
            email_address=body.email_address.strip(),
            display_name=body.display_name or f"Yahoo Mail ({body.email_address})",
            provider="yahoo",
            access_token=normalized_pwd,
            refresh_token="",
            scopes="mail-read,mail-search,mail-send",
            is_active=True,
        )
    )
    return {"status": "connected", "account": saved.to_safe_dict()}


@router.post("/connect/outlook")
def connect_outlook_mailbox(
    body: OutlookConnectRequest,
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, Any]:
    """Connect an Outlook / Office 365 account directly via email & App Password (IMAP/TLS)."""
    from backend.core.config import settings
    email_clean = body.email_address.strip()
    pwd_clean = body.password.strip()
    if not email_clean or not pwd_clean:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email and password are required.")

    from backend.integrations.email.imap_provider import ImapEmailProvider
    provider = ImapEmailProvider(
        host="outlook.office365.com",
        port=993,
        smtp_host="smtp.office365.com",
        smtp_port=587,
    )
    if not settings.allows_synthetic_data:
        try:
            client = provider._get_imap_client(email_clean, pwd_clean, "outlook.office365.com")
            client.logout()
        except Exception as exc:
            logger.warning("Outlook direct connection test warning: %s", exc)
            if "authentication failed" in str(exc).lower():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Outlook authentication failed. If 2-Factor Authentication is active, please use an App Password or connect via Microsoft OAuth.",
                )

    account_service = get_user_email_account_service()
    saved = account_service.save_account(
        UserEmailAccount(
            id=str(uuid.uuid4()),
            user_id=user.subject,
            tenant_id=user.tenant_id or "enterprise-tenant",
            email_address=email_clean,
            display_name=body.display_name or f"Outlook ({email_clean})",
            provider="outlook",
            access_token=pwd_clean,
            refresh_token="",
            scopes="Mail.Read,Mail.Send",
            is_active=True,
        )
    )
    return {"status": "connected", "account": saved.to_safe_dict()}


@router.post("/oauth/microsoft/connect-saved")
def connect_saved_microsoft_mailbox(
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, Any]:
    """Connect the enterprise Microsoft / Outlook account configured in the server environment."""
    from backend.core.config import settings
    account_service = get_user_email_account_service()

    if settings.microsoft_refresh_token and settings.microsoft_client_id:
        from backend.connections.providers.microsoft import Microsoft365Provider
        provider = Microsoft365Provider()
        try:
            token_data = provider.refresh_credentials({"refresh_token": settings.microsoft_refresh_token})
            access_token = token_data.get("access_token") if token_data else ""
        except Exception as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Failed to refresh saved Microsoft account: {exc}")

        email_address = "m365-enterprise@outlook.com"
        saved = account_service.save_account(
            UserEmailAccount(
                id=str(uuid.uuid4()),
                user_id=user.subject,
                tenant_id=user.tenant_id or "enterprise-tenant",
                email_address=email_address,
                display_name="Microsoft 365 Enterprise",
                provider="microsoft365",
                access_token=access_token,
                refresh_token=settings.microsoft_refresh_token,
                token_expires_at=time.time() + 3600,
                scopes="Mail.Read,Mail.Send",
                is_active=True,
            )
        )
        return {"status": "connected", "account": saved.to_safe_dict()}

    if settings.outlook_email and settings.outlook_password:
        saved = account_service.save_account(
            UserEmailAccount(
                id=str(uuid.uuid4()),
                user_id=user.subject,
                tenant_id=user.tenant_id or "enterprise-tenant",
                email_address=settings.outlook_email,
                display_name=f"Outlook ({settings.outlook_email})",
                provider="outlook",
                access_token=settings.outlook_password,
                refresh_token="",
                scopes="Mail.Read,Mail.Send",
                is_active=True,
            )
        )
        return {"status": "connected", "account": saved.to_safe_dict()}

    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No saved Microsoft or Outlook credentials configured on the server.")


@router.post("/connect/yahoo/connect-saved")
def connect_saved_yahoo_mailbox(
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, Any]:
    """Connect the enterprise Yahoo mailbox configured in the server environment."""
    from backend.core.config import settings
    if not settings.yahoo_email or not settings.yahoo_app_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No saved Yahoo credentials (YAHOO_EMAIL, YAHOO_APP_PASSWORD) configured on the server.",
        )
    account_service = get_user_email_account_service()
    saved = account_service.save_account(
        UserEmailAccount(
            id=str(uuid.uuid4()),
            user_id=user.subject,
            tenant_id=user.tenant_id or "enterprise-tenant",
            email_address=settings.yahoo_email,
            display_name=f"Yahoo Mail ({settings.yahoo_email})",
            provider="yahoo",
            access_token=settings.yahoo_app_password.replace(" ", "").strip(),
            refresh_token="",
            scopes="mail-read,mail-search,mail-send",
            is_active=True,
        )
    )
    return {"status": "connected", "account": saved.to_safe_dict()}


# ─── Mailbox Status & Account Management ───────────────────────────────────

_FAILED_AUTO_LINK_CACHE: dict[str, float] = {}
_AUTO_LINK_RETRY_COOLDOWN_SECONDS = 900.0


@router.get("/status")
def get_mailbox_status(user: UserIdentity = Depends(get_current_user)) -> dict[str, Any]:
    """Get the current user's connected mailbox status across all providers."""
    from backend.core.config import settings
    account_service = get_user_email_account_service()
    accounts = account_service.get_accounts(user.subject)
    primary = account_service.get_active_account(user.subject)

    # 1. Auto-link Google if configured in .env
    has_google = any((a.provider or "").lower() in ("google", "gmail") for a in accounts)
    if not has_google and settings.gmail_refresh_token and settings.google_client_id and settings.google_client_secret:
        token_fp = hashlib.sha256(settings.gmail_refresh_token.encode("utf-8")).hexdigest()
        last_failed_at = _FAILED_AUTO_LINK_CACHE.get(token_fp, 0.0)
        if time.time() - last_failed_at >= _AUTO_LINK_RETRY_COOLDOWN_SECONDS:
            try:
                oauth = get_google_oauth_service()
                access_token, expires_in = oauth.refresh_access_token(settings.gmail_refresh_token)
                userinfo = oauth.fetch_userinfo(access_token) if access_token else {}
                email_address = userinfo.get("email") or f"{user.subject}@gmail.com"
                display_name = userinfo.get("name") or user.name or "Google Workspace Account"
                avatar_url = userinfo.get("picture")

                new_g = account_service.save_account(
                    UserEmailAccount(
                        id=str(uuid.uuid4()),
                        user_id=user.subject,
                        tenant_id=user.tenant_id or "enterprise-tenant",
                        email_address=email_address,
                        display_name=display_name,
                        provider="google",
                        access_token=access_token,
                        refresh_token=settings.gmail_refresh_token,
                        token_expires_at=time.time() + expires_in,
                        scopes="gmail.readonly,email,profile",
                        avatar_url=avatar_url,
                        is_active=True,
                    )
                )
                accounts.append(new_g)
                if not primary:
                    primary = new_g
                _FAILED_AUTO_LINK_CACHE.pop(token_fp, None)
            except Exception as exc:
                _FAILED_AUTO_LINK_CACHE[token_fp] = time.time()
                logger.warning("Auto-linking configured Gmail account failed: %s", exc)

    # 2. Auto-link Yahoo if configured in .env
    has_yahoo = any((a.provider or "").lower() == "yahoo" for a in accounts)
    if not has_yahoo and settings.yahoo_email and settings.yahoo_app_password:
        try:
            new_y = account_service.save_account(
                UserEmailAccount(
                    id=str(uuid.uuid4()),
                    user_id=user.subject,
                    tenant_id=user.tenant_id or "enterprise-tenant",
                    email_address=settings.yahoo_email,
                    display_name=f"Yahoo Mail ({settings.yahoo_email})",
                    provider="yahoo",
                    access_token=settings.yahoo_app_password.replace(" ", "").strip(),
                    refresh_token="",
                    scopes="mail-read,mail-search,mail-send",
                    is_active=True,
                )
            )
            accounts.append(new_y)
            if not primary:
                primary = new_y
        except Exception as exc:
            logger.warning("Auto-linking configured Yahoo account failed: %s", exc)

    # 3. Auto-link Microsoft / Outlook if configured in .env
    has_ms = any((a.provider or "").lower() in ("microsoft365", "outlook") for a in accounts)
    if not has_ms:
        if settings.outlook_email and settings.outlook_password:
            try:
                new_ms = account_service.save_account(
                    UserEmailAccount(
                        id=str(uuid.uuid4()),
                        user_id=user.subject,
                        tenant_id=user.tenant_id or "enterprise-tenant",
                        email_address=settings.outlook_email,
                        display_name=f"Outlook ({settings.outlook_email})",
                        provider="outlook",
                        access_token=settings.outlook_password.strip(),
                        refresh_token="",
                        scopes="Mail.Read,Mail.Send",
                        is_active=True,
                    )
                )
                accounts.append(new_ms)
                if not primary:
                    primary = new_ms
            except Exception as exc:
                logger.warning("Auto-linking configured Outlook account failed: %s", exc)
        elif settings.microsoft_refresh_token and settings.microsoft_client_id and settings.microsoft_client_secret:
            try:
                from backend.connections.providers.microsoft import Microsoft365Provider
                ms_prov = Microsoft365Provider()
                t_data = ms_prov.refresh_credentials({"refresh_token": settings.microsoft_refresh_token})
                if t_data and t_data.get("access_token"):
                    new_ms = account_service.save_account(
                        UserEmailAccount(
                            id=str(uuid.uuid4()),
                            user_id=user.subject,
                            tenant_id=user.tenant_id or "enterprise-tenant",
                            email_address="m365-enterprise@outlook.com",
                            display_name="Microsoft 365 Account",
                            provider="microsoft365",
                            access_token=t_data["access_token"],
                            refresh_token=settings.microsoft_refresh_token,
                            token_expires_at=time.time() + 3600,
                            scopes="Mail.Read,Mail.Send",
                            is_active=True,
                        )
                    )
                    accounts.append(new_ms)
                    if not primary:
                        primary = new_ms
            except Exception as exc:
                logger.warning("Auto-linking configured Microsoft 365 account failed: %s", exc)

    has_enterprise_fallback = bool(settings.gmail_refresh_token or settings.gmail_access_token)
    has_microsoft_fallback = bool(settings.microsoft_refresh_token or (settings.outlook_email and settings.outlook_password))
    has_yahoo_fallback = bool(settings.yahoo_email and settings.yahoo_app_password)
    is_microsoft_oauth_configured = bool(settings.microsoft_client_id and settings.microsoft_client_secret)

    return {
        "connected": bool(primary),
        "account": primary.to_safe_dict() if primary else None,
        "accounts": [a.to_safe_dict() for a in accounts],
        "has_enterprise_fallback": has_enterprise_fallback,
        "has_microsoft_fallback": has_microsoft_fallback,
        "has_yahoo_fallback": has_yahoo_fallback,
        "is_microsoft_oauth_configured": is_microsoft_oauth_configured,
    }


@router.get("/accounts")
def list_user_accounts(user: UserIdentity = Depends(get_current_user)) -> list[dict[str, Any]]:
    """List all connected email mailboxes for the current user."""
    account_service = get_user_email_account_service()
    return [a.to_safe_dict() for a in account_service.get_accounts(user.subject)]


@router.post("/disconnect")
def disconnect_mailbox(
    body: DisconnectRequest | None = None,
    user: UserIdentity = Depends(get_current_user),
) -> dict[str, str]:
    """Disconnect an active or specified mailbox for the current user."""
    account_id = body.account_id if body else None
    account_service = get_user_email_account_service()
    account_service.disconnect_account(user.subject, account_id=account_id)
    log_event(
        logger,
        "email_account_disconnected",
        actor_id=user.subject,
        tenant_id=user.tenant_id,
        account_id=account_id,
    )
    return {"status": "disconnected"}


@router.post("/manual-connect")
def manual_connect_mailbox(
    body: ManualConnectRequest,
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, Any]:
    """Manually link or update an email account for the user."""
    from backend.core.config import settings
    account_service = get_user_email_account_service()

    refresh_token = body.refresh_token or (settings.gmail_refresh_token if body.provider == "google" else "") or ""
    access_token = body.access_token or (settings.gmail_access_token if body.provider == "google" else "") or ""

    account = UserEmailAccount(
        id=str(uuid.uuid4()),
        user_id=user.subject,
        tenant_id=user.tenant_id or "enterprise-tenant",
        email_address=body.email_address,
        display_name=body.display_name or user.name or "Enterprise User",
        provider=body.provider,
        access_token=access_token,
        refresh_token=refresh_token,
        token_expires_at=time.time() + 3600 if access_token else 0.0,
        scopes="gmail.readonly,email,profile" if body.provider == "google" else "email",
        is_active=True,
    )
    saved = account_service.save_account(account)
    return {"status": "connected", "account": saved.to_safe_dict()}


# ─── Mailbox Browsing & Message Endpoints ─────────────────────────────────

@router.get("/folders")
def list_folders(
    account_id: str | None = Query(default=None),
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> list[dict[str, Any]]:
    """List folders for a connected account or default mailbox."""
    svc = _get_email_service()
    user_attrs = _user_to_attrs(user)
    folders = svc.list_folders(user_attrs, account_id=account_id)
    return [
        {
            "id": f.id,
            "name": f.name,
            "total_count": f.total_count,
            "unread_count": f.unread_count,
        }
        for f in folders
    ]


@router.get("/messages")
def list_messages(
    folder_id: str = Query(default="inbox"),
    account_id: str | None = Query(default=None),
    query: str | None = Query(default=None),
    limit: int = Query(default=25, ge=1, le=100),
    cursor: str | None = Query(default=None),
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, Any]:
    """List messages in a folder or search across mailboxes."""
    svc = _get_email_service()
    user_attrs = _user_to_attrs(user)
    if query:
        req = EmailSearchRequest(query=query, max_results=limit, cursor=cursor)
        messages = svc.search_all(user_attrs, req, account_id=account_id)
        return {
            "messages": [_serialize_message_summary(m) for m in messages],
            "next_cursor": None,
        }
    page = svc.list_messages(user_attrs, folder_id=folder_id, account_id=account_id, limit=limit, cursor=cursor)
    return {
        "messages": [_serialize_message_summary(m) for m in page.messages],
        "next_cursor": page.next_cursor,
    }


@router.get("/messages/{message_id}")
def get_message(
    message_id: str,
    account_id: str | None = Query(default=None),
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, Any]:
    """Fetch complete details of an email message."""
    svc = _get_email_service()
    user_attrs = _user_to_attrs(user)
    msg = svc.get_message(user_attrs, message_id, account_id=account_id)
    return _serialize_message_detail(msg)


@router.get("/messages/{message_id}/attachments/{attachment_id}")
def download_attachment(
    message_id: str,
    attachment_id: str,
    account_id: str | None = Query(default=None),
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.read")),
) -> dict[str, Any]:
    """Download an email attachment by ID."""
    svc = _get_email_service()
    user_attrs = _user_to_attrs(user)
    att = svc.download_attachment(user_attrs, message_id, attachment_id, account_id=account_id)
    return {
        "id": att.id,
        "name": att.name,
        "content_type": att.content_type,
        "size_bytes": att.size_bytes,
        "data_base64": base64.b64encode(att.data).decode("ascii"),
    }


# ─── Outbound Sending & Replying Endpoints ─────────────────────────────────

@router.post("/send")
def send_email(
    body: SendEmailApiRequest,
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.send")),
) -> dict[str, Any]:
    """Send an outbound email. Requires explicit user confirmation (confirmed=True)."""
    if not body.confirmed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Explicit user confirmation (confirmed=True) is required to send emails.",
        )
    svc = _get_email_service()
    user_attrs = _user_to_attrs(user)
    req = EmailSendRequest(
        to_recipients=tuple(EmailAddress(a.strip()) for a in body.to if a.strip()),
        subject=body.subject,
        body_text=body.body_text,
        body_html=body.body_html,
        cc_recipients=tuple(EmailAddress(a.strip()) for a in body.cc if a.strip()),
        bcc_recipients=tuple(EmailAddress(a.strip()) for a in body.bcc if a.strip()),
        reply_to=tuple(EmailAddress(a.strip()) for a in body.reply_to if a.strip()),
        account_id=body.account_id,
    )
    sent = svc.send_email(user_attrs, req, confirmed=True)
    return {"status": "sent", "message": _serialize_message_summary(sent)}


@router.post("/reply")
def reply_email(
    body: ReplyEmailApiRequest,
    user: UserIdentity = Depends(get_current_user),
    _uecp: Any = Depends(require_uecp_access(permission="email.send")),
) -> dict[str, Any]:
    """Reply to an email message. Requires explicit user confirmation (confirmed=True)."""
    if not body.confirmed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Explicit user confirmation (confirmed=True) is required to reply to emails.",
        )
    svc = _get_email_service()
    user_attrs = _user_to_attrs(user)
    req = EmailReplyRequest(
        message_id=body.message_id,
        body_text=body.body_text,
        body_html=body.body_html,
        reply_all=body.reply_all,
        account_id=body.account_id,
    )
    sent = svc.reply_email(user_attrs, req, confirmed=True)
    return {"status": "sent", "message": _serialize_message_summary(sent)}

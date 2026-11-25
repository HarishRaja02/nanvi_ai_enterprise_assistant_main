"""OAuth initiation and callback routes for Connections Hub."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse

from backend.connections.base import OAuthDenied, OAuthExpired
from backend.connections.manager import ConnectionManager, get_connection_manager
from backend.core.config import settings
from backend.security.dependencies import get_current_user, get_optional_current_user
from backend.security.models import UserIdentity

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/connections/oauth", tags=["connections-oauth"])
auth_router = APIRouter(prefix="/api/auth", tags=["auth"])
auth_legacy_router = APIRouter(prefix="/auth", tags=["auth-legacy"])


def _is_cloud_host(host: str | None) -> bool:
    if not host:
        return False
    lower = host.lower()
    return not any(h in lower for h in ("localhost", "127.0.0.1", "0.0.0.0", "testserver"))


def _is_localhost_url(url: str) -> bool:
    from urllib.parse import urlparse
    host = (urlparse(url).hostname or "").lower()
    return host in ("localhost", "127.0.0.1", "0.0.0.0")


def _sanitize_redirect_after(redirect_after: str | None, request: Request) -> str | None:
    """Allow safe post-OAuth redirects to app origins and desktop loopback listeners."""
    if not redirect_after:
        return None
    cleaned = str(redirect_after).strip()
    if not cleaned:
        return None
    from urllib.parse import urlparse
    parsed = urlparse(cleaned)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    origin = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    allowed_origins = {
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    }
    if settings.frontend_url:
        allowed_origins.add(settings.frontend_url.rstrip("/"))
    if settings.oauth_redirect_base_url:
        allowed_origins.add(settings.oauth_redirect_base_url.rstrip("/"))
    for c_origin in settings.cors_origins or ():
        if c_origin:
            allowed_origins.add(str(c_origin).rstrip("/"))
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "http"
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    if host and host.lower() not in ("null", "none"):
        allowed_origins.add(f"{proto}://{host}".rstrip("/"))
    if origin in allowed_origins:
        return cleaned
    return None


def get_frontend_base_url(request: Request | None = None) -> str:
    """Get the frontend URL for redirecting users back to the UI.

    Seamlessly adapts to Vercel, cloud platforms, custom domains, and local dev.
    """
    import os
    proto = "http"
    host = ""
    if request is not None:
        proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "http"
        host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc or ""
    cloud = _is_cloud_host(host)

    configured = (settings.oauth_redirect_base_url or "").strip().rstrip("/")
    if configured and not (cloud and _is_localhost_url(configured)):
        return configured

    if cloud and host:
        return f"{proto}://{host}".rstrip("/")

    vercel_url = os.getenv("VERCEL_URL")
    if vercel_url:
        return f"https://{vercel_url.strip('/')}"

    if settings.frontend_url and (cloud or os.getenv("VERCEL") or os.getenv("VERCEL_ENV")):
        return settings.frontend_url.rstrip("/")

    if request:
        origin = request.headers.get("origin") or request.headers.get("referer")
        if origin:
            from urllib.parse import urlparse
            p = urlparse(origin)
            if p.scheme and p.netloc:
                return f"{p.scheme}://{p.netloc}"

    if settings.cors_origins:
        return settings.cors_origins[0].rstrip("/")

    return "http://localhost:5173"


def get_backend_callback_uri(request: Request, path: str, provider: str = "") -> str:
    """Resolve the OAuth callback redirect URI registered with the OAuth provider."""
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "http"
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc

    # Only honor GOOGLE_REDIRECT_URI if it actually points to this callback route;
    # never let a frontend origin such as http://localhost:5173 overwrite /api/connections/oauth/google/callback.
    if provider == "google" and settings.google_redirect_uri:
        configured_google_uri = settings.google_redirect_uri.strip()
        is_cloud_request = _is_cloud_host(host)
        is_configured_localhost = _is_localhost_url(configured_google_uri)
        if path in configured_google_uri and not (is_cloud_request and is_configured_localhost):
            return configured_google_uri

    # Detect scheme and host (honoring proxy headers for Vercel/reverse proxies)
    if host and host.lower() not in ("null", "none"):
        return f"{proto}://{host}{path}"

    base = str(request.base_url).rstrip("/")
    if base and not base.startswith(("null", "file:")):
        return f"{base}{path}"
    return f"http://localhost:8000{path}"


@router.get("/{provider}/authorize")
def start_oauth(
    provider: str,
    request: Request,
    scope_level: str = Query(default="user", pattern=r"^(user|organization)$"),
    redirect_after: str | None = Query(default=None),
    user: UserIdentity = Depends(get_current_user),
    manager: ConnectionManager = Depends(get_connection_manager),
) -> dict[str, str]:
    """Generate an authorization URL for OAuth provider."""
    redirect_uri = get_backend_callback_uri(request, f"/api/connections/oauth/{provider}/callback", provider=provider)
    safe_redirect_after = _sanitize_redirect_after(redirect_after, request)

    try:
        auth_url = manager.start_oauth(
            provider_id=provider,
            user=user,
            redirect_uri=redirect_uri,
            redirect_after=safe_redirect_after,
            scope_level=scope_level,
        )
        return {"authorization_url": auth_url}
    except Exception as exc:
        logger.error("OAuth start failed for %s: %s", provider, exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.get("/{provider}/callback")
def oauth_callback(
    provider: str,
    request: Request,
    code: str = Query(...),
    state: str | None = Query(default=None),
    current_user: UserIdentity | None = Depends(get_optional_current_user),
    manager: ConnectionManager = Depends(get_connection_manager),
) -> RedirectResponse:
    """Handle OAuth redirect callback from identity provider."""
    if not state:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing OAuth state parameter.",
        )
    redirect_uri = get_backend_callback_uri(request, f"/api/connections/oauth/{provider}/callback", provider=provider)
    frontend_base = get_frontend_base_url(request)

    try:
        conn, redirect_after = manager.handle_oauth_callback(
            provider_id=provider,
            code=code,
            state=state,
            redirect_uri=redirect_uri,
            expected_user_id=current_user.subject if current_user else None,
            expected_tenant_id=current_user.tenant_id if current_user else None,
        )
        target = _sanitize_redirect_after(redirect_after, request) or f"{frontend_base}/?tab=connections"
        delimiter = "&" if "?" in target else "?"
        return RedirectResponse(url=f"{target}{delimiter}connected={provider}&status=success")
    except (OAuthDenied, OAuthExpired) as exc:
        logger.warning("OAuth denied/expired for %s: %s", provider, exc)
        msg = str(exc)
        if "replay" in msg.lower() or "consumed" in msg.lower() or "not issued to the authenticated user" in msg.lower() or "mismatch" in msg.lower():
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
    except Exception as exc:
        logger.error("OAuth callback failed for %s: %s", provider, exc)
        target = f"{frontend_base}/?tab=connections"
        delimiter = "&" if "?" in target else "?"
        return RedirectResponse(url=f"{target}{delimiter}connected={provider}&status=error&error={str(exc)}")


# ── Top-level /api/auth/github routes ─────────────────────────

@auth_router.get("/github")
@auth_legacy_router.get("/github")
def github_auth_start(
    request: Request,
    scope_level: str = Query(default="user"),
    redirect_after: str | None = Query(default=None),
    user: UserIdentity = Depends(get_current_user),
    manager: ConnectionManager = Depends(get_connection_manager),
) -> RedirectResponse:
    """Initiate GitHub OAuth directly with redirect."""
    redirect_uri = get_backend_callback_uri(request, "/api/auth/github/callback", provider="github")

    auth_url = manager.start_oauth(
        provider_id="github",
        user=user,
        redirect_uri=redirect_uri,
        redirect_after=_sanitize_redirect_after(redirect_after, request),
        scope_level=scope_level,
    )
    return RedirectResponse(url=auth_url)


@auth_router.get("/github/callback")
@auth_legacy_router.get("/github/callback")
def github_auth_callback(
    request: Request,
    code: str = Query(...),
    state: str | None = Query(default=None),
    current_user: UserIdentity | None = Depends(get_optional_current_user),
    manager: ConnectionManager = Depends(get_connection_manager),
) -> RedirectResponse:
    """Handle GitHub OAuth callback."""
    if not state:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing OAuth state parameter.",
        )
    redirect_uri = get_backend_callback_uri(request, "/api/auth/github/callback", provider="github")
    frontend_base = get_frontend_base_url(request)

    try:
        conn, redirect_after = manager.handle_oauth_callback(
            provider_id="github",
            code=code,
            state=state,
            redirect_uri=redirect_uri,
            expected_user_id=current_user.subject if current_user else None,
            expected_tenant_id=current_user.tenant_id if current_user else None,
        )
        target = _sanitize_redirect_after(redirect_after, request) or f"{frontend_base}/?tab=connections"
        delimiter = "&" if "?" in target else "?"
        return RedirectResponse(url=f"{target}{delimiter}connected=github&status=success")
    except (OAuthDenied, OAuthExpired) as exc:
        logger.warning("GitHub OAuth denied/expired: %s", exc)
        msg = str(exc)
        if "replay" in msg.lower() or "consumed" in msg.lower() or "not issued to the authenticated user" in msg.lower() or "mismatch" in msg.lower():
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
    except Exception as exc:
        logger.error("GitHub callback error: %s", exc)
        return RedirectResponse(url=f"{frontend_base}/?tab=connections&connected=github&status=error&error={str(exc)}")


# ── Top-level /api/auth/google routes (backward-compatibility alias) ──

@auth_router.get("/google")
@auth_legacy_router.get("/google")
def google_auth_start(
    request: Request,
    scope_level: str = Query(default="user"),
    redirect_after: str | None = Query(default=None),
    user: UserIdentity = Depends(get_current_user),
    manager: ConnectionManager = Depends(get_connection_manager),
) -> RedirectResponse:
    """Initiate Google OAuth directly with redirect."""
    redirect_uri = get_backend_callback_uri(request, "/api/auth/google/callback", provider="google")

    auth_url = manager.start_oauth(
        provider_id="google",
        user=user,
        redirect_uri=redirect_uri,
        redirect_after=_sanitize_redirect_after(redirect_after, request),
        scope_level=scope_level,
    )
    return RedirectResponse(url=auth_url)


@auth_router.get("/google/callback")
@auth_legacy_router.get("/google/callback")
def google_auth_callback(
    request: Request,
    code: str = Query(...),
    state: str | None = Query(default=None),
    current_user: UserIdentity | None = Depends(get_optional_current_user),
    manager: ConnectionManager = Depends(get_connection_manager),
) -> RedirectResponse:
    """Handle Google OAuth callback."""
    if not state:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing OAuth state parameter.",
        )
    redirect_uri = get_backend_callback_uri(request, "/api/auth/google/callback", provider="google")
    frontend_base = get_frontend_base_url(request)

    try:
        conn, redirect_after = manager.handle_oauth_callback(
            provider_id="google",
            code=code,
            state=state,
            redirect_uri=redirect_uri,
            expected_user_id=current_user.subject if current_user else None,
            expected_tenant_id=current_user.tenant_id if current_user else None,
        )
        target = _sanitize_redirect_after(redirect_after, request) or f"{frontend_base}/?tab=connections"
        delimiter = "&" if "?" in target else "?"
        return RedirectResponse(url=f"{target}{delimiter}connected=google&status=success")
    except (OAuthDenied, OAuthExpired) as exc:
        logger.warning("Google OAuth denied/expired: %s", exc)
        msg = str(exc)
        if "replay" in msg.lower() or "consumed" in msg.lower() or "not issued to the authenticated user" in msg.lower() or "mismatch" in msg.lower():
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
    except Exception as exc:
        logger.error("Google callback error: %s", exc)
        return RedirectResponse(url=f"{frontend_base}/?tab=connections&connected=google&status=error&error={str(exc)}")



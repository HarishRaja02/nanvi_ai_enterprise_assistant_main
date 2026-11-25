from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.api.routes import router
from backend.api.report_routes import router as report_router
from backend.api.source_routes import router as source_router
from backend.api.chat_routes import router as chat_router
from backend.core.config import settings
from backend.observability import RequestContextMiddleware, configure_logging, configure_telemetry
from backend.security.headers import SecurityHeadersMiddleware
from backend.security.rate_limiting import InMemoryFixedWindowRateLimiter, NoOpRateLimiter, RateLimitExceeded, RedisFixedWindowRateLimiter

from contextlib import asynccontextmanager
from backend.core.exceptions import DependencyUnavailableError

configure_logging(settings.log_level)
configure_telemetry(settings.otel_enabled, settings.otel_service_name, settings.otel_exporter_otlp_endpoint)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail fast at startup in production
    settings.validate_production_configuration()
    yield

app = FastAPI(title=settings.app_name, debug=settings.debug, lifespan=lifespan)
app.add_middleware(RequestContextMiddleware)
app.add_middleware(SecurityHeadersMiddleware, hsts_enabled=settings.hsts_enabled)

@app.exception_handler(DependencyUnavailableError)
async def dependency_unavailable_handler(request: Request, exc: DependencyUnavailableError):
    return JSONResponse(
        status_code=503,
        content={
            "detail": "DEPENDENCY_UNAVAILABLE",
            "message": str(exc),
            "dependency": exc.dependency,
        },
        headers={"Retry-After": "30"},
    )

import os

cors_origins = list(settings.cors_origins) if settings.cors_origins else ["http://localhost:5173", "http://127.0.0.1:5173"]
for env_host in (os.getenv("VERCEL_URL"), os.getenv("VERCEL_PROJECT_PRODUCTION_URL")):
    if env_host:
        origin_url = f"https://{env_host.strip().rstrip('/')}"
        if origin_url not in cors_origins:
            cors_origins.append(origin_url)
if settings.frontend_url and settings.frontend_url not in cors_origins:
    if not settings.is_production or settings.frontend_url.startswith("https://"):
        cors_origins.append(settings.frontend_url)
if not settings.is_production and "null" not in cors_origins:
    cors_origins.append("null")

allow_origin_regex = (
    None
    if settings.is_production
    else r"^(http://(localhost|127\.0\.0\.1)(:\d+)?|null|file://.*|https://.*\.vercel\.app)$"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=allow_origin_regex,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
)

if settings.is_production and settings.redis_url:
    _rate_limiter = RedisFixedWindowRateLimiter(
        settings.redis_url,
        settings.rate_limit_requests,
        settings.rate_limit_window_seconds,
    )
else:
    _rate_limiter = InMemoryFixedWindowRateLimiter(
        settings.rate_limit_requests,
        settings.rate_limit_window_seconds,
    ) if (settings.is_production or settings.is_testing) else NoOpRateLimiter()

@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if request.url.path in {"/api/health", "/api/health/ready", "/api/health/uecp", "/health/uecp"}:
        return await call_next(request)
    trusted_ip = (
        request.headers.get("x-vercel-forwarded-for")
        or request.headers.get("x-real-ip")
        or (request.client.host if request.client else "")
        or request.headers.get("X-Forwarded-For", "unknown").split(",")[-1].strip()
    )
    ip_key = trusted_ip.split(",")[0].strip() or "unknown"

    # Key authenticated requests by hashed bearer token so 100+ users behind an office NAT don't share one IP quota.
    # Keep unauthenticated & login/password-reset endpoints keyed strictly by IP to preserve brute-force protection.
    path_low = request.url.path.lower()
    auth_header = request.headers.get("authorization", "")
    key = ip_key
    is_auth_sensitive = "/auth/login" in path_low or "/auth/register" in path_low or "/auth/forgot-password" in path_low or "/auth/reset-password" in path_low
    if not is_auth_sensitive and auth_header.lower().startswith("bearer "):
        import hashlib
        tok = auth_header[7:].strip()
        if tok:
            tok_hash = hashlib.sha256(tok.encode("utf-8")).hexdigest()[:16]
            is_bg_sync = "/local-agent/sync" in path_low or "/local-agent/heartbeat" in path_low or "/local-agent/extract-text" in path_low
            key = f"{'sync' if is_bg_sync else 'user'}:{tok_hash}"

    try:
        _rate_limiter.check(key)
    except RateLimitExceeded:
        return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"}, headers={"Retry-After": str(settings.rate_limit_window_seconds)})
    return await call_next(request)

from backend.api.email_routes import router as email_router
from backend.api.settings_routes import router as settings_router
from backend.api.voice_routes import router as voice_router
from backend.api.local_auth_routes import router as local_auth_router
from backend.connections.routes import router as connections_router
from backend.connections.oauth_routes import (
    router as connections_oauth_router,
    auth_router as connections_auth_router,
    auth_legacy_router as connections_auth_legacy_router,
)

from backend.local_agent.routes import router as local_agent_router
from backend.api.admin_routes import router as admin_router
from backend.api.support_routes import router as support_router
from backend.api.log_routes import router as log_router

app.include_router(router, prefix="/api")
app.include_router(router)
app.include_router(report_router, prefix="/api")
app.include_router(report_router)
app.include_router(source_router, prefix="/api")
app.include_router(source_router)
app.include_router(chat_router, prefix="/api")
app.include_router(chat_router)
app.include_router(voice_router, prefix="/api")
app.include_router(voice_router)
app.include_router(local_auth_router, prefix="/api")
app.include_router(local_auth_router)
app.include_router(admin_router, prefix="/api")
app.include_router(admin_router)
app.include_router(support_router, prefix="/api")
app.include_router(support_router)
app.include_router(log_router, prefix="/api")
app.include_router(log_router)
app.include_router(email_router, prefix="/api")
app.include_router(email_router)
app.include_router(settings_router, prefix="/api")
app.include_router(settings_router)
app.include_router(local_agent_router, prefix="/api")
app.include_router(local_agent_router)
app.include_router(connections_router)
app.include_router(connections_oauth_router)
app.include_router(connections_auth_router)
app.include_router(connections_auth_legacy_router)



# Development-only endpoints (token generation for local testing)
if settings.is_development and settings.jwt_secret:
    from backend.api.dev_routes import router as dev_router
    app.include_router(dev_router, prefix="/api")
    app.include_router(dev_router)


from fastapi.responses import RedirectResponse
from backend.connections.oauth_routes import get_frontend_base_url

@app.get("/settings")
def redirect_to_frontend_settings(request: Request):
    """Gracefully redirect any direct backend hits for /settings to the frontend app."""
    frontend_base = get_frontend_base_url(request)
    query = str(request.url.query)
    target = f"{frontend_base}/settings"
    if query:
        target = f"{target}?{query}"
    return RedirectResponse(url=target)



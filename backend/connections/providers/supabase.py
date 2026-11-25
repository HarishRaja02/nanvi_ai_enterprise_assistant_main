"""Supabase Provider (Dual API key + direct PostgreSQL connection)."""
from __future__ import annotations

import logging
import urllib.parse
from typing import Any

import httpx

from backend.connections.base import (
    AuthType,
    BaseProvider,
    Capability,
    ConnectionError,
    ConnectionTimeout,
    InvalidCredentials,
    ProviderMetadata,
    TlsError,
    Unreachable,
)
from backend.connections.ssrf import validate_url_ssrf

logger = logging.getLogger(__name__)


class SupabaseProvider(BaseProvider):
    """Supabase provider supporting both REST API and direct Postgres DSN."""

    def __init__(self, http_client: httpx.Client | None = None) -> None:
        self._client = http_client or httpx.Client(timeout=10.0)

    def get_metadata(self) -> ProviderMetadata:
        from backend.core.config import settings
        oauth_configured = bool(settings.supabase_oauth_client_id and settings.supabase_oauth_client_secret)
        caps = {
            Capability.CREDENTIALS_FORM,
            Capability.TEST,
            Capability.QUERY_SQL,
            Capability.CALL_API,
        }
        if oauth_configured:
            caps.add(Capability.OAUTH)
            caps.add(Capability.REFRESH)
        return ProviderMetadata(
            id="supabase",
            name="Supabase",
            categories=("Databases", "Cloud Storage"),
            icon="supabase",
            description="Connect your Supabase project (REST API and direct PostgreSQL database).",
            auth_type=AuthType.OAUTH2 if oauth_configured else AuthType.API_KEY,
            capabilities=frozenset(caps),
            available=True,
            configuration_schema={
                "type": "object",
                "required": ["supabase_url", "supabase_key"],
                "properties": {
                    "supabase_url": {
                        "type": "string",
                        "title": "Project URL",
                        "description": "https://<project-ref>.supabase.co",
                    },
                    "supabase_key": {
                        "type": "string",
                        "title": "API Key (Service Role or Anon Key)",
                        "format": "password",
                    },
                    "database_url": {
                        "type": "string",
                        "title": "Direct Database URL (Optional)",
                        "description": "postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres",
                        "format": "password",
                    },
                },
            },
        )

    def connect(self, config: dict[str, Any]) -> dict[str, Any]:
        url = config.get("supabase_url", "").strip().rstrip("/")
        key = config.get("supabase_key", "").strip()
        db_url = config.get("database_url", "").strip()

        if not url:
            raise InvalidCredentials("Supabase project URL is required.")
        if not key:
            raise InvalidCredentials("Supabase API key is required.")

        validate_url_ssrf(url)

        parsed = urllib.parse.urlparse(url)
        project_ref = parsed.netloc.split(".")[0] or parsed.netloc

        return {
            "account_identifier": project_ref,
            "display_name": f"Supabase ({project_ref})",
            "credentials": {
                "supabase_url": url,
                "supabase_key": key,
                "database_url": db_url,
            },
            "metadata_safe": {
                "supabase_url": url,
                "project_ref": project_ref,
                "has_direct_db": bool(db_url),
            },
            "granted_scopes": ["query_sql", "call_api"] if db_url else ["call_api"],
        }

    def test_connection(
        self,
        *,
        decrypted_credentials: dict[str, Any],
        metadata_safe: dict[str, Any],
    ) -> dict[str, Any]:
        url = decrypted_credentials.get("supabase_url", "").strip().rstrip("/")
        key = decrypted_credentials.get("supabase_key", "").strip()
        db_url = decrypted_credentials.get("database_url", "").strip()

        if not url or not key:
            raise InvalidCredentials("Missing Supabase URL or API key.")

        validate_url_ssrf(url)

        headers = {"apikey": key, "Authorization": f"Bearer {key}"}
        api_ok = False
        key_type = "unknown"

        # 1. Test /auth/v1/settings (verifies both publishable/anon and service role keys)
        try:
            auth_resp = self._client.get(f"{url}/auth/v1/settings", headers=headers)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise Unreachable(f"Could not connect to Supabase host: {exc}") from exc
        except httpx.TimeoutException as exc:
            raise ConnectionTimeout("Connection to Supabase timed out.") from exc
        except Exception as exc:
            raise Unreachable(f"Supabase connection error: {exc}") from exc

        if auth_resp.status_code == 200:
            api_ok = True
            key_type = "verified_auth"
        else:
            # 2. Check /rest/v1/ (PostgREST schema / service role check)
            try:
                rest_resp = self._client.get(f"{url}/rest/v1/", headers=headers)
            except Exception as exc:
                raise Unreachable(f"Could not connect to Supabase REST API: {exc}") from exc

            if rest_resp.status_code in {200, 204, 404}:
                api_ok = True
                key_type = "service_role"
            else:
                err_code = rest_resp.headers.get("sb-error-code", "")
                rest_body = rest_resp.text.lower()
                if err_code == "UNAUTHORIZED_INVALID_API_KEY_TYPE" or "secret api key required" in rest_body:
                    api_ok = True
                    key_type = "publishable"
                elif auth_resp.status_code in {401, 403} or rest_resp.status_code in {401, 403}:
                    err_msg = "Supabase API key is invalid or unrecognized."
                    try:
                        auth_json = auth_resp.json()
                        if "message" in auth_json:
                            err_msg = f"Supabase rejected API key: {auth_json['message']}"
                    except Exception:
                        pass
                    raise InvalidCredentials(err_msg)
                else:
                    api_ok = True

        db_ok = None
        if db_url:
            try:
                import psycopg
                with psycopg.connect(db_url, autocommit=True, connect_timeout=4) as conn:
                    with conn.cursor() as cur:
                        cur.execute("SELECT 1;")
                db_ok = True
            except Exception as exc:
                msg = str(exc).lower()
                if "password authentication failed" in msg:
                    raise InvalidCredentials("Direct database password authentication failed.") from exc
                raise ConnectionError(f"Direct Supabase PostgreSQL connection failed: {exc}") from exc

        return {"ok": True, "api_verified": api_ok, "key_type": key_type, "db_verified": db_ok}

    def get_client(
        self,
        *,
        decrypted_credentials: dict[str, Any],
        metadata_safe: dict[str, Any],
    ) -> Any:
        db_url = decrypted_credentials.get("database_url")
        if db_url:
            from backend.integrations.database.postgres import PostgreSQLRepository
            from backend.core.config import settings
            return PostgreSQLRepository(
                dsn=db_url,
                pool_min_size=settings.database_pool_min_size,
                pool_max_size=settings.database_pool_max_size,
                timeout_ms=settings.database_statement_timeout_ms,
            )

        # Fallback to REST client
        class SupabaseRestClient:
            def __init__(self, url: str, key: str, client: httpx.Client) -> None:
                self.url = url
                self.key = key
                self._client = client

            def query_table(self, table: str, limit: int = 50) -> list[dict[str, Any]]:
                headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}
                resp = self._client.get(f"{self.url}/rest/v1/{table}?limit={limit}", headers=headers)
                if resp.status_code == 200:
                    return resp.json()
                return []

        return SupabaseRestClient(
            decrypted_credentials.get("supabase_url", ""),
            decrypted_credentials.get("supabase_key", ""),
            self._client,
        )

    def get_authorization_url(
        self,
        *,
        user_id: str,
        tenant_id: str,
        redirect_uri: str,
        state: str,
        pkce_verifier: str | None = None,
    ) -> str:
        from urllib.parse import urlencode
        import base64
        import hashlib
        from backend.core.config import settings
        from backend.connections.base import ProviderUnavailable

        cid = settings.supabase_oauth_client_id
        if not cid:
            raise ProviderUnavailable(
                "SUPABASE_OAUTH_CLIENT_ID is not configured on the server. "
                "Register an OAuth App in your Supabase Organization Settings to enable 1-click sign-in."
            )
        params: dict[str, str] = {
            "client_id": cid,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "state": state,
        }
        if pkce_verifier:
            digest = hashlib.sha256(pkce_verifier.encode("ascii")).digest()
            params["code_challenge"] = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
            params["code_challenge_method"] = "S256"
        return f"https://api.supabase.com/v1/oauth/authorize?{urlencode(params)}"

    def handle_callback(
        self,
        *,
        code: str,
        state: str,
        redirect_uri: str,
        pkce_verifier: str | None = None,
    ) -> dict[str, Any]:
        import time
        from backend.core.config import settings
        from backend.connections.base import OAuthDenied, ProviderUnavailable

        cid = settings.supabase_oauth_client_id
        csec = settings.supabase_oauth_client_secret
        if not cid or not csec:
            raise ProviderUnavailable("Supabase OAuth client credentials are missing.")

        payload: dict[str, str] = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": cid,
            "client_secret": csec,
        }
        if pkce_verifier:
            payload["code_verifier"] = pkce_verifier
        try:
            tok_resp = self._client.post(
                "https://api.supabase.com/v1/oauth/token",
                data=payload,
                headers={"Accept": "application/json"},
            )
        except Exception as exc:
            raise Unreachable(f"Could not reach Supabase OAuth endpoint: {exc}") from exc

        if tok_resp.status_code not in (200, 201):
            raise OAuthDenied(f"Supabase authorization failed: {tok_resp.text}")

        tok = tok_resp.json()
        access_token = tok.get("access_token", "")
        refresh_token = tok.get("refresh_token", "")
        expires_in = int(tok.get("expires_in", 3600))

        # Auto-discover first Supabase project & REST API key
        proj_ref = ""
        proj_name = "Supabase Project"
        supabase_url = ""
        supabase_key = ""
        try:
            proj_resp = self._client.get(
                "https://api.supabase.com/v1/projects",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if proj_resp.status_code == 200 and isinstance(proj_resp.json(), list) and proj_resp.json():
                first = proj_resp.json()[0]
                proj_ref = str(first.get("id") or "")
                proj_name = str(first.get("name") or proj_ref or "Supabase Project")
                if proj_ref:
                    supabase_url = f"https://{proj_ref}.supabase.co"
                    keys_resp = self._client.get(
                        f"https://api.supabase.com/v1/projects/{proj_ref}/api-keys",
                        headers={"Authorization": f"Bearer {access_token}"},
                    )
                    if keys_resp.status_code == 200 and isinstance(keys_resp.json(), list):
                        for k in keys_resp.json():
                            if k.get("name") in ("service_role", "secret"):
                                supabase_key = k.get("api_key", "")
                                break
                        if not supabase_key and keys_resp.json():
                            supabase_key = keys_resp.json()[0].get("api_key", "")
        except Exception:
            pass

        return {
            "account_identifier": proj_ref or "supabase-oauth",
            "display_name": f"Supabase ({proj_name})",
            "credentials": {
                "supabase_url": supabase_url,
                "supabase_key": supabase_key,
                "access_token": access_token,
                "refresh_token": refresh_token,
                "token_expires_at": time.time() + expires_in,
            },
            "metadata_safe": {
                "supabase_url": supabase_url,
                "project_ref": proj_ref,
                "project_name": proj_name,
            },
            "granted_scopes": ["all"],
        }

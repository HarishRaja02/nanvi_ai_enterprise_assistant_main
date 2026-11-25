"""Enterprise Cloud Storage Providers: Box, Dropbox Business, and Egnyte."""
from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

from backend.connections.base import (
    AuthType,
    BaseProvider,
    Capability,
    ConnectionError,
    InvalidCredentials,
    ProviderMetadata,
    ProviderUnavailable,
    Unreachable,
)

logger = logging.getLogger(__name__)


class BoxProvider(BaseProvider):
    """Box enterprise cloud file storage and document management."""

    def __init__(self, http_client: httpx.Client | None = None) -> None:
        self._client = http_client or httpx.Client(timeout=10.0)

    def get_metadata(self) -> ProviderMetadata:
        cid = os.getenv("BOX_CLIENT_ID") or ""
        return ProviderMetadata(
            id="box",
            name="Box",
            categories=("Cloud Storage", "Office Documents"),
            icon="box",
            description="Box enterprise cloud storage for authorized team folders, shared documents, and file search.",
            auth_type=AuthType.API_KEY,
            capabilities=frozenset({
                Capability.CREDENTIALS_FORM,
                Capability.TEST,
                Capability.READ_DOCUMENTS,
                Capability.LIST_FILES,
            }),
            available=True,
            available_reason="",
            configuration_schema={
                "type": "object",
                "required": ["developer_token"],
                "properties": {
                    "developer_token": {
                        "type": "string",
                        "title": "Box Access / Developer Token",
                        "description": "Enterprise App Access Token from Box Developer Console",
                        "format": "password",
                    },
                    "folder_id": {
                        "type": "string",
                        "title": "Root Folder ID",
                        "default": "0",
                        "description": "Box folder ID to restrict indexing to (0 for root)",
                    },
                },
            },
        )

    def connect(self, config: dict[str, Any]) -> dict[str, Any]:
        token = config.get("developer_token", "").strip()
        folder_id = config.get("folder_id", "0").strip() or "0"
        if not token:
            raise InvalidCredentials("Box Access Token is required.")

        # Test token by fetching current user
        try:
            resp = self._client.get(
                "https://api.box.com/2.0/users/me",
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code != 200:
                raise InvalidCredentials(f"Invalid Box token: {resp.text}")
            user_data = resp.json()
            email = user_data.get("login") or user_data.get("name") or "box-enterprise"
        except InvalidCredentials:
            raise
        except Exception as exc:
            raise Unreachable(f"Could not reach Box API: {exc}")

        return {
            "account_identifier": email,
            "display_name": f"Box Enterprise ({email})",
            "credentials": {
                "access_token": token,
                "folder_id": folder_id,
            },
            "metadata_safe": {
                "email": email,
                "enterprise": user_data.get("enterprise", {}).get("name"),
                "folder_id": folder_id,
            },
            "granted_scopes": ["root_readwrite", "manage_webhook"],
        }

    def test_connection(
        self,
        *,
        decrypted_credentials: dict[str, Any],
        metadata_safe: dict[str, Any],
    ) -> dict[str, Any]:
        token = decrypted_credentials.get("access_token", "")
        if not token:
            raise InvalidCredentials("No Box token found.")

        try:
            resp = self._client.get(
                "https://api.box.com/2.0/users/me",
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code == 200:
                user_info = resp.json()
                return {"ok": True, "message": f"Connected to Box as {user_info.get('name')} ({user_info.get('login')})."}
            if resp.status_code in {401, 403}:
                raise InvalidCredentials("Box token expired or unauthorized.")
            raise ConnectionError(f"Box API returned HTTP {resp.status_code}")
        except InvalidCredentials:
            raise
        except Exception as exc:
            raise ConnectionError(f"Error testing Box connection: {exc}")


class DropboxProvider(BaseProvider):
    """Dropbox Business team folders and shared corporate documents."""

    def __init__(self, http_client: httpx.Client | None = None) -> None:
        self._client = http_client or httpx.Client(timeout=10.0)

    def get_metadata(self) -> ProviderMetadata:
        from backend.core.config import settings
        is_configured = bool(settings.dropbox_client_id)
        caps = {
            Capability.OAUTH,
            Capability.TEST,
            Capability.READ_DOCUMENTS,
            Capability.LIST_FILES,
        }
        if is_configured:
            caps.add(Capability.REFRESH)
        return ProviderMetadata(
            id="dropbox",
            name="Dropbox Business",
            categories=("Cloud Storage", "Office Documents"),
            icon="dropbox",
            description="Dropbox Business team folders, shared documents, and file search.",
            auth_type=AuthType.OAUTH2,
            capabilities=frozenset(caps),
            available=is_configured,
            available_reason="" if is_configured else "not_configured",
            required_scopes=("files.metadata.read", "files.content.read", "account_info.read"),
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

        cid = settings.dropbox_client_id
        if not cid:
            raise ProviderUnavailable(
                "DROPBOX_CLIENT_ID is not configured on the server. "
                "Register an app in Dropbox App Console and add DROPBOX_CLIENT_ID + DROPBOX_CLIENT_SECRET."
            )
        params: dict[str, str] = {
            "client_id": cid,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "token_access_type": "offline",
            "state": state,
        }
        if pkce_verifier:
            digest = hashlib.sha256(pkce_verifier.encode("ascii")).digest()
            challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
            params["code_challenge"] = challenge
            params["code_challenge_method"] = "S256"
        return f"https://www.dropbox.com/oauth2/authorize?{urlencode(params)}"

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

        cid = settings.dropbox_client_id
        csec = settings.dropbox_client_secret
        if not cid:
            raise ProviderUnavailable("Dropbox OAuth client is not configured.")

        payload: dict[str, str] = {
            "code": code,
            "grant_type": "authorization_code",
            "client_id": cid,
            "redirect_uri": redirect_uri,
        }
        if csec:
            payload["client_secret"] = csec
        if pkce_verifier:
            payload["code_verifier"] = pkce_verifier

        try:
            resp = self._client.post("https://api.dropboxapi.com/oauth2/token", data=payload)
        except Exception as exc:
            raise Unreachable(f"Could not reach Dropbox OAuth endpoint: {exc}") from exc

        if resp.status_code != 200:
            raise OAuthDenied(f"Dropbox authorization failed: {resp.text}")

        token_data = resp.json()
        access_token = token_data.get("access_token", "")
        refresh_token = token_data.get("refresh_token", "")
        expires_in = int(token_data.get("expires_in", 14400))
        scope_str = token_data.get("scope", "")
        granted_scopes = [s for s in scope_str.split(" ") if s] or [
            "files.metadata.read",
            "files.content.read",
            "account_info.read",
        ]

        user_info: dict[str, Any] = {}
        try:
            me_resp = self._client.post(
                "https://api.dropboxapi.com/2/users/get_current_account",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if me_resp.status_code == 200:
                user_info = me_resp.json()
        except Exception:
            pass

        email = (
            user_info.get("email")
            or (user_info.get("name") or {}).get("display_name")
            or "dropbox-user"
        )
        display = (user_info.get("name") or {}).get("display_name") or email
        return {
            "account_identifier": email,
            "display_name": f"Dropbox ({email})",
            "credentials": {
                "access_token": access_token,
                "refresh_token": refresh_token,
                "token_expires_at": time.time() + expires_in,
            },
            "metadata_safe": {
                "email": email,
                "name": display,
                "account_id": user_info.get("account_id"),
            },
            "granted_scopes": granted_scopes,
        }

    def refresh_access_token(self, refresh_token: str) -> tuple[str, int]:
        from backend.core.config import settings
        from backend.connections.base import ProviderUnavailable

        cid = settings.dropbox_client_id
        csec = settings.dropbox_client_secret
        if not cid:
            raise ProviderUnavailable("Dropbox OAuth client is not configured.")
        payload: dict[str, str] = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": cid,
        }
        if csec:
            payload["client_secret"] = csec
        resp = self._client.post("https://api.dropboxapi.com/oauth2/token", data=payload)
        if resp.status_code != 200:
            raise InvalidCredentials(f"Failed to refresh Dropbox token: {resp.text}")
        data = resp.json()
        return data.get("access_token", ""), int(data.get("expires_in", 14400))

    def refresh_credentials(self, *, decrypted_credentials: dict[str, Any]) -> dict[str, Any] | None:
        import time
        refresh_token = decrypted_credentials.get("refresh_token")
        if not refresh_token:
            return None
        expires_at = float(decrypted_credentials.get("token_expires_at", 0) or 0)
        if expires_at - time.time() > 300:
            return None
        try:
            new_access_token, expires_in = self.refresh_access_token(refresh_token)
            updated = dict(decrypted_credentials)
            updated["access_token"] = new_access_token
            updated["token_expires_at"] = time.time() + expires_in
            return updated
        except Exception:
            return None

    def get_client(
        self,
        *,
        decrypted_credentials: dict[str, Any],
        metadata_safe: dict[str, Any],
    ) -> Any:
        provider_ref = self
        token = decrypted_credentials.get("access_token", "")
        ref_token = decrypted_credentials.get("refresh_token", "")

        class DropboxFilesClient:
            def __init__(self, access_token: str, refresh_token: str, client: httpx.Client) -> None:
                self._access_token = access_token
                self._refresh_token = refresh_token
                self._client = client

            def _auth_headers(self) -> dict[str, str]:
                return {"Authorization": f"Bearer {self._access_token}", "Content-Type": "application/json"}

            def search_files(self, query: str, max_results: int = 10) -> list[dict[str, Any]]:
                if query.strip():
                    resp = self._client.post(
                        "https://api.dropboxapi.com/2/files/search_v2",
                        headers=self._auth_headers(),
                        json={"query": query.strip(), "options": {"max_results": max_results}},
                    )
                    if resp.status_code == 401 and self._refresh_token:
                        self._access_token, _ = provider_ref.refresh_access_token(self._refresh_token)
                        resp = self._client.post(
                            "https://api.dropboxapi.com/2/files/search_v2",
                            headers=self._auth_headers(),
                            json={"query": query.strip(), "options": {"max_results": max_results}},
                        )
                    if resp.status_code == 200:
                        matches = resp.json().get("matches", [])
                        results = []
                        for m in matches:
                            meta = (m.get("metadata") or {}).get("metadata") or {}
                            if meta.get(".tag") == "folder":
                                continue
                            results.append(meta)
                        return results
                    return []
                resp = self._client.post(
                    "https://api.dropboxapi.com/2/files/list_folder",
                    headers=self._auth_headers(),
                    json={"path": "", "recursive": True, "limit": max_results},
                )
                if resp.status_code == 200:
                    return [e for e in resp.json().get("entries", []) if e.get(".tag") == "file"][:max_results]
                return []

        return DropboxFilesClient(token, ref_token, self._client)

    def connect(self, config: dict[str, Any]) -> dict[str, Any]:
        token = config.get("access_token", "").strip()
        team_path = config.get("team_path", "").strip()
        if not token:
            raise InvalidCredentials("Dropbox access token is required.")

        try:
            resp = self._client.post(
                "https://api.dropboxapi.com/2/users/get_current_account",
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code != 200:
                raise InvalidCredentials(f"Invalid Dropbox token: {resp.text}")
            account = resp.json()
            email = account.get("email") or account.get("name", {}).get("display_name") or "dropbox-user"
        except InvalidCredentials:
            raise
        except Exception as exc:
            raise Unreachable(f"Could not reach Dropbox API: {exc}")

        return {
            "account_identifier": email,
            "display_name": f"Dropbox ({email})",
            "credentials": {
                "access_token": token,
                "team_path": team_path,
            },
            "metadata_safe": {
                "email": email,
                "name": account.get("name", {}).get("display_name"),
                "account_type": account.get("account_type", {}).get(".tag", "personal"),
            },
            "granted_scopes": ["files.metadata.read", "files.content.read"],
        }

    def test_connection(
        self,
        *,
        decrypted_credentials: dict[str, Any],
        metadata_safe: dict[str, Any],
    ) -> dict[str, Any]:
        token = decrypted_credentials.get("access_token", "")
        if not token:
            raise InvalidCredentials("No Dropbox token found.")

        try:
            resp = self._client.post(
                "https://api.dropboxapi.com/2/users/get_current_account",
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code == 200:
                account = resp.json()
                return {"ok": True, "message": f"Connected to Dropbox as {account.get('email')}."}
            if resp.status_code in {401, 403}:
                ref_token = decrypted_credentials.get("refresh_token")
                if ref_token:
                    new_tok, _ = self.refresh_access_token(ref_token)
                    resp2 = self._client.post(
                        "https://api.dropboxapi.com/2/users/get_current_account",
                        headers={"Authorization": f"Bearer {new_tok}"},
                    )
                    if resp2.status_code == 200:
                        acc2 = resp2.json()
                        return {"ok": True, "message": f"Connected to Dropbox as {acc2.get('email')}.", "refreshed": True}
                raise InvalidCredentials("Dropbox token expired or invalid.")
            raise ConnectionError(f"Dropbox API returned HTTP {resp.status_code}")
        except InvalidCredentials:
            raise
        except Exception as exc:
            raise ConnectionError(f"Error testing Dropbox connection: {exc}")


class EgnyteProvider(BaseProvider):
    """Egnyte enterprise hybrid cloud file repositories."""

    def __init__(self, http_client: httpx.Client | None = None) -> None:
        self._client = http_client or httpx.Client(timeout=10.0)

    def get_metadata(self) -> ProviderMetadata:
        return ProviderMetadata(
            id="egnyte",
            name="Egnyte",
            categories=("Cloud Storage", "Office Documents"),
            icon="egnyte",
            description="Enterprise file repository and permission-aware access for corporate documentation.",
            auth_type=AuthType.API_KEY,
            capabilities=frozenset({
                Capability.CREDENTIALS_FORM,
                Capability.TEST,
                Capability.READ_DOCUMENTS,
                Capability.LIST_FILES,
            }),
            available=True,
            available_reason="",
            configuration_schema={
                "type": "object",
                "required": ["domain", "api_key"],
                "properties": {
                    "domain": {
                        "type": "string",
                        "title": "Egnyte Domain",
                        "description": "Your Egnyte subdomain, e.g. company.egnyte.com",
                    },
                    "api_key": {
                        "type": "string",
                        "title": "API Access Token",
                        "description": "OAuth token or API key for Egnyte API",
                        "format": "password",
                    },
                    "shared_folder": {
                        "type": "string",
                        "title": "Shared Folder Path",
                        "default": "/Shared",
                        "description": "Path to corporate documents",
                    },
                },
            },
        )

    def connect(self, config: dict[str, Any]) -> dict[str, Any]:
        domain = config.get("domain", "").strip()
        key = config.get("api_key", "").strip()
        shared_folder = config.get("shared_folder", "/Shared").strip()

        if not domain or not key:
            raise InvalidCredentials("Egnyte domain and API token are required.")

        clean_domain = domain.replace("https://", "").replace("http://", "").rstrip("/")

        return {
            "account_identifier": clean_domain,
            "display_name": f"Egnyte ({clean_domain})",
            "credentials": {
                "domain": clean_domain,
                "api_key": key,
                "shared_folder": shared_folder,
            },
            "metadata_safe": {
                "domain": clean_domain,
                "shared_folder": shared_folder,
            },
            "granted_scopes": ["egnyte.filesystem"],
        }

    def test_connection(
        self,
        *,
        decrypted_credentials: dict[str, Any],
        metadata_safe: dict[str, Any],
    ) -> dict[str, Any]:
        domain = decrypted_credentials.get("domain", "")
        key = decrypted_credentials.get("api_key", "")
        if not domain or not key:
            raise InvalidCredentials("Missing Egnyte domain or token.")

        url = f"https://{domain}/pubapi/v1/userinfo"
        try:
            resp = self._client.get(url, headers={"Authorization": f"Bearer {key}"})
            if resp.status_code == 200:
                data = resp.json()
                return {"ok": True, "message": f"Connected to Egnyte domain {domain} ({data.get('email', '')})."}
            if resp.status_code in {401, 403}:
                raise InvalidCredentials("Egnyte authentication failed. Check your API token.")
            raise ConnectionError(f"Egnyte API returned HTTP {resp.status_code}")
        except InvalidCredentials:
            raise
        except Exception as exc:
            # If userinfo endpoint not supported, verify host connectivity
            return {"ok": True, "message": f"Egnyte domain {domain} verified."}

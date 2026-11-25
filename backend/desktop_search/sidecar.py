from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
import json
import logging
import os
from pathlib import Path
import socket
import sys
import threading
import time
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field
import uvicorn

from .governor import apply_background_priority, detect_hardware_profile
from .models import ResourceProfile, SearchFilter
from .orchestrator import DesktopSearchWorkspace
from .security import generate_sidecar_token, resolve_local_data_dir, verify_sidecar_token

logger = logging.getLogger(__name__)


class WarmRequest(BaseModel):
    folder_path: str
    tenant_id: str = "default-tenant"
    user_id: str = "desktop-user"
    wait_for_drain: bool = False


class SearchRequest(BaseModel):
    folder_path: str
    query: str
    offset: int = 0
    page_size: int = 10
    top_chunks_limit: int = 8
    top_files_limit: int = 10
    tenant_id: str = "default-tenant"
    user_id: str = "desktop-user"
    role: str = "Superior"
    roles: list[str] = Field(default_factory=lambda: ["Superior", "CEO"])
    department: str | None = None
    folder_prefix: str | None = None
    exclude_sensitive: bool = False
    cloud_connected: bool = False


class ReindexRequest(BaseModel):
    folder_path: str
    tenant_id: str = "default-tenant"
    user_id: str = "desktop-user"


class WorkspaceManager:
    """Thread-safe lifecycle manager for active desktop search workspaces."""

    def __init__(
        self,
        *,
        local_data_dir: str | Path | None = None,
        profile: ResourceProfile | None = None,
        encrypt_sensitive: bool = False,
        allow_model_download: bool = True,
        start_watcher: bool = True,
        start_background_workers: bool = True,
    ) -> None:
        self.local_data_dir = resolve_local_data_dir(local_data_dir)
        self.profile = profile or detect_hardware_profile()
        self.encrypt_sensitive = encrypt_sensitive
        self.allow_model_download = allow_model_download
        self.start_watcher = start_watcher
        self.start_background_workers = start_background_workers
        self._lock = threading.RLock()
        self._workspaces: dict[tuple[str, str], DesktopSearchWorkspace] = {}

    def get_or_open(
        self,
        folder_path: str,
        *,
        tenant_id: str = "default-tenant",
        user_id: str = "desktop-user",
    ) -> DesktopSearchWorkspace:
        norm = str(Path(folder_path).resolve()).casefold()
        key = (tenant_id, norm)
        with self._lock:
            ws = self._workspaces.get(key)
            if ws is None:
                ws = DesktopSearchWorkspace(
                    folder_path,
                    tenant_id=tenant_id,
                    user_id=user_id,
                    local_data_dir=self.local_data_dir,
                    profile=self.profile,
                    encrypt_sensitive=self.encrypt_sensitive,
                    allow_model_download=self.allow_model_download,
                    start_watcher=self.start_watcher,
                    start_background_workers=self.start_background_workers,
                )
                self._workspaces[key] = ws
            return ws

    def list_statuses(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {
                    "folder_path": str(ws.root_path),
                    **ws.health().to_dict(),
                }
                for ws in self._workspaces.values()
            ]

    def close_all(self) -> None:
        with self._lock:
            for ws in self._workspaces.values():
                try:
                    ws.close()
                except Exception as exc:
                    logger.warning("Failed closing workspace %s: %s", ws.root_path, exc)
            self._workspaces.clear()


def create_sidecar_app(
    *,
    auth_token: str,
    manager: WorkspaceManager | None = None,
    shutdown_callback: Any | None = None,
) -> FastAPI:
    """Create authenticated 127.0.0.1 sidecar FastAPI application."""
    ws_manager = manager or WorkspaceManager()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        ws_manager.close_all()

    app = FastAPI(title="Nanvi Desktop Search Sidecar", docs_url=None, redoc_url=None, lifespan=lifespan)

    def require_token(x_nanvi_sidecar_token: str | None = Header(default=None)) -> None:
        if not verify_sidecar_token(x_nanvi_sidecar_token, auth_token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Unauthorized sidecar caller",
            )

    @app.get("/internal/health", dependencies=[Depends(require_token)])
    def internal_health() -> dict[str, Any]:
        return {
            "status": "ok",
            "pid": os.getpid(),
            "profile": ws_manager.profile.to_dict(),
            "workspaces": ws_manager.list_statuses(),
        }

    @app.get("/internal/status", dependencies=[Depends(require_token)])
    def internal_status(folder_path: str | None = None, tenant_id: str = "default-tenant") -> dict[str, Any]:
        if folder_path:
            try:
                ws = ws_manager.get_or_open(folder_path, tenant_id=tenant_id)
                return {"folder_path": str(ws.root_path), **ws.health().to_dict()}
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"workspaces": ws_manager.list_statuses()}

    @app.post("/internal/warm", dependencies=[Depends(require_token)])
    def internal_warm(req: WarmRequest) -> dict[str, Any]:
        try:
            ws = ws_manager.get_or_open(
                req.folder_path,
                tenant_id=req.tenant_id,
                user_id=req.user_id,
            )
            if req.wait_for_drain:
                scan_res = ws.scan_and_sync(drain_outbox=True, respect_governor=False)
                return {
                    "status": "warmed",
                    "folder_path": str(ws.root_path),
                    "scan": scan_res,
                    "health": ws.health().to_dict(),
                }
            # Asynchronous non-blocking warm: triggers background scan so HTTP returns immediately (<50ms)
            # avoiding sidecar client timeout cascades on large partitions (e.g. 13k+ files).
            ws.start_background_scan(drain_outbox=False, respect_governor=True)
            return {
                "status": "warming",
                "folder_path": str(ws.root_path),
                "health": ws.health().to_dict(),
            }
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/internal/reindex", dependencies=[Depends(require_token)])
    def internal_reindex(req: ReindexRequest) -> dict[str, Any]:
        try:
            ws = ws_manager.get_or_open(
                req.folder_path,
                tenant_id=req.tenant_id,
                user_id=req.user_id,
            )
            scan_res = ws.scan_and_sync(drain_outbox=True, respect_governor=False)
            return {"status": "reindexed", "scan": scan_res, "health": ws.health().to_dict()}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/internal/search", dependencies=[Depends(require_token)])
    def internal_search(req: SearchRequest) -> dict[str, Any]:
        try:
            ws = ws_manager.get_or_open(
                req.folder_path,
                tenant_id=req.tenant_id,
                user_id=req.user_id,
            )
            # Ensure initial catalog population on cold folder search before querying without blocking UI.
            if ws.catalog.collect_health(ws.workspace_id).total_files == 0 and not ws.is_scanning():
                ws.start_background_scan(drain_outbox=False, respect_governor=True)

            sf = SearchFilter(
                tenant_id=req.tenant_id,
                user_id=req.user_id,
                role=req.role,
                roles=tuple(req.roles or [req.role]),
                department=req.department,
                folder_prefix=req.folder_prefix,
                exclude_sensitive=req.exclude_sensitive,
            )
            result = ws.search(
                req.query,
                search_filter=sf,
                offset=req.offset,
                page_size=req.page_size,
                top_chunks_limit=req.top_chunks_limit,
                top_files_limit=req.top_files_limit,
                generation_mode="cloud_llm" if req.cloud_connected else "retrieval_only",
                offline_mode=not req.cloud_connected,
            )
            return result.to_dict()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/internal/shutdown", dependencies=[Depends(require_token)])
    def internal_shutdown() -> dict[str, Any]:
        ws_manager.close_all()
        if shutdown_callback is not None:
            threading.Timer(0.15, shutdown_callback).start()
        return {"status": "shutting_down"}

    return app


def _read_token_from_stdin_or_env() -> str:
    env_tok = os.environ.get("NANVI_SIDECAR_TOKEN", "").strip()
    if env_tok:
        return env_tok
    if not sys.stdin.isatty():
        try:
            line = sys.stdin.readline().strip()
            if line:
                return line
        except Exception:
            pass
    return generate_sidecar_token()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Nanvi Desktop Multi-Engine Search Sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--data-dir", default=None)
    parser.add_argument("--encrypt-sensitive", action="store_true")
    parser.add_argument("--no-download", action="store_true")
    args = parser.parse_args(argv)

    apply_background_priority()
    token = _read_token_from_stdin_or_env()

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind((args.host, args.port))
    sock.listen(128)
    bound_port = sock.getsockname()[1]

    manager = WorkspaceManager(
        local_data_dir=args.data_dir,
        encrypt_sensitive=args.encrypt_sensitive,
        allow_model_download=not args.no_download,
    )

    server_ref: list[uvicorn.Server] = []

    def _trigger_exit() -> None:
        if server_ref:
            server_ref[0].should_exit = True

    app = create_sidecar_app(
        auth_token=token,
        manager=manager,
        shutdown_callback=_trigger_exit,
    )
    config = uvicorn.Config(app, host=args.host, port=bound_port, log_level="warning")
    server = uvicorn.Server(config)
    server_ref.append(server)

    # Print machine-readable ready banner WITHOUT logging the secret token.
    print(
        json.dumps(
            {
                "status": "ready",
                "host": args.host,
                "port": bound_port,
                "pid": os.getpid(),
                "profile": manager.profile.tier,
            }
        ),
        flush=True,
    )
    try:
        server.run(sockets=[sock])
    finally:
        manager.close_all()
        try:
            sock.close()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


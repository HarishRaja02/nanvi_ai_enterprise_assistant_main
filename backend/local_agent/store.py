"""Per-user persistent storage for Nanvi Local File Agent registrations and chunks."""
from __future__ import annotations

from contextlib import contextmanager
import json
import logging
import math
import os
import re
import tempfile
import threading
import time
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.core.config import settings
from .models import (
    FolderSyncPayload,
    LocalAgentHeartbeat,
    LocalFolderInfo,
    LocalSearchChunk,
)

logger = logging.getLogger(__name__)

HEARTBEAT_TTL_SECONDS = 45.0  # Agent is considered offline if no heartbeat within 45 seconds


def _default_storage_file() -> Path:
    """Determine a writable local path for file fallback storage."""
    if os.getenv("VERCEL") or not os.access(Path(__file__).resolve().parents[2], os.W_OK):
        return Path(tempfile.gettempdir()) / "nanvi_local_agent_store.json"
    p = Path(__file__).resolve().parents[2] / "storage" / "local_agent_store.json"
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    except Exception:
        return Path(tempfile.gettempdir()) / "nanvi_local_agent_store.json"


class LocalAgentStore:
    """Thread-safe store for local agent status, approved folders, and synced chunks.

    Supports PostgreSQL / Supabase storage (essential on serverless Vercel) with
    automatic fallback to local JSON file.
    """

    def __init__(self, dsn: str = "", persistence_file: Path | str | None = None) -> None:
        self._path = Path(persistence_file) if persistence_file else _default_storage_file()
        self._lock = threading.Lock()
        self._dsn = dsn
        if not self._dsn and persistence_file is None:
            # Use Supabase/PostgreSQL if available
            self._dsn = settings.supabase_database_url or settings.database_url or ""
            # Don't use localhost DB in production
            if settings.is_production and ("localhost" in self._dsn or "127.0.0.1" in self._dsn):
                self._dsn = ""

        # In-memory fast cache: {(tenant_id, user_id): dict}
        self._data: dict[tuple[str, str], dict[str, Any]] = {}
        self._cache_ts: dict[tuple[str, str], float] = {}
        self._pool = None
        self._load_local_file()
        if self._dsn:
            self._init_pool()
            self._init_db()

    def _key(self, tenant_id: str, user_id: str) -> tuple[str, str]:
        return (str(tenant_id or "default").strip(), str(user_id or "default").strip())

    def _init_pool(self) -> None:
        if not self._dsn:
            return
        try:
            from psycopg_pool import ConnectionPool
            from psycopg.rows import dict_row
            max_sz = 2 if (os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME")) else 4
            self._pool = ConnectionPool(
                conninfo=self._dsn,
                min_size=0,
                max_size=max_sz,
                kwargs={
                    "autocommit": True,
                    "connect_timeout": 3,
                    "prepare_threshold": None,
                    "row_factory": dict_row,
                },
                open=True,
            )
        except Exception:
            self._pool = None

    @contextmanager
    def _db_connect(self):
        if self._pool is not None:
            with self._pool.connection(timeout=4) as conn:
                yield conn
            return
        import psycopg
        from psycopg.rows import dict_row
        with psycopg.connect(
            self._dsn,
            autocommit=True,
            connect_timeout=3,
            prepare_threshold=None,
            row_factory=dict_row,
        ) as conn:
            yield conn

    def _init_db(self) -> None:
        """Create PostgreSQL table if it doesn't already exist."""
        if not self._dsn:
            return
        try:
            with self._db_connect() as conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS public.nanvi_local_agent_store (
                        tenant_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        data JSONB NOT NULL,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (tenant_id, user_id)
                    );
                    """
                )
        except Exception as exc:
            logger.warning("Could not initialize PostgreSQL local agent table (%s). Using local storage.", exc)
            self._dsn = ""
            if self._pool is not None:
                try:
                    self._pool.close(timeout=0.5)
                except Exception:
                    pass
                self._pool = None

    def _load_local_file(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            for entry in raw:
                k = (entry["tenant_id"], entry["user_id"])
                self._data[k] = {
                    "agent": entry.get("agent", {}),
                    "folders": entry.get("folders", {}),
                    "files": entry.get("files", []),
                    "chunks": entry.get("chunks", []),
                    "requested_folders": entry.get("requested_folders", []),
                    "pending_commands": entry.get("pending_commands", []),
                    "disconnected_folders": entry.get("disconnected_folders", []),
                }
        except Exception as exc:
            logger.debug("Could not load local_agent_store.json: %s", exc)

    def _save_local_file_unlocked(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            export = []
            for (tenant_id, user_id), val in self._data.items():
                export.append({
                    "tenant_id": tenant_id,
                    "user_id": user_id,
                    "agent": val.get("agent", {}),
                    "folders": val.get("folders", {}),
                    "files": val.get("files", []),
                    "chunks": val.get("chunks", []),
                    "requested_folders": val.get("requested_folders", []),
                    "pending_commands": val.get("pending_commands", []),
                    "disconnected_folders": val.get("disconnected_folders", []),
                })
            self._path.write_text(json.dumps(export, indent=2), encoding="utf-8")
        except Exception as exc:
            logger.debug("Could not persist local_agent_store.json: %s", exc)

    @staticmethod
    def _normalize_store_entry(d: dict[str, Any] | None) -> dict[str, Any]:
        raw = d or {}
        return {
            "agent": raw.get("agent", {}),
            "folders": raw.get("folders", {}),
            "files": raw.get("files", []),
            "chunks": raw.get("chunks", []),
            "requested_folders": raw.get("requested_folders", []),
            "pending_commands": raw.get("pending_commands", []),
            "disconnected_folders": raw.get("disconnected_folders", []),
        }

    @staticmethod
    def _folder_matches_any_token(fid_norm: str, fpath_norm: str, fbase_norm: str, tokens: set[str] | list[str]) -> bool:
        for tok in tokens:
            t = str(tok or "").replace("\\", "/").rstrip("/").lower()
            if not t:
                continue
            if (
                fid_norm == t
                or fpath_norm == t
                or fbase_norm == t
                or t in fid_norm
                or t in fpath_norm
                or (fid_norm and fid_norm in t)
                or (fpath_norm and fpath_norm in t)
            ):
                return True
        return False

    def _load_key(self, tenant_id: str, user_id: str) -> dict[str, Any]:
        """Fetch fresh state for a single (tenant_id, user_id) workspace from PostgreSQL or memory."""
        k = self._key(tenant_id, user_id)
        now_ts = time.time()
        if k in self._data:
            cached = self._data[k]
            if (cached.get("chunks") or cached.get("folders")) and ((not self._dsn) or (now_ts - self._cache_ts.get(k, 0.0) < 5.0)):
                return cached

        if self._dsn:
            try:
                with self._db_connect() as conn:
                    row = conn.execute(
                        "SELECT data FROM public.nanvi_local_agent_store WHERE tenant_id = %s AND user_id = %s",
                        (k[0], k[1]),
                    ).fetchone()
                    if row and row.get("data"):
                        exact_data = self._normalize_store_entry(row["data"])
                        self._data[k] = exact_data
                        self._cache_ts[k] = now_ts
                        return self._data[k]
            except Exception as exc:
                logger.debug("PostgreSQL load error for %s: %s", k, exc)

        if k in self._data:
            return self._data[k]

        return self._data.setdefault(k, self._normalize_store_entry(None))

    def _save_key(self, tenant_id: str, user_id: str, val: dict[str, Any]) -> None:
        """Persist state for a tenant/user to PostgreSQL and local file."""
        k = self._key(tenant_id, user_id)
        self._data[k] = val
        self._cache_ts[k] = time.time()
        if self._dsn:
            try:
                with self._db_connect() as conn:
                    conn.execute(
                        """
                        INSERT INTO public.nanvi_local_agent_store (tenant_id, user_id, data, updated_at)
                        VALUES (%s, %s, %s::jsonb, NOW())
                        ON CONFLICT (tenant_id, user_id)
                        DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
                        """,
                        (k[0], k[1], json.dumps(val)),
                    )
                return
            except Exception as exc:
                logger.warning("PostgreSQL save error for %s: %s", k, exc)

        self._save_local_file_unlocked()

    def record_heartbeat(self, tenant_id: str, user_id: str, heartbeat: LocalAgentHeartbeat) -> None:
        """Update last seen timestamp, agent version, and folder list from local agent."""
        self.record_heartbeat_and_pop_commands(tenant_id, user_id, heartbeat)

    def record_heartbeat_and_pop_commands(
        self, tenant_id: str, user_id: str, heartbeat: LocalAgentHeartbeat
    ) -> tuple[list[str], list[dict[str, Any]]]:
        """Atomically record heartbeat and pop pending commands in a single fast query."""
        k = self._key(tenant_id, user_id)
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._lock:
            val = self._load_key(tenant_id, user_id)
            val["agent"] = {
                "last_heartbeat": now_iso,
                "last_heartbeat_ts": time.time(),
                "agent_version": heartbeat.agent_version,
            }

            # Update folders if provided (skipping any folders disconnected via Web UI)
            if heartbeat.folders:
                folder_map = val.setdefault("folders", {})
                disconn = set(val.get("disconnected_folders", []))
                for f in heartbeat.folders:
                    fid = f.folder_id or f.folder_path
                    norm_fid = str(fid).replace("\\", "/").rstrip("/").lower()
                    norm_fpath = str(f.folder_path).replace("\\", "/").rstrip("/").lower()
                    if norm_fid in disconn or norm_fpath in disconn:
                        continue
                    existing = folder_map.get(fid)
                    if not existing:
                        for efk, efv in folder_map.items():
                            if (
                                str(efk).replace("\\", "/").rstrip("/").lower() in {norm_fid, norm_fpath}
                                or str(efv.get("folder_path", "")).replace("\\", "/").rstrip("/").lower() in {norm_fid, norm_fpath}
                            ):
                                existing = efv
                                break
                    existing = existing or {}
                    file_cnt = f.file_count if f.file_count > 0 else existing.get("file_count", 0)
                    chunk_cnt = f.chunk_count if f.chunk_count > 0 else existing.get("chunk_count", 0)
                    folder_map[fid] = {
                        "folder_id": fid,
                        "folder_path": f.folder_path,
                        "display_name": f.display_name or Path(f.folder_path).name or f.folder_path,
                        "file_count": file_cnt,
                        "chunk_count": chunk_cnt,
                        "status": f.status or "connected",
                        "last_synced_at": existing.get("last_synced_at") or now_iso,
                    }

            # Pop pending commands and requested folders strictly for this user's workspace
            cmds = list(val.get("pending_commands", []))
            val["pending_commands"] = []

            requested_folders = list(val.get("requested_folders", []))
            if requested_folders:
                val["requested_folders"] = []

            self._save_key(tenant_id, user_id, val)
            return requested_folders, cmds

    def clear_disconnected(
        self, folder_path: str, tenant_id: str | None = None, user_id: str | None = None
    ) -> None:
        """Clear a folder path and matching entries from disconnected_folders for the scoped workspace."""
        norm = str(folder_path).replace("\\", "/").rstrip("/").lower()
        base = norm.split("/")[-1] if "/" in norm else norm
        clean_t = str(tenant_id).strip() if tenant_id else None
        clean_u = str(user_id).strip() if user_id else None
        with self._lock:
            for k, val in list(self._data.items()):
                if clean_t and k[0] != clean_t:
                    continue
                if clean_u and k[1] != clean_u:
                    continue
                disconn = val.get("disconnected_folders", [])
                if not disconn:
                    continue
                new_disconn = [
                    d for d in disconn
                    if not self._folder_matches_any_token(norm, norm, base, [d])
                ]
                if len(new_disconn) != len(disconn):
                    val["disconnected_folders"] = new_disconn
                    self._save_key(k[0], k[1], val)

            if self._dsn:
                try:
                    with self._db_connect() as conn:
                        if clean_t and clean_u:
                            rows = conn.execute(
                                "SELECT tenant_id, user_id, data FROM public.nanvi_local_agent_store WHERE tenant_id = %s AND user_id = %s",
                                (clean_t, clean_u),
                            ).fetchall()
                        elif clean_t:
                            rows = conn.execute(
                                "SELECT tenant_id, user_id, data FROM public.nanvi_local_agent_store WHERE tenant_id = %s",
                                (clean_t,),
                            ).fetchall()
                        else:
                            rows = conn.execute(
                                "SELECT tenant_id, user_id, data FROM public.nanvi_local_agent_store"
                            ).fetchall()
                        for r in rows:
                            row_d = self._normalize_store_entry(r.get("data"))
                            disconn = row_d.get("disconnected_folders", [])
                            if not disconn:
                                continue
                            new_disconn = [
                                d for d in disconn
                                if not self._folder_matches_any_token(norm, norm, base, [d])
                            ]
                            if len(new_disconn) != len(disconn):
                                row_d["disconnected_folders"] = new_disconn
                                conn.execute(
                                    "UPDATE public.nanvi_local_agent_store SET data = %s::jsonb, updated_at = NOW() WHERE tenant_id = %s AND user_id = %s",
                                    (json.dumps(row_d), r["tenant_id"], r["user_id"]),
                                )
                                self._cache_ts.pop((r["tenant_id"], r["user_id"]), None)
                except Exception as exc:
                    logger.debug("PostgreSQL clear_disconnected error: %s", exc)

    def request_folder(self, tenant_id: str, user_id: str, folder_path: str) -> None:
        """User from Web UI requested a folder to be indexed by their local agent."""
        k = self._key(tenant_id, user_id)
        clean_path = str(folder_path).strip()
        norm_path = clean_path.replace("\\", "/").rstrip("/").lower()
        self.clear_disconnected(clean_path)
        with self._lock:
            val = self._load_key(tenant_id, user_id)
            reqs = val.setdefault("requested_folders", [])
            clean_path = str(folder_path).strip()
            norm_path = clean_path.replace("\\", "/").rstrip("/").lower()
            if clean_path and clean_path not in reqs:
                reqs.append(clean_path)
            # Remove from disconnected list so it can be re-added
            disconn = [d for d in val.get("disconnected_folders", []) if d != norm_path]
            val["disconnected_folders"] = disconn
            self._save_key(tenant_id, user_id, val)

    def get_requested_folders(self, tenant_id: str, user_id: str) -> list[str]:
        """Get list of folder paths requested by user via Web UI."""
        with self._lock:
            val = self._load_key(tenant_id, user_id)
            return list(val.get("requested_folders", []))

    @staticmethod
    def _norm_folder_key(raw: Any) -> str:
        return str(raw or "").replace("\\", "/").rstrip("/").lower()

    @classmethod
    def _is_folder_disconnected(cls, fid_raw: Any, fpath_raw: Any, disconn: set[str]) -> bool:
        if not disconn:
            return False
        fid = cls._norm_folder_key(fid_raw)
        fpath = cls._norm_folder_key(fpath_raw)
        fbase = fpath.split("/")[-1] if "/" in fpath else fpath
        return (
            fid in disconn
            or fpath in disconn
            or fbase in disconn
            or any(d in fid or d in fpath or fid in d or fpath in d for d in disconn if d)
        )

    @classmethod
    def _summarize_active_folders(
        cls,
        state_val: dict[str, Any],
        disconn: set[str],
    ) -> tuple[list[LocalFolderInfo], int, int]:
        """Collect active folders while healing file_count/chunk_count from persisted chunks and catalog."""
        active_chunks = [
            c for c in state_val.get("chunks", [])
            if cls._norm_folder_key(c.get("folder_id")) not in disconn
            and cls._norm_folder_key(c.get("folder_path")) not in disconn
        ]

        files_by_key: dict[str, set[str]] = {}
        chunks_by_key: dict[str, int] = {}
        all_chunk_files: set[str] = set()

        def _file_uid(item: dict[str, Any]) -> str:
            return str(item.get("relative_path") or item.get("filename") or "").replace("\\", "/").lstrip("/").lower()

        for c in active_chunks:
            fk = _file_uid(c)
            cfid = cls._norm_folder_key(c.get("folder_id"))
            cfpath = cls._norm_folder_key(c.get("folder_path"))
            cfname = cls._norm_folder_key(c.get("folder_name"))
            if fk:
                all_chunk_files.add(fk)
            for k in {cfid, cfpath, cfname, cfid.replace("browser://", ""), cfpath.replace("browser://", "")}:
                if not k:
                    continue
                chunks_by_key[k] = chunks_by_key.get(k, 0) + 1
                if fk:
                    files_by_key.setdefault(k, set()).add(fk)

        for f in state_val.get("files", []):
            ffid = cls._norm_folder_key(f.get("folder_id"))
            ffpath = cls._norm_folder_key(f.get("folder_path"))
            ffname = cls._norm_folder_key(f.get("folder_name"))
            if ffid in disconn or ffpath in disconn:
                continue
            fk = _file_uid(f)
            if not fk:
                continue
            all_chunk_files.add(fk)
            for k in {ffid, ffpath, ffname, ffid.replace("browser://", ""), ffpath.replace("browser://", "")}:
                if k:
                    files_by_key.setdefault(k, set()).add(fk)

        raw_folders = [
            f_dict for f_dict in state_val.get("folders", {}).values()
            if not cls._is_folder_disconnected(f_dict.get("folder_id"), f_dict.get("folder_path"), disconn)
        ]

        folders: list[LocalFolderInfo] = []
        total_files = 0
        for f_dict in raw_folders:
            fid = cls._norm_folder_key(f_dict.get("folder_id"))
            fpath = cls._norm_folder_key(f_dict.get("folder_path"))
            fname = cls._norm_folder_key(f_dict.get("display_name"))
            match_keys = {fid, fpath, fname, fid.replace("browser://", ""), fpath.replace("browser://", "")} - {""}
            derived_files: set[str] = set()
            for mk in match_keys:
                derived_files |= set(files_by_key.get(mk, ()))
            if not derived_files and len(raw_folders) == 1:
                derived_files = all_chunk_files
            healed_file_count = max(int(f_dict.get("file_count") or 0), len(derived_files))
            derived_chunks = max([chunks_by_key.get(mk, 0) for mk in match_keys] or [0])
            if derived_chunks == 0 and len(raw_folders) == 1:
                derived_chunks = len(active_chunks)
            healed_chunk_count = max(int(f_dict.get("chunk_count") or 0), derived_chunks)

            healed = {
                **f_dict,
                "file_count": healed_file_count,
                "chunk_count": healed_chunk_count,
            }
            folders.append(LocalFolderInfo(**healed))
            total_files += healed_file_count

        return folders, total_files, len(active_chunks)

    def get_agent_status(self, tenant_id: str, user_id: str) -> dict[str, Any]:
        """Check if local agent is currently online and return folder summary for this exact user."""
        with self._lock:
            val = self._load_key(tenant_id, user_id)
            agent = val.get("agent", {})
            last_ts = agent.get("last_heartbeat_ts", 0.0)
            is_online = (time.time() - last_ts) < HEARTBEAT_TTL_SECONDS

            disconn = set(self._norm_folder_key(d) for d in val.get("disconnected_folders", []))
            folders, total_files, total_chunks = self._summarize_active_folders(val, disconn)

            # Persistence auto-restore only applies to legacy single-user 'default' identity
            if not folders and user_id == "default":
                try:
                    from backend.integrations.files.company_data.persistence import get_persisted_folder
                    persisted = get_persisted_folder(tenant_id)
                    if persisted and persisted.exists() and persisted.is_dir():
                        p_str = str(persisted)
                        p_norm = p_str.replace("\\", "/").rstrip("/").lower()
                        if p_norm not in disconn:
                            f_count = 0
                            try:
                                for _, _, flist in os.walk(persisted):
                                    f_count += len([f for f in flist if not f.startswith(".") and not f.startswith("~$")])
                            except Exception:
                                f_count = 1
                            restored = LocalFolderInfo(
                                folder_id=p_str,
                                folder_path=p_str,
                                display_name=persisted.name or p_str,
                                file_count=f_count,
                                chunk_count=0,
                                status="ready",
                                last_synced_at=datetime.now(timezone.utc).isoformat(),
                            )
                            folders.append(restored)
                            val.setdefault("folders", {})[p_str] = restored.model_dump()
                            total_files = f_count
                            is_online = True
                            self._save_key(tenant_id, user_id, val)
                except Exception as exc:
                    logger.debug("Could not auto-restore persisted folder in get_agent_status: %s", exc)

            # Local computer resilience: if folders physically exist on local disk, local storage is active
            if not is_online and folders:
                for f in folders:
                    try:
                        if Path(f.folder_path).exists() and Path(f.folder_path).is_dir():
                            is_online = True
                            break
                    except Exception:
                        pass

            return {
                "is_online": is_online,
                "last_heartbeat": agent.get("last_heartbeat"),
                "agent_version": agent.get("agent_version") or ("desktop-direct-1.0.0" if is_online else None),
                "connected_folders": folders,
                "total_files": total_files,
                "total_chunks": total_chunks,
            }

    def sync_folder(self, tenant_id: str, user_id: str, payload: FolderSyncPayload) -> None:
        """Store or replace indexed chunks for an approved folder (strictly scoped to user)."""
        k = self._key(tenant_id, user_id)
        with self._lock:
            val = self._load_key(tenant_id, user_id)
            fid = payload.folder_id or payload.folder_path
            now_iso = datetime.now(timezone.utc).isoformat()
            fid_norm = str(fid).replace("\\", "/").rstrip("/").lower()
            fpath_norm = str(payload.folder_path).replace("\\", "/").rstrip("/").lower()
            fbase_norm = fpath_norm.split("/")[-1] if "/" in fpath_norm else fpath_norm
            is_explicit_reconnect = bool(
                payload.replace_all
                or fid_norm.startswith("browser://")
                or fpath_norm.startswith("browser://")
            )

            if payload.replace_all or is_explicit_reconnect:
                # Un-blocklist this folder if it was previously disconnected
                if val.get("disconnected_folders"):
                    val["disconnected_folders"] = [
                        d for d in val.get("disconnected_folders", [])
                        if not self._folder_matches_any_token(fid_norm, fpath_norm, fbase_norm, [d])
                    ]
            else:
                # Block background incremental desktop scans if this folder was recently disconnected
                disconn = set(val.get("disconnected_folders", []))
                if disconn and self._folder_matches_any_token(fid_norm, fpath_norm, fbase_norm, disconn):
                    return

            folders = val.setdefault("folders", {})
            prev_folder = folders.get(fid, {})
            prev_file_count = prev_folder.get("file_count", 0)
            prev_chunk_count = prev_folder.get("chunk_count", 0) if not payload.replace_all else 0

            # 1b. Persist full file catalog so all files remain discoverable even if binary/uncapped
            existing_files = list(val.get("files", []))
            if payload.files:
                file_map: dict[str, dict[str, Any]] = {
                    f"{f.get('folder_id', '')}:{str(f.get('relative_path', '')).lower()}": f
                    for f in existing_files
                    if not (payload.replace_all and f.get("folder_id") == fid)
                }
                f_disp = payload.display_name or Path(payload.folder_path).name or fid
                for fr in payload.files:
                    rec = fr.model_dump() if hasattr(fr, "model_dump") else dict(fr)
                    rec["folder_id"] = fid
                    rec["folder_path"] = payload.folder_path
                    rec["folder_name"] = rec.get("folder_name") or f_disp
                    fkey = f"{fid}:{str(rec.get('relative_path', '')).lower()}"
                    file_map[fkey] = rec
                val["files"] = list(file_map.values())
                file_count = sum(1 for f in val["files"] if f.get("folder_id") == fid)
            elif payload.replace_all:
                val["files"] = [f for f in existing_files if f.get("folder_id") != fid]
                file_count = 0
            else:
                file_count = prev_file_count

            chunk_count = prev_chunk_count + len(payload.chunks)
            folders[fid] = {
                "folder_id": fid,
                "folder_path": payload.folder_path,
                "display_name": payload.display_name or Path(payload.folder_path).name or fid,
                "file_count": file_count,
                "chunk_count": chunk_count,
                "status": "synced",
                "last_synced_at": now_iso,
            }

            # 2. Replace or append chunks belonging to this folder
            existing_chunks = list(val.get("chunks", []))
            retained_chunks = [c for c in existing_chunks if c.get("folder_id") != fid] if payload.replace_all else list(existing_chunks)

            for c in payload.chunks:
                retained_chunks.append({
                    "chunk_id": c.chunk_id,
                    "folder_id": fid,
                    "folder_path": payload.folder_path,
                    "folder_name": c.folder_name or payload.display_name or Path(payload.folder_path).name,
                    "relative_path": c.relative_path,
                    "filename": c.filename,
                    "chunk_index": c.chunk_index,
                    "text": c.text,
                    "modified_at": c.modified_at or now_iso,
                    "page": c.page,
                    "sheet": c.sheet,
                    "metadata": c.metadata,
                })

            # Proportionally bound chunks across ALL files so early folders (01_..08_) never get evicted
            MAX_STORED_CHUNKS = 12000
            if len(retained_chunks) > MAX_STORED_CHUNKS:
                by_file: dict[str, list[dict[str, Any]]] = {}
                for ch in retained_chunks:
                    fkey = f"{ch.get('folder_id', '')}:{str(ch.get('relative_path') or ch.get('filename', '')).lower()}"
                    by_file.setdefault(fkey, []).append(ch)
                pruned: list[dict[str, Any]] = []
                idx_pos = 0
                while len(pruned) < MAX_STORED_CHUNKS:
                    added_in_round = False
                    for flist in by_file.values():
                        if idx_pos < len(flist):
                            pruned.append(flist[idx_pos])
                            added_in_round = True
                            if len(pruned) >= MAX_STORED_CHUNKS:
                                break
                    if not added_in_round:
                        break
                    idx_pos += 1
                retained_chunks = pruned

            val["chunks"] = retained_chunks
            catalog_files_for_fid = {
                str(f.get("relative_path") or f.get("filename") or "").replace("\\", "/").lstrip("/").lower()
                for f in val.get("files", [])
                if f.get("folder_id") == fid and (f.get("relative_path") or f.get("filename"))
            }
            chunk_files_for_fid = {
                str(c.get("relative_path") or c.get("filename") or "").replace("\\", "/").lstrip("/").lower()
                for c in retained_chunks
                if c.get("folder_id") == fid and (c.get("relative_path") or c.get("filename"))
            }
            file_count = max(file_count, len(catalog_files_for_fid | chunk_files_for_fid))
            actual_chunk_count = sum(1 for c in retained_chunks if c.get("folder_id") == fid)
            chunk_count = actual_chunk_count if actual_chunk_count or payload.replace_all else prev_chunk_count
            folders[fid]["file_count"] = file_count
            folders[fid]["chunk_count"] = chunk_count
            self._save_key(tenant_id, user_id, val)
            for other_k in list(self._cache_ts.keys()):
                if other_k[0] == k[0] and other_k != k:
                    self._cache_ts.pop(other_k, None)
            logger.info("Synced %d chunks for local folder '%s' (user %s, total chunks: %d, files: %d)", len(payload.chunks), fid, user_id, chunk_count, file_count)

    def upsert_uploaded_chunks(
        self,
        tenant_id: str,
        rel_path: str,
        chunks: list[dict[str, Any]],
        user_id: str = "default",
    ) -> None:
        """Persist chunks for a chat-uploaded document without disturbing synced folders."""
        with self._lock:
            val = self._load_key(tenant_id, user_id)
            existing = val.get("chunks", [])
            retained = [c for c in existing if c.get("relative_path") != rel_path]
            retained.extend(chunks)
            MAX_STORED_CHUNKS = 3000
            if len(retained) > MAX_STORED_CHUNKS:
                retained = retained[-MAX_STORED_CHUNKS:]
            val["chunks"] = retained
            self._save_key(tenant_id, user_id, val)

    def remove_folder(self, tenant_id: str, user_id: str, folder_id: str) -> bool:
        """Remove a connected folder and its chunks strictly for this user's workspace."""
        import urllib.parse
        clean_fid = urllib.parse.unquote(str(folder_id).strip())
        norm_fid = clean_fid.replace("\\", "/").rstrip("/").lower()
        base_name_fid = norm_fid.split("/")[-1] if "/" in norm_fid else norm_fid
        k = self._key(tenant_id, user_id)

        with self._lock:
            val = self._load_key(k[0], k[1])
            folders = val.get("folders", {})
            fids_to_del = []
            removed_paths = []
            for fid, f_info in list(folders.items()):
                f_path = str(f_info.get("folder_path") or fid).strip()
                norm_path = f_path.replace("\\", "/").rstrip("/").lower()
                norm_f_id = str(fid).replace("\\", "/").rstrip("/").lower()
                if (
                    norm_f_id == norm_fid
                    or norm_path == norm_fid
                    or (base_name_fid and (norm_f_id.endswith("/" + base_name_fid) or norm_path.endswith("/" + base_name_fid)))
                    or (norm_fid and (norm_fid in norm_f_id or norm_fid in norm_path or norm_f_id in norm_fid or norm_path in norm_fid))
                ):
                    fids_to_del.append(fid)
                    removed_paths.append(f_path)

            matched = bool(fids_to_del)
            for fid in fids_to_del:
                del folders[fid]

            if fids_to_del or norm_fid:
                all_del_norms = {norm_fid, *(p.replace("\\", "/").rstrip("/").lower() for p in removed_paths)}
                if base_name_fid:
                    all_del_norms.add(base_name_fid)
                val["chunks"] = [
                    c for c in val.get("chunks", [])
                    if str(c.get("folder_id", "")).replace("\\", "/").rstrip("/").lower() not in all_del_norms
                    and str(c.get("folder_path", "")).replace("\\", "/").rstrip("/").lower() not in all_del_norms
                ]
                val["files"] = [
                    f for f in val.get("files", [])
                    if str(f.get("folder_id", "")).replace("\\", "/").rstrip("/").lower() not in all_del_norms
                    and str(f.get("folder_path", "")).replace("\\", "/").rstrip("/").lower() not in all_del_norms
                ]
                val["requested_folders"] = [
                    r for r in val.get("requested_folders", [])
                    if str(r).replace("\\", "/").rstrip("/").lower() not in all_del_norms
                ]
                disconn = set(val.get("disconnected_folders", []))
                disconn.update(all_del_norms)
                val["disconnected_folders"] = list(disconn)

                cmd_path = removed_paths[0] if removed_paths else clean_fid
                val.setdefault("pending_commands", []).append({
                    "id": f"cmd_{int(time.time() * 1000)}",
                    "command": "remove_folder",
                    "payload": {"folder_path": cmd_path, "folder_id": clean_fid},
                })
                self._save_key(k[0], k[1], val)

            # Only clear shared disk persistence when operating as the legacy 'default' identity and no folders remain
            if k[1] == "default" and not folders:
                try:
                    from backend.integrations.files.company_data.persistence import ACTIVE_FOLDERS_FILE, ACTIVE_FOLDER_FILE
                    if ACTIVE_FOLDERS_FILE.exists():
                        ACTIVE_FOLDERS_FILE.write_text("{}", encoding="utf-8")
                    if ACTIVE_FOLDER_FILE.exists():
                        ACTIVE_FOLDER_FILE.write_text("{}", encoding="utf-8")
                except Exception:
                    pass

            try:
                from backend.integrations.files.company_data_service import CompanyDataService
                user_cds = CompanyDataService.for_user(k[0], k[1])
                user_cds.clear_cache()
                if k[1] == "default":
                    CompanyDataService.for_tenant(k[0]).clear_cache()
            except Exception:
                pass

            return matched or True

    def queue_command(self, tenant_id: str, user_id: str, command: str, payload: dict[str, Any]) -> str:
        """Queue a command (e.g. open_file) to be delivered to user's connected Windows PC agent."""
        cmd_id = f"cmd_{int(time.time() * 1000)}"
        with self._lock:
            val = self._load_key(tenant_id, user_id)
            cmds = val.setdefault("pending_commands", [])
            cmds.append({
                "id": cmd_id,
                "command": command,
                "payload": payload,
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
            self._save_key(tenant_id, user_id, val)
        return cmd_id

    def pop_commands(self, tenant_id: str, user_id: str) -> list[dict[str, Any]]:
        """Retrieve and clear pending commands strictly for this user's workspace."""
        clean_t = str(tenant_id or "default").strip()
        clean_u = str(user_id or "default").strip()

        with self._lock:
            val = self._load_key(clean_t, clean_u)
            cmds = list(val.get("pending_commands", []))
            if cmds:
                val["pending_commands"] = []
                self._save_key(clean_t, clean_u, val)
                return cmds
            return []

    def _tenant_field_unlocked(self, tenant_id: str, user_id: str, field: str) -> Any:
        """Read chunks, files, or folders strictly within the caller's (tenant_id, user_id) workspace."""
        val = self._load_key(tenant_id, user_id)
        items = val.get(field)
        if items:
            return items
        return [] if field in ("chunks", "files") else {}

    def get_all_files(self, tenant_id: str, user_id: str) -> list[dict[str, Any]]:
        """Return all distinct indexed files from connected folders for this user/tenant."""
        with self._lock:
            chunks = self._tenant_field_unlocked(tenant_id, user_id, "chunks")
            file_catalog = self._tenant_field_unlocked(tenant_id, user_id, "files") or []

            seen = set()
            files: list[dict[str, Any]] = []
            for item in [*chunks, *file_catalog]:
                rel = str(item.get("relative_path", "") or "").replace("\\", "/").strip("/")
                fname = item.get("filename", Path(rel).name if rel else "document")
                f_name = str(item.get("folder_name", "") or "").strip()
                raw_fp = str(item.get("folder_path", "") or "").strip()
                if raw_fp.replace("\\", "/").lower().startswith("browserfolder/"):
                    raw_fp = raw_fp.replace("\\", "/")[len("BrowserFolder/"):].strip("/")
                if f_name and not rel.lower().startswith(f_name.lower() + "/"):
                    disp_path = f"{f_name}/{rel}".strip("/")
                else:
                    disp_path = rel or f_name
                key = (fname.lower(), rel.lower())
                if key in seen:
                    continue
                seen.add(key)

                if raw_fp and (":" in raw_fp or raw_fp.startswith("\\\\") or raw_fp.startswith("/")):
                    sep = "\\" if (":" in raw_fp or "\\" in raw_fp) else "/"
                    rel_clean = rel.replace("/", sep) if rel else ""
                    exact_full_path = f"{raw_fp.rstrip('/\\')}{sep}{rel_clean}" if rel_clean else raw_fp
                else:
                    exact_full_path = disp_path

                files.append({
                    "name": fname,
                    "path": exact_full_path,
                    "full_path": exact_full_path,
                    "display_path": disp_path,
                    "type": Path(fname).suffix.lstrip("."),
                    "modified_at": item.get("modified_at") or "",
                    "open_url": exact_full_path,
                    "source": "local",
                    "content_snippet": (item.get("text") or "")[:350],
                })

            # Disk fallback: if no chunks are synced yet, discover files directly from connected folders on disk
            if not files:
                folders_map = dict(self._tenant_field_unlocked(tenant_id, user_id, "folders"))

                for f_info in folders_map.values():
                    fp = f_info.get("folder_path")
                    if fp:
                        p_dir = Path(fp)
                        if p_dir.exists() and p_dir.is_dir():
                            for root, _, flist in os.walk(p_dir):
                                for fn in flist:
                                    if fn.startswith(".") or fn.startswith("~$"):
                                        continue
                                    f_p = Path(root) / fn
                                    try:
                                        rel = str(f_p.relative_to(p_dir)).replace("\\", "/")
                                    except Exception:
                                        rel = fn
                                    key = (fn.lower(), rel.lower())
                                    if key in seen:
                                        continue
                                    seen.add(key)
                                    full_p = str(f_p)
                                    disp = f"{p_dir.name}/{rel}"
                                    mtime_iso = ""
                                    try:
                                        mtime_iso = datetime.fromtimestamp(f_p.stat().st_mtime, tz=timezone.utc).isoformat()
                                    except Exception:
                                        pass
                                    files.append({
                                        "name": fn,
                                        "path": full_p,
                                        "full_path": full_p,
                                        "display_path": disp,
                                        "type": f_p.suffix.lstrip("."),
                                        "modified_at": mtime_iso,
                                        "open_url": full_p,
                                        "source": "local",
                                        "content_snippet": "",
                                    })
            return files

    def search_chunks(
        self,
        tenant_id: str,
        user_id: str,
        query: str,
        top_k: int = 5,
        folder_id: str | None = None,
    ) -> list[LocalSearchChunk]:
        """Perform fast keyword and relevance search over user's local chunks."""
        with self._lock:
            chunks = list(self._tenant_field_unlocked(tenant_id, user_id, "chunks") or [])
            file_catalog = list(self._tenant_field_unlocked(tenant_id, user_id, "files") or [])
            if file_catalog:
                chunk_rels = {str(c.get("relative_path") or "").replace("\\", "/").lower() for c in chunks}
                for fc in file_catalog:
                    frel = str(fc.get("relative_path") or "").replace("\\", "/").lower()
                    if frel and frel not in chunk_rels:
                        chunks.append({
                            "chunk_id": f"filemeta-{hash(frel)}",
                            "folder_id": fc.get("folder_id", ""),
                            "folder_path": fc.get("folder_path", ""),
                            "folder_name": fc.get("folder_name", ""),
                            "relative_path": fc.get("relative_path", ""),
                            "filename": fc.get("filename", ""),
                            "chunk_index": 0,
                            "text": f"File: {fc.get('filename', '')} Path: {fc.get('relative_path', '')}",
                            "modified_at": fc.get("modified_at"),
                            "page": None,
                            "sheet": None,
                            "metadata": {"file_catalog_entry": True},
                        })

            if not chunks:
                return []

            query_clean = query.strip().lower()
            query_spaced = re.sub(r"[_-]+", " ", query_clean)
            explicit_file_matches = [
                c for c in chunks
                if c.get("filename") and str(c.get("filename")).lower() in query_clean
            ]
            if explicit_file_matches:
                chunks = explicit_file_matches

            raw_terms = [t.lower() for t in re.findall(r"\w+", query_spaced) if len(t) > 1]

            STOP_WORDS = {
                "what", "is", "are", "in", "the", "my", "our", "folder", "folders",
                "file", "files", "document", "documents", "tell", "me", "about",
                "can", "you", "summarize", "summary", "explain", "describe", "show",
                "give", "please", "contents", "inside", "do", "we", "have", "there",
                "any", "this", "that", "these", "those", "from", "with", "and", "for",
                "find", "locate", "search", "look"
            }
            content_terms = [t for t in raw_terms if t not in STOP_WORDS]
            query_terms = content_terms if content_terms else raw_terms
            clean_phrase = " ".join(query_terms)
            # Detect compound alphanumeric identifiers/codes (e.g. PRJ-CFL-002, INV-2026-001)
            code_tokens = [
                ct.lower()
                for ct in re.findall(r"[a-z0-9]+(?:[-_][a-z0-9]+)+", query_clean)
                if any(ch.isalpha() for ch in ct) and any(ch.isdigit() for ch in ct)
            ]

            high_cov_scored: list[tuple[float, dict[str, Any]]] = []
            partial_scored: list[tuple[float, dict[str, Any]]] = []

            # If query is general or only contains stop words (e.g. 'summarize my folder', 'what is in my files'),
            # return representative chunks from each distinct file without scoring stop words!
            if not content_terms:
                seen_f = set()
                top_distinct = []
                from backend.retrieval.semantic import (
                    build_sparse_semantic_vector,
                    expand_semantic_tokens,
                    light_stem,
                    sparse_cosine_similarity,
                )
                query_semantic_vec = build_sparse_semantic_vector(clean_phrase or query_clean)
                semantic_siblings = expand_semantic_tokens(clean_phrase or query_clean)

                for c in chunks:
                    if folder_id and c.get("folder_id") != folder_id:
                        continue
                    fn = c.get("filename", "")
                    if fn not in seen_f:
                        seen_f.add(fn)
                        top_distinct.append((100.0, c))
                    if len(top_distinct) >= top_k:
                        break
                scored = top_distinct or [(100.0, c) for c in chunks[:top_k]]
            else:
                from backend.retrieval.semantic import (
                    build_sparse_semantic_vector,
                    expand_semantic_tokens,
                    light_stem,
                    sparse_cosine_similarity,
                )
                query_semantic_vec = build_sparse_semantic_vector(clean_phrase or query_clean)
                semantic_siblings = expand_semantic_tokens(clean_phrase or query_clean)

                for c in chunks:
                    if folder_id and c.get("folder_id") != folder_id:
                        continue

                    text_lower = c.get("text", "").lower()
                    rel_path_lower = c.get("relative_path", "").lower()
                    fn_lower = c.get("filename", "").lower()
                    folder_lower = str(c.get("folder_name", "")).lower()
                    fn_stem = fn_lower.rsplit(".", 1)[0] if "." in fn_lower else fn_lower
                    fn_spaced = re.sub(r"[_-]+", " ", fn_stem)
                    rel_spaced = re.sub(r"[_-]+", " ", rel_path_lower)
                    text_spaced = re.sub(r"[_-]+", " ", text_lower)
                    is_catalog_stub = bool((c.get("metadata") or {}).get("file_catalog_entry"))

                    score = 0.0
                    matched_term_set: set[str] = set()
                    exact_hit = False

                    # 0. Exact compound code match (e.g. "prj-cfl-002" must crush bare "002" filename hits)
                    for ct in code_tokens:
                        ct_spaced = re.sub(r"[_-]+", " ", ct)
                        if ct in text_lower or ct_spaced in text_spaced:
                            score += 600.0
                            exact_hit = True
                            matched_term_set.update(query_terms)
                        if ct in rel_path_lower or ct_spaced in rel_spaced:
                            score += 750.0
                            exact_hit = True
                            matched_term_set.update(query_terms)
                        if ct in fn_lower or ct_spaced in fn_spaced:
                            score += 800.0
                            exact_hit = True
                            matched_term_set.update(query_terms)

                    # 1. Exact multi-word phrase or filename stem match bonus (space/underscore tolerant)
                    if fn_spaced and len(fn_spaced) >= 3 and (fn_stem in query_clean or fn_spaced in query_spaced or (clean_phrase and clean_phrase in fn_spaced)):
                        score += 400.0
                        exact_hit = True
                        matched_term_set.update(query_terms)
                    if len(query_terms) > 1 and clean_phrase:
                        if clean_phrase in text_lower or clean_phrase in text_spaced:
                            score += 250.0
                            exact_hit = True
                            matched_term_set.update(query_terms)
                        if clean_phrase in rel_path_lower or clean_phrase in rel_spaced:
                            score += 350.0
                            exact_hit = True
                            matched_term_set.update(query_terms)

                    # 2. Individual term counts (bounded so single-token spam cannot beat phrase/code matches)
                    for term in query_terms:
                        count_text = text_lower.count(term) or text_spaced.count(term)
                        count_path = rel_path_lower.count(term) or rel_spaced.count(term)
                        count_fn = fn_lower.count(term) or fn_spaced.count(term)
                        count_folder = folder_lower.count(term)

                        if count_text == 0 and count_path == 0 and count_fn == 0 and count_folder == 0:
                            stem = light_stem(term)
                            if len(stem) >= 3 and stem != term:
                                count_text = text_lower.count(stem)
                                count_path = rel_path_lower.count(stem)
                                count_fn = fn_lower.count(stem)
                                count_folder = folder_lower.count(stem)

                        if count_text > 0 or count_path > 0 or count_fn > 0 or count_folder > 0:
                            matched_term_set.add(term)
                            score += (
                                min(count_text, 10) * 1.5
                                + min(count_path, 5) * 10.0
                                + min(count_fn, 3) * 25.0
                                + min(count_folder, 3) * 3.0
                            )

                    # 3. Semantic concept & cosine similarity expansion (when no compound code lock is active)
                    sem_sim = 0.0
                    if not code_tokens and query_semantic_vec:
                        chunk_vec = build_sparse_semantic_vector(f"{fn_spaced} {text_lower[:2000]}")
                        sem_sim = sparse_cosine_similarity(query_semantic_vec, chunk_vec)
                        if sem_sim >= 0.24:
                            score += sem_sim * 45.0
                            if not matched_term_set and sem_sim >= 0.34:
                                # Semantic synonym/concept match (e.g. "past due bill" -> "overdue invoice")
                                syn_hits = sum(1 for st in semantic_siblings if not st.startswith("__c_") and (st in text_lower or st in fn_spaced))
                                if syn_hits >= 1:
                                    matched_term_set.add(query_terms[0])

                    # Reject pure-numeric suffix noise (e.g. matching only "002" in attendance_002.csv for "PRJ-CFL-002")
                    if code_tokens and not exact_hit:
                        has_alpha_term = any(any(ch.isalpha() for ch in t) for t in matched_term_set)
                        if not has_alpha_term:
                            continue

                    if matched_term_set:
                        coverage = len(matched_term_set) / len(query_terms)
                        content_bonus = 25.0 if not is_catalog_stub else 0.0
                        final_score = (score + content_bonus) * (1.0 + coverage)
                        if exact_hit or coverage >= 1.0:
                            high_cov_scored.append((final_score, c))
                        elif sem_sim >= 0.30 or coverage >= 0.4:
                            partial_scored.append((final_score, c))

                if high_cov_scored:
                    scored = high_cov_scored
                else:
                    scored = partial_scored

            scored.sort(key=lambda x: x[0], reverse=True)

            results: list[LocalSearchChunk] = []
            for score, c in scored[:top_k]:
                rel = c.get("relative_path", "")
                fname = c.get("filename", Path(rel).name)
                f_name = c.get("folder_name", "")
                if f_name and not rel.lower().startswith(f_name.lower() + "/"):
                    citation = f"{f_name}/{rel}".strip("/")
                else:
                    citation = rel

                results.append(
                    LocalSearchChunk(
                        chunk_id=c["chunk_id"],
                        folder_name=f_name,
                        folder_path=c.get("folder_path", ""),
                        relative_path=rel,
                        filename=fname,
                        citation=citation,
                        text=c.get("text", ""),
                        score=round(score, 3),
                        page=c.get("page"),
                        sheet=c.get("sheet"),
                        modified_at=c.get("modified_at"),
                    )
                )

            return results

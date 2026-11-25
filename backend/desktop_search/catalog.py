from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import logging
from pathlib import Path
import sqlite3
import threading
import time
from typing import Any, Iterator
import uuid

import numpy as np

from .models import (
    CLOUD_VECTOR_STORAGE_DTYPE,
    CanonicalChunkRecord,
    CanonicalFileRecord,
    EMBEDDING_DIM,
    EMBEDDING_MODEL_ID,
    EngineHit,
    IndexingHealthStatus,
    ONNX_WEIGHT_DTYPE,
    VECTOR_STORAGE_DTYPE,
)
from .security import LocalPayloadCipher

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 2

_QUERY_TRIGRAM_STOPWORDS = frozenset({
    "the", "and", "for", "with", "from", "that", "this", "they", "them", "their",
    "was", "were", "are", "have", "has", "had", "did", "didn", "didnt", "not",
    "already", "created", "more", "than", "then", "less", "show", "find", "list",
    "get", "give", "can", "you", "file", "files", "document", "documents", "another",
})


def _normalize_fts_query(raw_query: str) -> str:
    """Convert raw user text into a safe FTS5 MATCH query without syntax errors."""
    tokens = [
        "".join(ch for ch in part if ch.isalnum() or ch in {"_", "-"})
        for part in str(raw_query or "").split()
    ]
    cleaned = [t for t in tokens if len(t) >= 2 and t.casefold() not in _QUERY_TRIGRAM_STOPWORDS]
    if not cleaned:
        cleaned = [t for t in tokens if len(t) >= 2]
    if not cleaned:
        cleaned = ["".join(ch for ch in raw_query if ch.isalnum())]
    cleaned = [t for t in cleaned if t]
    if not cleaned:
        return ""
    return " OR ".join(f'"{tok}"' for tok in cleaned[:12])


def _trigram_safe(raw_query: str) -> list[str]:
    parts = [p.strip() for p in str(raw_query or "").replace("\\", " ").replace("/", " ").split()]
    filtered = [p for p in parts if len(p) >= 3 and p.casefold() not in _QUERY_TRIGRAM_STOPWORDS]
    if not filtered:
        filtered = [p for p in parts if len(p) >= 3]
    return filtered[:6]


class CatalogStore:
    """Thread-safe SQLite 3.49 WAL canonical document catalog and durable outbox."""

    def __init__(
        self,
        db_path: Path,
        *,
        cipher: LocalPayloadCipher | None = None,
        encrypt_sensitive: bool = False,
        enable_chunks_fts: bool = True,
    ) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._cipher = cipher
        self._encrypt_sensitive = encrypt_sensitive and cipher is not None
        self._enable_chunks_fts = enable_chunks_fts
        self._write_lock = threading.RLock()
        self._local = threading.local()
        self._connections: list[sqlite3.Connection] = []
        self._conn_lock = threading.Lock()
        self._init_schema()

    def _get_conn(self) -> sqlite3.Connection:
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is not None:
            return conn
        conn = sqlite3.connect(
            str(self.db_path),
            timeout=15.0,
            isolation_level=None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA temp_store=MEMORY")
        self._local.conn = conn
        with self._conn_lock:
            self._connections.append(conn)
        return conn

    def close(self) -> None:
        """Close all thread-local SQLite connections cleanly."""
        with self._conn_lock:
            for conn in self._connections:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass
            self._connections.clear()
        if hasattr(self._local, "conn"):
            delattr(self._local, "conn")

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self._write_lock:
            conn = self._get_conn()
            if not conn.in_transaction:
                conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except Exception:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
            else:
                if conn.in_transaction:
                    conn.execute("COMMIT")

    def _init_schema(self) -> None:
        with self.transaction() as conn:
            ver = conn.execute("PRAGMA user_version").fetchone()[0]
            if ver < 1:
                self._apply_v1_schema(conn)
            if ver < SCHEMA_VERSION:
                cols = {
                    str(r["name"])
                    for r in conn.execute("PRAGMA table_info(extracted_entities)").fetchall()
                }
                if "raw_json" not in cols:
                    conn.execute(
                        "ALTER TABLE extracted_entities ADD COLUMN raw_json TEXT NOT NULL DEFAULT '{}'"
                    )
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _apply_v1_schema(self, conn: sqlite3.Connection) -> None:
        ddl_statements = [
            """
            CREATE TABLE IF NOT EXISTS engine_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS canonical_files (
                doc_id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                machine_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                volume_serial TEXT NOT NULL DEFAULT '0',
                file_index TEXT NOT NULL DEFAULT '0',
                abs_path TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                filename TEXT NOT NULL,
                ext TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                content_sha256 TEXT NOT NULL,
                department TEXT NOT NULL DEFAULT 'General',
                compartment TEXT NOT NULL DEFAULT 'comp_general',
                doc_type TEXT NOT NULL DEFAULT 'document',
                is_sensitive INTEGER NOT NULL DEFAULT 0,
                is_cloud_stub INTEGER NOT NULL DEFAULT 0,
                extraction_status TEXT NOT NULL DEFAULT 'pending',
                current_version INTEGER NOT NULL DEFAULT 1,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                indexed_at REAL NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL
            )
            """,
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_files_active_path
                ON canonical_files(tenant_id, user_id, machine_id, workspace_id, rel_path)
                WHERE is_deleted = 0
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_files_ntfs_id
                ON canonical_files(workspace_id, volume_serial, file_index)
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_files_sha
                ON canonical_files(workspace_id, content_sha256)
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_files_compartment
                ON canonical_files(workspace_id, compartment, is_deleted)
            """,
            """
            CREATE TABLE IF NOT EXISTS canonical_chunks (
                chunk_id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL REFERENCES canonical_files(doc_id) ON DELETE CASCADE,
                file_version INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL,
                page_label TEXT NOT NULL DEFAULT '',
                section_label TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                content_encrypted INTEGER NOT NULL DEFAULT 0,
                content_sha256 TEXT NOT NULL,
                char_count INTEGER NOT NULL,
                embed_eligible INTEGER NOT NULL DEFAULT 1,
                is_deleted INTEGER NOT NULL DEFAULT 0
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_chunks_doc_active
                ON canonical_chunks(doc_id, is_deleted, chunk_index)
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_chunks_sha
                ON canonical_chunks(content_sha256)
            """,
            """
            CREATE TABLE IF NOT EXISTS vector_cache (
                content_sha256 TEXT NOT NULL,
                model_id TEXT NOT NULL,
                dim INTEGER NOT NULL,
                vector_dtype TEXT NOT NULL,
                vector_blob BLOB NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (content_sha256, model_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS engine_sync_state (
                doc_id TEXT NOT NULL REFERENCES canonical_files(doc_id) ON DELETE CASCADE,
                engine_name TEXT NOT NULL,
                synced_version INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                last_error TEXT,
                updated_at REAL NOT NULL,
                PRIMARY KEY (doc_id, engine_name)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS index_outbox (
                job_id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id TEXT NOT NULL,
                target_version INTEGER NOT NULL,
                engine_name TEXT NOT NULL,
                op TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                next_retry_at REAL NOT NULL DEFAULT 0,
                lease_expires_at REAL NOT NULL DEFAULT 0,
                last_error TEXT,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_outbox_claim
                ON index_outbox(engine_name, status, next_retry_at, job_id)
            """,
            """
            CREATE INDEX IF NOT EXISTS idx_outbox_doc_engine
                ON index_outbox(doc_id, engine_name, status)
            """,
            """
            CREATE TABLE IF NOT EXISTS extracted_invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id TEXT NOT NULL REFERENCES canonical_files(doc_id) ON DELETE CASCADE,
                invoice_number TEXT NOT NULL DEFAULT '',
                vendor TEXT NOT NULL DEFAULT '',
                customer TEXT NOT NULL DEFAULT '',
                amount REAL NOT NULL DEFAULT 0.0,
                currency TEXT NOT NULL DEFAULT 'USD',
                due_date TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                raw_json TEXT NOT NULL DEFAULT '{}'
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_invoices_doc ON extracted_invoices(doc_id)",
            """
            CREATE TABLE IF NOT EXISTS extracted_contracts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id TEXT NOT NULL REFERENCES canonical_files(doc_id) ON DELETE CASCADE,
                party TEXT NOT NULL DEFAULT '',
                contract_title TEXT NOT NULL DEFAULT '',
                effective_date TEXT NOT NULL DEFAULT '',
                expiration_date TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                raw_json TEXT NOT NULL DEFAULT '{}'
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_contracts_doc ON extracted_contracts(doc_id)",
            """
            CREATE TABLE IF NOT EXISTS extracted_entities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id TEXT NOT NULL REFERENCES canonical_files(doc_id) ON DELETE CASCADE,
                entity_type TEXT NOT NULL,
                entity_name TEXT NOT NULL,
                normalized_name TEXT NOT NULL,
                raw_json TEXT NOT NULL DEFAULT '{}'
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_entities_doc ON extracted_entities(doc_id)",
            "CREATE INDEX IF NOT EXISTS idx_entities_type_name ON extracted_entities(entity_type, normalized_name)",
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS files_trigram
                USING fts5(doc_id UNINDEXED, rel_path, filename, tokenize='trigram')
            """,
        ]
        for stmt in ddl_statements:
            conn.execute(stmt)

        now = time.time()
        defaults = {
            "embedding_model_id": EMBEDDING_MODEL_ID,
            "embedding_dim": str(EMBEDDING_DIM),
            "onnx_weight_dtype": ONNX_WEIGHT_DTYPE,
            "vector_storage_dtype": VECTOR_STORAGE_DTYPE,
            "cloud_vector_storage_dtype": CLOUD_VECTOR_STORAGE_DTYPE,
            "chunks_fts_retired": "0" if self._enable_chunks_fts else "1",
        }
        for key, val in defaults.items():
            conn.execute(
                """
                INSERT INTO engine_metadata(key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO NOTHING
                """,
                (key, val, now),
            )

        if not self.is_chunks_fts_retired(conn=conn):
            conn.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
                USING fts5(chunk_id UNINDEXED, doc_id UNINDEXED, filename, content, tokenize='porter unicode61')
                """
            )

    def get_metadata(self, key: str, default: str = "") -> str:
        row = self._get_conn().execute(
            "SELECT value FROM engine_metadata WHERE key = ?",
            (key,),
        ).fetchone()
        return str(row["value"]) if row else default

    def set_metadata(self, key: str, value: str, *, conn: sqlite3.Connection | None = None) -> None:
        now = time.time()
        if conn is not None:
            conn.execute(
                """
                INSERT INTO engine_metadata(key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (key, value, now),
            )
            return
        with self.transaction() as c:
            self.set_metadata(key, value, conn=c)

    def is_chunks_fts_retired(self, *, conn: sqlite3.Connection | None = None) -> bool:
        c = conn or self._get_conn()
        row = c.execute(
            "SELECT value FROM engine_metadata WHERE key = 'chunks_fts_retired'"
        ).fetchone()
        return bool(row and row["value"] == "1")

    def retire_chunks_fts(self) -> bool:
        """Drop redundant prose FTS5 table once Tantivy is caught up."""
        with self.transaction() as conn:
            if self.is_chunks_fts_retired(conn=conn):
                return False
            conn.execute("DROP TABLE IF EXISTS chunks_fts")
            self.set_metadata("chunks_fts_retired", "1", conn=conn)
            logger.info("Retired redundant SQLite chunks_fts after Tantivy parity verified.")
            return True

    def _decrypt_content(self, raw_content: str, encrypted_flag: int, chunk_id: str) -> str:
        if not encrypted_flag or not raw_content.startswith("ENC1:"):
            return raw_content
        if self._cipher is None:
            return raw_content
        try:
            return self._cipher.decrypt_text(raw_content, aad=chunk_id)
        except Exception:
            return raw_content

    def _encrypt_content(self, plaintext: str, is_sensitive: bool, chunk_id: str) -> tuple[str, int]:
        if is_sensitive and self._encrypt_sensitive and self._cipher is not None:
            return self._cipher.encrypt_text(plaintext, aad=chunk_id), 1
        return plaintext, 0

    def lookup_active_by_path(
        self,
        *,
        tenant_id: str,
        user_id: str,
        machine_id: str,
        workspace_id: str,
        rel_path: str,
    ) -> sqlite3.Row | None:
        return self._get_conn().execute(
            """
            SELECT * FROM canonical_files
            WHERE tenant_id = ? AND user_id = ? AND machine_id = ? AND workspace_id = ?
              AND rel_path = ? AND is_deleted = 0
            """,
            (tenant_id, user_id, machine_id, workspace_id, rel_path),
        ).fetchone()

    def find_move_candidate(
        self,
        *,
        workspace_id: str,
        volume_serial: str,
        file_index: str,
        rel_path: str,
        content_sha256: str = "",
    ) -> sqlite3.Row | None:
        """Identify a moved/renamed file using NTFS (volume_serial, file_index) or hash."""
        conn = self._get_conn()
        vol_s = str(volume_serial or "0")
        ino_s = str(file_index or "0")
        if vol_s != "0" and ino_s != "0":
            rows = conn.execute(
                """
                SELECT * FROM canonical_files
                WHERE workspace_id = ? AND volume_serial = ? AND file_index = ? AND rel_path != ?
                ORDER BY is_deleted ASC, updated_at DESC
                """,
                (workspace_id, vol_s, ino_s, rel_path),
            ).fetchall()
            for row in rows:
                old_abs = Path(row["abs_path"])
                # Only claim move if old location no longer exists on disk (not a hardlink copy).
                if row["is_deleted"] == 1 or not old_abs.exists():
                    return row

        if content_sha256:
            rows = conn.execute(
                """
                SELECT * FROM canonical_files
                WHERE workspace_id = ? AND content_sha256 = ? AND rel_path != ?
                ORDER BY is_deleted ASC, updated_at DESC
                LIMIT 5
                """,
                (workspace_id, content_sha256, rel_path),
            ).fetchall()
            for row in rows:
                old_abs = Path(row["abs_path"])
                if not old_abs.exists():
                    return row
        return None

    def _enqueue_outbox(
        self,
        conn: sqlite3.Connection,
        *,
        doc_id: str,
        target_version: int,
        engine_name: str,
        op: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        now = time.time()
        # Coalesce supersede any older pending/retry jobs for the same doc+engine.
        conn.execute(
            """
            UPDATE index_outbox
               SET status = 'done', updated_at = ?
             WHERE doc_id = ? AND engine_name = ? AND status IN ('pending', 'retry')
               AND target_version <= ?
            """,
            (now, doc_id, engine_name, target_version),
        )
        conn.execute(
            """
            INSERT INTO index_outbox (
                doc_id, target_version, engine_name, op, status, attempts,
                next_retry_at, lease_expires_at, payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?, ?)
            """,
            (
                doc_id,
                target_version,
                engine_name,
                op,
                json.dumps(payload or {}),
                now,
                now,
            ),
        )

    def register_cloud_stub(
        self,
        *,
        tenant_id: str,
        user_id: str,
        machine_id: str,
        workspace_id: str,
        abs_path: str,
        rel_path: str,
        filename: str,
        ext: str,
        size_bytes: int,
        mtime_ns: int,
        department: str,
        compartment: str,
        is_sensitive: bool,
    ) -> str:
        """Record an unhydrated cloud placeholder (OneDrive Files On-Demand) without hydration."""
        now = time.time()
        with self.transaction() as conn:
            existing = self.lookup_active_by_path(
                tenant_id=tenant_id,
                user_id=user_id,
                machine_id=machine_id,
                workspace_id=workspace_id,
                rel_path=rel_path,
            )
            doc_id = str(existing["doc_id"]) if existing else uuid.uuid4().hex
            if existing:
                conn.execute(
                    """
                    UPDATE canonical_files
                       SET size_bytes = ?, mtime_ns = ?, is_cloud_stub = 1,
                           extraction_status = 'cloud_stub_skipped', updated_at = ?
                     WHERE doc_id = ?
                    """,
                    (size_bytes, mtime_ns, now, doc_id),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO canonical_files (
                        doc_id, tenant_id, user_id, machine_id, workspace_id,
                        abs_path, rel_path, filename, ext, size_bytes, mtime_ns,
                        content_sha256, department, compartment, doc_type,
                        is_sensitive, is_cloud_stub, extraction_status,
                        current_version, is_deleted, indexed_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'cloud_placeholder', ?, 1, 'cloud_stub_skipped', 1, 0, ?, ?)
                    """,
                    (
                        doc_id,
                        tenant_id,
                        user_id,
                        machine_id,
                        workspace_id,
                        abs_path,
                        rel_path,
                        filename,
                        ext,
                        size_bytes,
                        mtime_ns,
                        department,
                        compartment,
                        int(is_sensitive),
                        now,
                        now,
                    ),
                )
            conn.execute("DELETE FROM files_trigram WHERE doc_id = ?", (doc_id,))
            conn.execute(
                "INSERT INTO files_trigram(doc_id, rel_path, filename) VALUES (?, ?, ?)",
                (doc_id, rel_path, filename),
            )
            return doc_id

    def register_discovered_stubs_batch(
        self,
        *,
        tenant_id: str,
        user_id: str,
        machine_id: str,
        workspace_id: str,
        items: list[dict[str, Any]],
    ) -> int:
        """Batch-register newly discovered files as filename-searchable pending stubs."""
        if not items:
            return 0
        now = time.time()
        inserted = 0
        with self.transaction() as conn:
            existing_rows = conn.execute(
                """
                SELECT rel_path FROM canonical_files
                 WHERE tenant_id = ? AND user_id = ? AND machine_id = ?
                   AND workspace_id = ? AND is_deleted = 0
                """,
                (tenant_id, user_id, machine_id, workspace_id),
            ).fetchall()
            existing_rels = {str(r["rel_path"]) for r in existing_rows}

            file_rows: list[tuple[Any, ...]] = []
            trig_rows: list[tuple[str, str, str]] = []
            for item in items:
                rel_path = str(item["rel_path"])
                if rel_path in existing_rels:
                    continue
                existing_rels.add(rel_path)
                doc_id = uuid.uuid4().hex
                file_rows.append(
                    (
                        doc_id,
                        tenant_id,
                        user_id,
                        machine_id,
                        workspace_id,
                        str(item["abs_path"]),
                        rel_path,
                        str(item["filename"]),
                        str(item["ext"]),
                        int(item.get("size_bytes") or 0),
                        int(item.get("mtime_ns") or 0),
                        str(item.get("department") or "General"),
                        str(item.get("compartment") or "comp_general"),
                        str(item.get("doc_type") or "document"),
                        int(bool(item.get("is_sensitive", False))),
                        now,
                        now,
                    )
                )
                trig_rows.append((doc_id, rel_path, str(item["filename"])))

            if file_rows:
                conn.executemany(
                    """
                    INSERT INTO canonical_files (
                        doc_id, tenant_id, user_id, machine_id, workspace_id,
                        abs_path, rel_path, filename, ext, size_bytes, mtime_ns,
                        content_sha256, department, compartment, doc_type,
                        is_sensitive, is_cloud_stub, extraction_status,
                        current_version, is_deleted, indexed_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, 0, 'pending_stub', 1, 0, ?, ?)
                    """,
                    file_rows,
                )
                conn.executemany(
                    "INSERT INTO files_trigram(doc_id, rel_path, filename) VALUES (?, ?, ?)",
                    trig_rows,
                )
                inserted = len(file_rows)
        return inserted

    def apply_move_or_rename(
        self,
        *,
        doc_id: str,
        abs_path: str,
        rel_path: str,
        filename: str,
        ext: str,
        volume_serial: str,
        file_index: str,
        size_bytes: int,
        mtime_ns: int,
        department: str,
        compartment: str,
        is_sensitive: bool,
        enqueue_engines: tuple[str, ...] = ("tantivy", "hnswlib"),
    ) -> int:
        """Update file location while preserving doc_id and avoiding re-embedding."""
        now = time.time()
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT current_version FROM canonical_files WHERE doc_id = ?",
                (doc_id,),
            ).fetchone()
            new_ver = int(row["current_version"]) + 1 if row else 1
            conn.execute(
                """
                UPDATE canonical_files
                   SET volume_serial = ?, file_index = ?, abs_path = ?, rel_path = ?,
                       filename = ?, ext = ?, size_bytes = ?, mtime_ns = ?,
                       department = ?, compartment = ?, is_sensitive = ?,
                       is_deleted = 0, current_version = ?, updated_at = ?
                 WHERE doc_id = ?
                """,
                (
                    str(volume_serial or "0"),
                    str(file_index or "0"),
                    abs_path,
                    rel_path,
                    filename,
                    ext,
                    size_bytes,
                    mtime_ns,
                    department,
                    compartment,
                    int(is_sensitive),
                    new_ver,
                    now,
                    doc_id,
                ),
            )
            conn.execute(
                "UPDATE canonical_chunks SET file_version = ?, is_deleted = 0 WHERE doc_id = ?",
                (new_ver, doc_id),
            )
            conn.execute("DELETE FROM files_trigram WHERE doc_id = ?", (doc_id,))
            conn.execute(
                "INSERT INTO files_trigram(doc_id, rel_path, filename) VALUES (?, ?, ?)",
                (doc_id, rel_path, filename),
            )
            if not self.is_chunks_fts_retired(conn=conn):
                conn.execute("DELETE FROM chunks_fts WHERE doc_id = ?", (doc_id,))
                chunk_rows = conn.execute(
                    "SELECT chunk_id, content, content_encrypted FROM canonical_chunks WHERE doc_id = ? AND is_deleted = 0",
                    (doc_id,),
                ).fetchall()
                for c in chunk_rows:
                    plain = self._decrypt_content(c["content"], c["content_encrypted"], c["chunk_id"])
                    conn.execute(
                        "INSERT INTO chunks_fts(chunk_id, doc_id, filename, content) VALUES (?, ?, ?, ?)",
                        (c["chunk_id"], doc_id, filename, plain),
                    )
            for engine in enqueue_engines:
                self._enqueue_outbox(
                    conn,
                    doc_id=doc_id,
                    target_version=new_ver,
                    engine_name=engine,
                    op="UPSERT",
                    payload={"reason": "rename_or_move"},
                )
            return new_ver

    def upsert_file_with_chunks(
        self,
        file_rec: CanonicalFileRecord,
        chunks: list[CanonicalChunkRecord],
        *,
        invoices: list[dict[str, Any]] | None = None,
        contracts: list[dict[str, Any]] | None = None,
        entities: list[tuple[str, str]] | None = None,
        enqueue_engines: tuple[str, ...] = ("tantivy", "hnswlib"),
    ) -> tuple[str, int]:
        """Atomically persist canonical file, chunks, structured metadata, and engine outbox."""
        now = time.time()
        with self.transaction() as conn:
            existing = conn.execute(
                "SELECT doc_id, current_version FROM canonical_files WHERE doc_id = ?",
                (file_rec.doc_id,),
            ).fetchone()
            version = int(existing["current_version"]) + 1 if existing else max(1, file_rec.current_version)
            file_rec.current_version = version
            file_rec.updated_at = now
            if file_rec.indexed_at <= 0:
                file_rec.indexed_at = now

            if existing:
                conn.execute(
                    """
                    UPDATE canonical_files
                       SET volume_serial=?, file_index=?, abs_path=?, rel_path=?, filename=?, ext=?,
                           size_bytes=?, mtime_ns=?, content_sha256=?, department=?, compartment=?,
                           doc_type=?, is_sensitive=?, is_cloud_stub=?, extraction_status=?,
                           current_version=?, is_deleted=0, last_error=?, indexed_at=?, updated_at=?
                     WHERE doc_id=?
                    """,
                    (
                        file_rec.volume_serial,
                        file_rec.file_index,
                        file_rec.abs_path,
                        file_rec.rel_path,
                        file_rec.filename,
                        file_rec.ext,
                        file_rec.size_bytes,
                        file_rec.mtime_ns,
                        file_rec.content_sha256,
                        file_rec.department,
                        file_rec.compartment,
                        file_rec.doc_type,
                        int(file_rec.is_sensitive),
                        int(file_rec.is_cloud_stub),
                        file_rec.extraction_status,
                        version,
                        file_rec.last_error,
                        file_rec.indexed_at,
                        now,
                        file_rec.doc_id,
                    ),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO canonical_files (
                        doc_id, tenant_id, user_id, machine_id, workspace_id,
                        volume_serial, file_index, abs_path, rel_path, filename, ext,
                        size_bytes, mtime_ns, content_sha256, department, compartment,
                        doc_type, is_sensitive, is_cloud_stub, extraction_status,
                        current_version, is_deleted, last_error, indexed_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                    """,
                    (
                        file_rec.doc_id,
                        file_rec.tenant_id,
                        file_rec.user_id,
                        file_rec.machine_id,
                        file_rec.workspace_id,
                        file_rec.volume_serial,
                        file_rec.file_index,
                        file_rec.abs_path,
                        file_rec.rel_path,
                        file_rec.filename,
                        file_rec.ext,
                        file_rec.size_bytes,
                        file_rec.mtime_ns,
                        file_rec.content_sha256,
                        file_rec.department,
                        file_rec.compartment,
                        file_rec.doc_type,
                        int(file_rec.is_sensitive),
                        int(file_rec.is_cloud_stub),
                        file_rec.extraction_status,
                        version,
                        file_rec.last_error,
                        file_rec.indexed_at,
                        now,
                    ),
                )

            conn.execute("DELETE FROM canonical_chunks WHERE doc_id = ?", (file_rec.doc_id,))
            fts_active = not self.is_chunks_fts_retired(conn=conn)
            if fts_active:
                conn.execute("DELETE FROM chunks_fts WHERE doc_id = ?", (file_rec.doc_id,))

            for ch in chunks:
                stored_text, is_enc = self._encrypt_content(
                    ch.content, file_rec.is_sensitive, ch.chunk_id
                )
                conn.execute(
                    """
                    INSERT INTO canonical_chunks (
                        chunk_id, doc_id, file_version, chunk_index, page_label,
                        section_label, content, content_encrypted, content_sha256,
                        char_count, embed_eligible, is_deleted
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                    """,
                    (
                        ch.chunk_id,
                        file_rec.doc_id,
                        version,
                        ch.chunk_index,
                        ch.page_label,
                        ch.section_label,
                        stored_text,
                        is_enc,
                        ch.content_sha256,
                        ch.char_count,
                        int(ch.embed_eligible),
                    ),
                )
                if fts_active and not is_enc:
                    conn.execute(
                        "INSERT INTO chunks_fts(chunk_id, doc_id, filename, content) VALUES (?, ?, ?, ?)",
                        (ch.chunk_id, file_rec.doc_id, file_rec.filename, ch.content),
                    )

            conn.execute("DELETE FROM files_trigram WHERE doc_id = ?", (file_rec.doc_id,))
            conn.execute(
                "INSERT INTO files_trigram(doc_id, rel_path, filename) VALUES (?, ?, ?)",
                (file_rec.doc_id, file_rec.rel_path, file_rec.filename),
            )

            conn.execute("DELETE FROM extracted_invoices WHERE doc_id = ?", (file_rec.doc_id,))
            for inv in invoices or []:
                raw_amt = str(inv.get("amount", "") or "").replace(",", "").replace("$", "").replace("₹", "").strip()
                try:
                    num_amt = float("".join(ch for ch in raw_amt if ch.isdigit() or ch in ".-") or "0.0")
                except ValueError:
                    num_amt = 0.0
                inv_num = str(inv.get("invoice_number") or inv.get("id") or "")
                raw_a_str = str(inv.get("amount", "") or "")
                inv_cur = str(inv.get("currency") or ("$" if "$" in raw_a_str else ("INR" if "inr" in raw_a_str.lower() or "₹" in raw_a_str else "USD")))
                conn.execute(
                    """
                    INSERT INTO extracted_invoices (
                        doc_id, invoice_number, vendor, customer, amount,
                        currency, due_date, status, raw_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        file_rec.doc_id,
                        inv_num,
                        str(inv.get("vendor", "")),
                        str(inv.get("customer", "")),
                        num_amt,
                        inv_cur,
                        str(inv.get("due_date", "")),
                        str(inv.get("status", "")),
                        json.dumps(inv),
                    ),
                )

            conn.execute("DELETE FROM extracted_contracts WHERE doc_id = ?", (file_rec.doc_id,))
            for con in contracts or []:
                conn.execute(
                    """
                    INSERT INTO extracted_contracts (
                        doc_id, party, contract_title, effective_date,
                        expiration_date, status, raw_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        file_rec.doc_id,
                        str(con.get("party", "")),
                        str(con.get("contract_title", "")),
                        str(con.get("effective_date", "")),
                        str(con.get("expiration_date", "")),
                        str(con.get("status", "")),
                        json.dumps(con),
                    ),
                )

            conn.execute("DELETE FROM extracted_entities WHERE doc_id = ?", (file_rec.doc_id,))
            for ent_item in entities or []:
                if len(ent_item) >= 3:
                    ent_type, ent_name, ent_payload = ent_item[0], ent_item[1], ent_item[2]
                else:
                    ent_type, ent_name = ent_item[0], ent_item[1]
                    ent_payload = {"name": ent_name}
                conn.execute(
                    """
                    INSERT INTO extracted_entities (doc_id, entity_type, entity_name, normalized_name, raw_json)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (file_rec.doc_id, ent_type, ent_name, ent_name.strip().casefold(), json.dumps(ent_payload or {})),
                )

            for engine in enqueue_engines:
                self._enqueue_outbox(
                    conn,
                    doc_id=file_rec.doc_id,
                    target_version=version,
                    engine_name=engine,
                    op="UPSERT",
                    payload={"compartment": file_rec.compartment},
                )
            return file_rec.doc_id, version

    def mark_file_deleted(
        self,
        doc_id: str,
        *,
        enqueue_engines: tuple[str, ...] = ("tantivy", "hnswlib"),
    ) -> None:
        """Tombstone file + chunks in SQLite and dispatch engine DELETE outbox jobs."""
        now = time.time()
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT current_version, compartment FROM canonical_files WHERE doc_id = ?",
                (doc_id,),
            ).fetchone()
            if row is None:
                return
            next_ver = int(row["current_version"]) + 1
            conn.execute(
                """
                UPDATE canonical_files
                   SET is_deleted = 1, current_version = ?, updated_at = ?
                 WHERE doc_id = ?
                """,
                (next_ver, now, doc_id),
            )
            conn.execute(
                "UPDATE canonical_chunks SET is_deleted = 1 WHERE doc_id = ?",
                (doc_id,),
            )
            conn.execute("DELETE FROM files_trigram WHERE doc_id = ?", (doc_id,))
            if not self.is_chunks_fts_retired(conn=conn):
                conn.execute("DELETE FROM chunks_fts WHERE doc_id = ?", (doc_id,))
            conn.execute("DELETE FROM extracted_invoices WHERE doc_id = ?", (doc_id,))
            conn.execute("DELETE FROM extracted_contracts WHERE doc_id = ?", (doc_id,))
            conn.execute("DELETE FROM extracted_entities WHERE doc_id = ?", (doc_id,))
            for engine in enqueue_engines:
                self._enqueue_outbox(
                    conn,
                    doc_id=doc_id,
                    target_version=next_ver,
                    engine_name=engine,
                    op="DELETE",
                    payload={"compartment": str(row["compartment"])},
                )

    def mark_missing_files_deleted(
        self,
        *,
        workspace_id: str,
        active_rel_paths: set[str],
    ) -> int:
        """Tombstone previously indexed workspace files that no longer exist on disk."""
        rows = self._get_conn().execute(
            "SELECT doc_id, rel_path FROM canonical_files WHERE workspace_id = ? AND is_deleted = 0",
            (workspace_id,),
        ).fetchall()
        removed = 0
        for row in rows:
            if row["rel_path"] not in active_rel_paths:
                self.mark_file_deleted(row["doc_id"])
                removed += 1
        return removed

    def recover_expired_leases(self) -> int:
        """Re-queue outbox jobs left in 'leased' state after an unclean shutdown/crash."""
        now = time.time()
        with self.transaction() as conn:
            cur = conn.execute(
                """
                UPDATE index_outbox
                   SET status = 'retry', lease_expires_at = 0, updated_at = ?
                 WHERE status = 'leased'
                """,
                (now,),
            )
            return int(cur.rowcount or 0)

    def claim_outbox_batch(
        self,
        engine_name: str,
        *,
        limit: int = 32,
        lease_seconds: float = 120.0,
    ) -> list[sqlite3.Row]:
        """Atomically lease due outbox jobs for an indexing engine."""
        now = time.time()
        lease_until = now + lease_seconds
        with self.transaction() as conn:
            rows = conn.execute(
                """
                SELECT * FROM index_outbox
                WHERE engine_name = ?
                  AND (
                        (status IN ('pending', 'retry') AND next_retry_at <= ?)
                     OR (status = 'leased' AND lease_expires_at <= ?)
                  )
                ORDER BY job_id ASC
                LIMIT ?
                """,
                (engine_name, now, now, limit),
            ).fetchall()
            if not rows:
                return []
            ids = [int(r["job_id"]) for r in rows]
            placeholders = ",".join("?" for _ in ids)
            conn.execute(
                f"""
                UPDATE index_outbox
                   SET status = 'leased', lease_expires_at = ?, updated_at = ?
                 WHERE job_id IN ({placeholders})
                """,
                [lease_until, now, *ids],
            )
            return conn.execute(
                f"SELECT * FROM index_outbox WHERE job_id IN ({placeholders}) ORDER BY job_id ASC",
                ids,
            ).fetchall()

    def mark_outbox_done(self, job_id: int, doc_id: str, engine_name: str, synced_version: int) -> None:
        now = time.time()
        with self.transaction() as conn:
            conn.execute(
                """
                UPDATE index_outbox
                   SET status = 'done', lease_expires_at = 0, last_error = NULL, updated_at = ?
                 WHERE job_id = ?
                """,
                (now, job_id),
            )
            conn.execute(
                """
                INSERT INTO engine_sync_state (doc_id, engine_name, synced_version, status, last_error, updated_at)
                VALUES (?, ?, ?, 'synced', NULL, ?)
                ON CONFLICT(doc_id, engine_name) DO UPDATE SET
                    synced_version = MAX(engine_sync_state.synced_version, excluded.synced_version),
                    status = 'synced',
                    last_error = NULL,
                    updated_at = excluded.updated_at
                """,
                (doc_id, engine_name, synced_version, now),
            )

    def mark_outbox_failed(
        self,
        job_id: int,
        doc_id: str,
        engine_name: str,
        error: str,
        *,
        max_attempts: int = 5,
    ) -> str:
        now = time.time()
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT attempts FROM index_outbox WHERE job_id = ?",
                (job_id,),
            ).fetchone()
            attempts = (int(row["attempts"]) if row else 0) + 1
            if attempts >= max_attempts:
                status = "dead_letter"
                next_retry = 0.0
            else:
                status = "retry"
                backoff = min(300.0, 2.0 ** attempts)
                next_retry = now + backoff
            conn.execute(
                """
                UPDATE index_outbox
                   SET status = ?, attempts = ?, next_retry_at = ?, lease_expires_at = 0,
                       last_error = ?, updated_at = ?
                 WHERE job_id = ?
                """,
                (status, attempts, next_retry, error[:500], now, job_id),
            )
            conn.execute(
                """
                INSERT INTO engine_sync_state (doc_id, engine_name, synced_version, status, last_error, updated_at)
                VALUES (?, ?, 0, ?, ?, ?)
                ON CONFLICT(doc_id, engine_name) DO UPDATE SET
                    status = excluded.status,
                    last_error = excluded.last_error,
                    updated_at = excluded.updated_at
                """,
                (doc_id, engine_name, status, error[:500], now),
            )
            return status

    def count_pending_outbox(self, engine_name: str | None = None) -> dict[str, int]:
        conn = self._get_conn()
        if engine_name:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM index_outbox WHERE engine_name = ? AND status IN ('pending','retry','leased')",
                (engine_name,),
            ).fetchone()
            return {engine_name: int(row["cnt"])}
        rows = conn.execute(
            "SELECT engine_name, COUNT(*) AS cnt FROM index_outbox WHERE status IN ('pending','retry','leased') GROUP BY engine_name"
        ).fetchall()
        return {str(r["engine_name"]): int(r["cnt"]) for r in rows}

    def get_file_with_chunks(self, doc_id: str) -> tuple[sqlite3.Row | None, list[dict[str, Any]]]:
        conn = self._get_conn()
        f_row = conn.execute("SELECT * FROM canonical_files WHERE doc_id = ?", (doc_id,)).fetchone()
        if f_row is None:
            return None, []
        c_rows = conn.execute(
            "SELECT * FROM canonical_chunks WHERE doc_id = ? AND is_deleted = 0 ORDER BY chunk_index ASC",
            (doc_id,),
        ).fetchall()
        chunks: list[dict[str, Any]] = []
        for c in c_rows:
            chunks.append(
                {
                    "chunk_id": c["chunk_id"],
                    "doc_id": c["doc_id"],
                    "file_version": int(c["file_version"]),
                    "chunk_index": int(c["chunk_index"]),
                    "page_label": c["page_label"],
                    "section_label": c["section_label"],
                    "content": self._decrypt_content(c["content"], int(c["content_encrypted"]), c["chunk_id"]),
                    "content_sha256": c["content_sha256"],
                    "char_count": int(c["char_count"]),
                    "embed_eligible": bool(c["embed_eligible"]),
                }
            )
        return f_row, chunks

    def get_cached_vectors(
        self,
        hashes: list[str],
        model_id: str = EMBEDDING_MODEL_ID,
    ) -> dict[str, np.ndarray]:
        if not hashes:
            return {}
        unique = list(dict.fromkeys(hashes))
        conn = self._get_conn()
        out: dict[str, np.ndarray] = {}
        for start in range(0, len(unique), 400):
            batch = unique[start : start + 400]
            placeholders = ",".join("?" for _ in batch)
            rows = conn.execute(
                f"""
                SELECT content_sha256, dim, vector_dtype, vector_blob
                FROM vector_cache
                WHERE model_id = ? AND content_sha256 IN ({placeholders})
                """,
                [model_id, *batch],
            ).fetchall()
            for r in rows:
                dtype = np.float16 if r["vector_dtype"] == "float16" else np.float32
                arr = np.frombuffer(r["vector_blob"], dtype=dtype).astype(np.float32)
                out[str(r["content_sha256"])] = arr
        return out

    def put_cached_vectors(
        self,
        items: list[tuple[str, np.ndarray]],
        model_id: str = EMBEDDING_MODEL_ID,
        vector_dtype: str = VECTOR_STORAGE_DTYPE,
    ) -> None:
        if not items:
            return
        now = time.time()
        with self.transaction() as conn:
            for sha, vec in items:
                arr = np.asarray(vec, dtype=np.float32)
                conn.execute(
                    """
                    INSERT INTO vector_cache (content_sha256, model_id, dim, vector_dtype, vector_blob, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(content_sha256, model_id) DO NOTHING
                    """,
                    (sha, model_id, int(arr.shape[0]), vector_dtype, arr.tobytes(), now),
                )

    def fetch_doc_texts_by_doc_ids(self, doc_ids: list[str], *, max_chars_per_doc: int = 80_000) -> dict[str, str]:
        """Return concatenated decrypted chunk text per doc_id for fast multi-chunk validation."""
        if not doc_ids:
            return {}
        conn = self._get_conn()
        out: dict[str, list[str]] = {}
        unique = [d for d in dict.fromkeys(doc_ids) if d]
        for start in range(0, len(unique), 400):
            batch = unique[start : start + 400]
            placeholders = ",".join("?" for _ in batch)
            rows = conn.execute(
                f"""
                SELECT chunk_id, doc_id, content, content_encrypted
                  FROM canonical_chunks
                 WHERE is_deleted = 0 AND doc_id IN ({placeholders})
                 ORDER BY doc_id ASC, chunk_index ASC
                """,
                batch,
            ).fetchall()
            for r in rows:
                did = str(r["doc_id"])
                cur_len = sum(len(x) for x in out.get(did, []))
                if cur_len >= max_chars_per_doc:
                    continue
                txt = self._decrypt_content(r["content"], int(r["content_encrypted"]), r["chunk_id"])
                if txt:
                    out.setdefault(did, []).append(txt)
        return {did: "\n".join(parts)[:max_chars_per_doc] for did, parts in out.items()}

    def fetch_chunks_by_ids(self, chunk_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not chunk_ids:
            return {}
        conn = self._get_conn()
        out: dict[str, dict[str, Any]] = {}
        unique = list(dict.fromkeys(chunk_ids))
        for start in range(0, len(unique), 400):
            batch = unique[start : start + 400]
            placeholders = ",".join("?" for _ in batch)
            rows = conn.execute(
                f"""
                SELECT c.chunk_id, c.doc_id, c.chunk_index, c.page_label, c.section_label,
                       c.content, c.content_encrypted, c.content_sha256,
                       f.rel_path, f.abs_path, f.filename, f.ext, f.size_bytes, f.mtime_ns,
                       f.department, f.compartment, f.doc_type, f.is_sensitive, f.is_deleted
                FROM canonical_chunks c
                JOIN canonical_files f ON f.doc_id = c.doc_id
                WHERE c.chunk_id IN ({placeholders}) AND c.is_deleted = 0 AND f.is_deleted = 0
                """,
                batch,
            ).fetchall()
            for r in rows:
                out[str(r["chunk_id"])] = {
                    "chunk_id": str(r["chunk_id"]),
                    "doc_id": str(r["doc_id"]),
                    "chunk_index": int(r["chunk_index"]),
                    "page_label": str(r["page_label"]),
                    "section_label": str(r["section_label"]),
                    "content": self._decrypt_content(
                        str(r["content"]), int(r["content_encrypted"]), str(r["chunk_id"])
                    ),
                    "rel_path": str(r["rel_path"]),
                    "abs_path": str(r["abs_path"]),
                    "filename": str(r["filename"]),
                    "ext": str(r["ext"]),
                    "size_bytes": int(r["size_bytes"]),
                    "mtime_ns": int(r["mtime_ns"]),
                    "department": str(r["department"]),
                    "compartment": str(r["compartment"]),
                    "doc_type": str(r["doc_type"]),
                    "is_sensitive": bool(r["is_sensitive"]),
                }
        return out

    def search_filename_trigram(
        self,
        query: str,
        *,
        allowed_compartments: tuple[str, ...],
        folder_prefix: str | None = None,
        limit: int = 30,
    ) -> list[EngineHit]:
        """Exact & substring filename match via SQLite FTS5 trigram tokenizer."""
        if not allowed_compartments:
            return []
        tokens = _trigram_safe(query)
        conn = self._get_conn()
        comp_placeholders = ",".join("?" for _ in allowed_compartments)
        hits: list[EngineHit] = []

        if tokens:
            fts_expr = " OR ".join(f'"{t}"' for t in tokens)
            sql = f"""
                SELECT f.doc_id, f.rel_path, f.abs_path, f.filename, f.ext, f.size_bytes,
                       f.mtime_ns, f.department, f.compartment, f.doc_type, f.is_sensitive,
                       bm25(files_trigram, 1.0, 4.0) AS rank_score
                FROM files_trigram
                JOIN canonical_files f ON f.doc_id = files_trigram.doc_id
                WHERE files_trigram MATCH ?
                  AND f.is_deleted = 0
                  AND f.compartment IN ({comp_placeholders})
            """
            params: list[Any] = [fts_expr, *allowed_compartments]
            if folder_prefix:
                sql += " AND lower(f.rel_path) LIKE ?"
                params.append(f"{folder_prefix.strip('/').casefold()}%")
            sql += " ORDER BY rank_score ASC LIMIT ?"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()
        else:
            q_like = f"%{query.strip().casefold()}%"
            if len(q_like) <= 2:
                return []
            sql = f"""
                SELECT doc_id, rel_path, abs_path, filename, ext, size_bytes,
                       mtime_ns, department, compartment, doc_type, is_sensitive,
                       0.0 AS rank_score
                FROM canonical_files
                WHERE is_deleted = 0
                  AND compartment IN ({comp_placeholders})
                  AND (lower(filename) LIKE ? OR lower(rel_path) LIKE ?)
            """
            params = [*allowed_compartments, q_like, q_like]
            if folder_prefix:
                sql += " AND lower(rel_path) LIKE ?"
                params.append(f"{folder_prefix.strip('/').casefold()}%")
            sql += " LIMIT ?"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()

        doc_ids = [str(r["doc_id"]) for r in rows]
        first_chunks: dict[str, str] = {}
        if doc_ids:
            p = ",".join("?" for _ in doc_ids)
            for cr in conn.execute(
                f"""
                SELECT chunk_id, doc_id, content, content_encrypted
                FROM canonical_chunks
                WHERE doc_id IN ({p}) AND is_deleted = 0 AND chunk_index = 0
                """,
                doc_ids,
            ).fetchall():
                first_chunks[str(cr["doc_id"])] = self._decrypt_content(
                    str(cr["content"]), int(cr["content_encrypted"]), str(cr["chunk_id"])
                )

        for idx, r in enumerate(rows, start=1):
            doc_id = str(r["doc_id"])
            raw_bm25 = float(r["rank_score"] or 0.0)
            score = max(0.5, 10.0 - raw_bm25)
            preview = first_chunks.get(doc_id, f"File match: {r['rel_path']}")[:400]
            hits.append(
                EngineHit(
                    chunk_id=f"{doc_id}:fname",
                    doc_id=doc_id,
                    rel_path=str(r["rel_path"]),
                    filename=str(r["filename"]),
                    source_engine="sqlite_trigram",
                    score=score,
                    rank=idx,
                    department=str(r["department"]),
                    compartment=str(r["compartment"]),
                    is_sensitive=bool(r["is_sensitive"]),
                    doc_type=str(r["doc_type"]),
                    snippet=preview,
                    citation=str(r["rel_path"]),
                    content=preview,
                    abs_path=str(r["abs_path"]),
                    ext=str(r["ext"]),
                    size_bytes=int(r["size_bytes"]),
                    mtime_ns=int(r["mtime_ns"]),
                )
            )
        return hits

    def search_chunks_fts(
        self,
        query: str,
        *,
        allowed_compartments: tuple[str, ...],
        folder_prefix: str | None = None,
        limit: int = 30,
    ) -> list[EngineHit]:
        """Search prose chunks via SQLite FTS5 when active (Stage 1 or fallback)."""
        if self.is_chunks_fts_retired() or not allowed_compartments:
            return []
        fts_expr = _normalize_fts_query(query)
        if not fts_expr:
            return []
        conn = self._get_conn()
        comp_placeholders = ",".join("?" for _ in allowed_compartments)
        sql = f"""
            SELECT c.chunk_id, c.doc_id, c.page_label, c.section_label, c.content, c.content_encrypted,
                   f.rel_path, f.abs_path, f.filename, f.ext, f.size_bytes, f.mtime_ns,
                   f.department, f.compartment, f.doc_type, f.is_sensitive,
                   bm25(chunks_fts, 2.0, 1.0) AS rank_score
            FROM chunks_fts
            JOIN canonical_chunks c ON c.chunk_id = chunks_fts.chunk_id
            JOIN canonical_files f ON f.doc_id = c.doc_id
            WHERE chunks_fts MATCH ?
              AND c.is_deleted = 0 AND f.is_deleted = 0
              AND f.compartment IN ({comp_placeholders})
        """
        params: list[Any] = [fts_expr, *allowed_compartments]
        if folder_prefix:
            sql += " AND lower(f.rel_path) LIKE ?"
            params.append(f"{folder_prefix.strip('/').casefold()}%")
        sql += " ORDER BY rank_score ASC LIMIT ?"
        params.append(limit)
        try:
            rows = conn.execute(sql, params).fetchall()
        except sqlite3.OperationalError:
            return []

        hits: list[EngineHit] = []
        for idx, r in enumerate(rows, start=1):
            text = self._decrypt_content(str(r["content"]), int(r["content_encrypted"]), str(r["chunk_id"]))
            cit = f"{r['rel_path']}" + (f" [{r['page_label']}]" if r["page_label"] else "")
            hits.append(
                EngineHit(
                    chunk_id=str(r["chunk_id"]),
                    doc_id=str(r["doc_id"]),
                    rel_path=str(r["rel_path"]),
                    filename=str(r["filename"]),
                    source_engine="sqlite_fts5",
                    score=max(0.1, -float(r["rank_score"] or -1.0)),
                    rank=idx,
                    department=str(r["department"]),
                    compartment=str(r["compartment"]),
                    is_sensitive=bool(r["is_sensitive"]),
                    doc_type=str(r["doc_type"]),
                    page_label=str(r["page_label"]),
                    section_label=str(r["section_label"]),
                    snippet=text[:400],
                    citation=cit,
                    content=text,
                    abs_path=str(r["abs_path"]),
                    ext=str(r["ext"]),
                    size_bytes=int(r["size_bytes"]),
                    mtime_ns=int(r["mtime_ns"]),
                )
            )
        return hits

    def search_vectors_exact(
        self,
        query_vector: np.ndarray,
        *,
        allowed_compartments: tuple[str, ...],
        folder_prefix: str | None = None,
        model_id: str = EMBEDDING_MODEL_ID,
        limit: int = 20,
    ) -> list[EngineHit]:
        """Exact SQLite-filtered cosine rescore for narrow ABAC subsets or cold HNSW fallback."""
        if not allowed_compartments:
            return []
        conn = self._get_conn()
        comp_placeholders = ",".join("?" for _ in allowed_compartments)
        sql = f"""
            SELECT c.chunk_id, c.doc_id, c.page_label, c.section_label, c.content, c.content_encrypted,
                   v.vector_blob, v.vector_dtype,
                   f.rel_path, f.abs_path, f.filename, f.ext, f.size_bytes, f.mtime_ns,
                   f.department, f.compartment, f.doc_type, f.is_sensitive
            FROM canonical_chunks c
            JOIN canonical_files f ON f.doc_id = c.doc_id
            JOIN vector_cache v ON v.content_sha256 = c.content_sha256 AND v.model_id = ?
            WHERE c.is_deleted = 0 AND f.is_deleted = 0 AND c.embed_eligible = 1
              AND f.compartment IN ({comp_placeholders})
        """
        params: list[Any] = [model_id, *allowed_compartments]
        if folder_prefix:
            sql += " AND lower(f.rel_path) LIKE ?"
            params.append(f"{folder_prefix.strip('/').casefold()}%")
        sql += " LIMIT 5000"
        rows = conn.execute(sql, params).fetchall()
        if not rows:
            return []

        q = np.asarray(query_vector, dtype=np.float32).reshape(-1)
        q_norm = float(np.linalg.norm(q))
        if q_norm > 0:
            q = q / q_norm

        vecs = []
        valid_rows = []
        for r in rows:
            dt = np.float16 if r["vector_dtype"] == "float16" else np.float32
            v = np.frombuffer(r["vector_blob"], dtype=dt).astype(np.float32)
            if v.shape[0] == q.shape[0]:
                vecs.append(v)
                valid_rows.append(r)
        if not vecs:
            return []

        mat = np.vstack(vecs)
        scores = mat @ q
        top_idx = np.argsort(-scores)[:limit]
        hits: list[EngineHit] = []
        for rank, i in enumerate(top_idx, start=1):
            r = valid_rows[int(i)]
            sc = float(scores[int(i)])
            text = self._decrypt_content(str(r["content"]), int(r["content_encrypted"]), str(r["chunk_id"]))
            cit = f"{r['rel_path']}" + (f" [{r['page_label']}]" if r["page_label"] else "")
            hits.append(
                EngineHit(
                    chunk_id=str(r["chunk_id"]),
                    doc_id=str(r["doc_id"]),
                    rel_path=str(r["rel_path"]),
                    filename=str(r["filename"]),
                    source_engine="sqlite_vector_exact",
                    score=sc,
                    rank=rank,
                    department=str(r["department"]),
                    compartment=str(r["compartment"]),
                    is_sensitive=bool(r["is_sensitive"]),
                    doc_type=str(r["doc_type"]),
                    page_label=str(r["page_label"]),
                    section_label=str(r["section_label"]),
                    snippet=text[:400],
                    citation=cit,
                    content=text,
                    abs_path=str(r["abs_path"]),
                    ext=str(r["ext"]),
                    size_bytes=int(r["size_bytes"]),
                    mtime_ns=int(r["mtime_ns"]),
                )
            )
        return hits

    def query_structured_invoices(
        self,
        *,
        allowed_compartments: tuple[str, ...],
        overdue_only: bool = False,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        if not allowed_compartments:
            return []
        comp_placeholders = ",".join("?" for _ in allowed_compartments)
        sql = f"""
            SELECT i.*, f.rel_path, f.abs_path, f.filename, f.department, f.compartment, f.is_sensitive, f.ext
            FROM extracted_invoices i
            JOIN canonical_files f ON f.doc_id = i.doc_id
            WHERE f.is_deleted = 0 AND f.compartment IN ({comp_placeholders})
        """
        if overdue_only:
            sql += " AND lower(i.status) LIKE '%overdue%'"
        sql += " LIMIT ?"
        rows = self._get_conn().execute(sql, [*allowed_compartments, limit]).fetchall()
        out = []
        for r in rows:
            item = json.loads(r["raw_json"] or "{}")
            inv_id = str(item.get("id") or item.get("invoice_number") or r["invoice_number"] or r["filename"])
            item.setdefault("id", inv_id)
            item.setdefault("invoice_number", inv_id)
            item.setdefault("vendor", r["vendor"])
            item.setdefault("customer", r["customer"])
            item.setdefault("due_date", r["due_date"])
            item.setdefault("status", r["status"])
            item.setdefault("currency", r["currency"])
            item.update(
                {
                    "doc_id": r["doc_id"],
                    "rel_path": r["rel_path"],
                    "file_path": r["rel_path"],
                    "abs_path": r["abs_path"],
                    "filename": r["filename"],
                    "ext": r["ext"],
                    "department": r["department"],
                    "compartment": r["compartment"],
                    "is_sensitive": bool(r["is_sensitive"]),
                }
            )
            out.append(item)
        return out

    def query_structured_entities(
        self,
        *,
        allowed_compartments: tuple[str, ...],
        entity_type: str | None = None,
    ) -> list[dict[str, Any]]:
        if not allowed_compartments:
            return []
        comp_placeholders = ",".join("?" for _ in allowed_compartments)
        sql = f"""
            SELECT e.entity_type, e.entity_name, e.raw_json,
                   f.doc_id, f.rel_path, f.abs_path, f.filename, f.department, f.compartment, f.is_sensitive, f.ext
            FROM extracted_entities e
            JOIN canonical_files f ON f.doc_id = e.doc_id
            WHERE f.is_deleted = 0 AND f.compartment IN ({comp_placeholders})
        """
        params: list[Any] = [*allowed_compartments]
        if entity_type:
            sql += " AND lower(e.entity_type) = ?"
            params.append(entity_type.strip().casefold())
        rows = self._get_conn().execute(sql, params).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                payload = json.loads(r["raw_json"] or "{}")
            except Exception:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            payload.setdefault("name", r["entity_name"])
            payload["entity_type"] = r["entity_type"]
            payload["doc_id"] = r["doc_id"]
            payload["rel_path"] = r["rel_path"]
            payload["abs_path"] = r["abs_path"]
            payload["filename"] = r["filename"]
            payload["department"] = payload.get("department") or r["department"]
            payload["file_department"] = r["department"]
            payload["compartment"] = r["compartment"]
            payload["is_sensitive"] = bool(r["is_sensitive"])
            payload["ext"] = r["ext"]
            out.append(payload)
        return out

    def fetch_docs_for_structured_scan(
        self,
        *,
        allowed_compartments: tuple[str, ...],
        keywords: tuple[str, ...] = (),
        limit_files: int = 300,
    ) -> list[dict[str, Any]]:
        """Assemble full-text document dicts from SQLite chunks for fallback numeric/invoice evaluation."""
        if not allowed_compartments:
            return []
        comp_placeholders = ",".join("?" for _ in allowed_compartments)
        sql = f"""
            SELECT doc_id, rel_path, abs_path, filename, ext, department, compartment, is_sensitive
            FROM canonical_files
            WHERE is_deleted = 0 AND compartment IN ({comp_placeholders})
        """
        params: list[Any] = [*allowed_compartments]
        if keywords:
            like_clauses = " OR ".join("(lower(filename) LIKE ? OR lower(rel_path) LIKE ?)" for _ in keywords)
            sql += f" AND ({like_clauses})"
            for kw in keywords:
                lk = f"%{kw.casefold()}%"
                params.extend([lk, lk])
        sql += " LIMIT ?"
        params.append(limit_files)
        f_rows = self._get_conn().execute(sql, params).fetchall()
        if not f_rows:
            return []
        doc_ids = [str(r["doc_id"]) for r in f_rows]
        by_doc: dict[str, list[str]] = {did: [] for did in doc_ids}
        for start in range(0, len(doc_ids), 300):
            batch = doc_ids[start : start + 300]
            ph = ",".join("?" for _ in batch)
            c_rows = self._get_conn().execute(
                f"""
                SELECT chunk_id, doc_id, content, content_encrypted
                FROM canonical_chunks
                WHERE doc_id IN ({ph}) AND is_deleted = 0
                ORDER BY chunk_index ASC
                """,
                batch,
            ).fetchall()
            for cr in c_rows:
                txt = self._decrypt_content(str(cr["content"]), int(cr["content_encrypted"]), str(cr["chunk_id"]))
                by_doc[str(cr["doc_id"])].append(txt)
        docs: list[dict[str, Any]] = []
        for fr in f_rows:
            did = str(fr["doc_id"])
            docs.append({
                "doc_id": did,
                "filename": str(fr["filename"]),
                "relative_path": str(fr["rel_path"]),
                "full_path": str(fr["abs_path"]),
                "abs_path": str(fr["abs_path"]),
                "ext": str(fr["ext"]),
                "folder": str(fr["department"]),
                "department": str(fr["department"]),
                "compartment": str(fr["compartment"]),
                "is_sensitive": bool(fr["is_sensitive"]),
                "content": "\n".join(by_doc.get(did, [])),
            })
        return docs

    def query_aggregated_entities(
        self,
        *,
        allowed_compartments: tuple[str, ...],
    ) -> dict[str, Any]:
        conn = self._get_conn()
        total_files = int(
            conn.execute(
                "SELECT COUNT(*) AS cnt FROM canonical_files WHERE is_deleted = 0"
            ).fetchone()["cnt"]
        )
        if not allowed_compartments:
            return {"scanned_files": total_files, "employees": [], "customers": [], "vendors": []}
        comp_placeholders = ",".join("?" for _ in allowed_compartments)
        rows = conn.execute(
            f"""
            SELECT e.entity_type, e.entity_name, f.rel_path
            FROM extracted_entities e
            JOIN canonical_files f ON f.doc_id = e.doc_id
            WHERE f.is_deleted = 0 AND f.compartment IN ({comp_placeholders})
            """,
            allowed_compartments,
        ).fetchall()
        grouped: dict[str, set[str]] = {"employee": set(), "customer": set(), "vendor": set()}
        for r in rows:
            et = str(r["entity_type"]).casefold()
            if et in grouped:
                grouped[et].add(str(r["entity_name"]))
        return {
            "scanned_files": total_files,
            "employees": sorted(grouped["employee"]),
            "customers": sorted(grouped["customer"]),
            "vendors": sorted(grouped["vendor"]),
        }

    def get_folder_stats(self, *, allowed_compartments: tuple[str, ...] | None = None) -> dict[str, Any]:
        conn = self._get_conn()
        if allowed_compartments:
            p = ",".join("?" for _ in allowed_compartments)
            rows = conn.execute(
                f"SELECT department, COUNT(*) AS cnt FROM canonical_files WHERE is_deleted = 0 AND compartment IN ({p}) GROUP BY department",
                allowed_compartments,
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT department, COUNT(*) AS cnt FROM canonical_files WHERE is_deleted = 0 GROUP BY department"
            ).fetchall()
        categories = {str(r["department"]): int(r["cnt"]) for r in rows}
        return {"total_files": sum(categories.values()), "categories": categories}

    def collect_health(self, workspace_id: str) -> IndexingHealthStatus:
        conn = self._get_conn()
        f_stats = conn.execute(
            """
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN extraction_status = 'indexed' THEN 1 ELSE 0 END) AS indexed,
                SUM(CASE WHEN is_cloud_stub = 1 THEN 1 ELSE 0 END) AS stubs,
                SUM(CASE WHEN extraction_status = 'error' THEN 1 ELSE 0 END) AS failed
            FROM canonical_files
            WHERE is_deleted = 0
            """
        ).fetchone()
        c_total = int(
            conn.execute("SELECT COUNT(*) AS cnt FROM canonical_chunks WHERE is_deleted = 0").fetchone()["cnt"]
        )
        v_count = int(conn.execute("SELECT COUNT(*) AS cnt FROM vector_cache").fetchone()["cnt"])
        pending_rows = conn.execute(
            "SELECT engine_name, COUNT(*) AS cnt FROM index_outbox WHERE status IN ('pending','retry','leased') GROUP BY engine_name"
        ).fetchall()
        dlq_rows = conn.execute(
            "SELECT engine_name, COUNT(*) AS cnt FROM index_outbox WHERE status = 'dead_letter' GROUP BY engine_name"
        ).fetchall()
        return IndexingHealthStatus(
            workspace_id=workspace_id,
            total_files=int(f_stats["total"] or 0),
            indexed_files=int(f_stats["indexed"] or 0),
            cloud_stub_files=int(f_stats["stubs"] or 0),
            failed_files=int(f_stats["failed"] or 0),
            total_chunks=c_total,
            embedded_chunks=v_count,
            outbox_pending={str(r["engine_name"]): int(r["cnt"]) for r in pending_rows},
            outbox_dead_letter={str(r["engine_name"]): int(r["cnt"]) for r in dlq_rows},
            fts5_chunks_retired=self.is_chunks_fts_retired(conn=conn),
        )

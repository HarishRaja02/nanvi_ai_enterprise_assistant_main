from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

from .catalog import CatalogStore
from .governor import ResourceGovernor
from .tantivy_engine import TantivyBM25Engine

logger = logging.getLogger(__name__)


class OutboxDispatcher:
    """Durable, crash-recoverable SQLite outbox processor for Tantivy and HNSW."""

    def __init__(
        self,
        catalog: CatalogStore,
        tantivy_engine: TantivyBM25Engine,
        governor: ResourceGovernor,
        *,
        vector_engine: Any | None = None,
    ) -> None:
        self.catalog = catalog
        self.tantivy = tantivy_engine
        self.governor = governor
        self.vector = vector_engine
        self._stop_event = threading.Event()
        self._wake_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._drain_lock = threading.Lock()
        self._pending_hnsw_acks: list[tuple[int, str, int]] = []
        self._hnsw_dirty_since: float = 0.0
        self.catalog.recover_expired_leases()

    def attach_vector_engine(self, vector_engine: Any) -> None:
        self.vector = vector_engine

    def trigger(self) -> None:
        self._wake_event.set()

    def start_background(self, poll_seconds: float = 1.5) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop,
            args=(poll_seconds,),
            name="nanvi-outbox-dispatcher",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout_s: float = 5.0) -> None:
        self._stop_event.set()
        self._wake_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=timeout_s)
        self._thread = None
        self.flush_hnsw()

    def _flush_hnsw_locked(self) -> None:
        if not self._pending_hnsw_acks:
            return
        pending = list(self._pending_hnsw_acks)
        try:
            if self.vector is not None:
                self.vector.persist_all()
            for job_id, doc_id, ver in pending:
                self.catalog.mark_outbox_done(job_id, doc_id, "hnswlib", ver)
        except Exception as save_exc:
            for job_id, doc_id, _ver in pending:
                self.catalog.mark_outbox_failed(job_id, doc_id, "hnswlib", str(save_exc))
        finally:
            self._pending_hnsw_acks.clear()
            self._hnsw_dirty_since = 0.0

    def flush_hnsw(self) -> None:
        with self._drain_lock:
            self._flush_hnsw_locked()

    def _run_loop(self, poll_seconds: float) -> None:
        while not self._stop_event.is_set():
            try:
                did_work = self.drain_once(respect_governor=True)
                if did_work > 0:
                    continue
                self.flush_hnsw()
            except Exception as exc:  # pragma: no cover
                logger.warning("Outbox dispatcher cycle failed: %s", exc)
            self._wake_event.wait(timeout=poll_seconds)
            self._wake_event.clear()

    def drain_once(
        self,
        *,
        batch_size: int = 24,
        respect_governor: bool = True,
    ) -> int:
        """Process at most one batch per active engine. Returns jobs processed."""
        with self._drain_lock:
            processed = 0
            if self.tantivy.available:
                if respect_governor:
                    allowed, _reason = self.governor.check_indexing_allowed()
                    if not allowed:
                        self.governor.wait_if_preempted(0.1)
                        return 0
                processed += self._drain_tantivy_batch(batch_size=batch_size)

            if self.vector is not None and getattr(self.vector, "available", False):
                if respect_governor:
                    allowed, _reason = self.governor.check_indexing_allowed()
                    if not allowed:
                        self.governor.wait_if_preempted(0.1)
                        return processed
                processed += self._drain_hnsw_batch(batch_size=batch_size)

            self._maybe_retire_redundant_fts()
            return processed

    def drain_all(
        self,
        *,
        max_batches: int = 200,
        respect_governor: bool = False,
    ) -> int:
        """Drain queued outbox work synchronously (used by warm/tests/reindex)."""
        total = 0
        try:
            for _ in range(max_batches):
                if self._stop_event.is_set():
                    break
                count = self.drain_once(respect_governor=respect_governor)
                if count == 0:
                    break
                total += count
        finally:
            self.flush_hnsw()
        return total

    def _drain_tantivy_batch(self, batch_size: int) -> int:
        jobs = self.catalog.claim_outbox_batch("tantivy", limit=batch_size)
        if not jobs:
            return 0

        succeeded: list[tuple[int, str, int]] = []
        failed: list[tuple[int, str, str]] = []

        for job in jobs:
            job_id = int(job["job_id"])
            doc_id = str(job["doc_id"])
            op = str(job["op"])
            target_version = int(job["target_version"])
            try:
                if op == "DELETE":
                    self.tantivy.delete_document(doc_id, commit=False)
                    succeeded.append((job_id, doc_id, target_version))
                    continue

                f_row, chunks = self.catalog.get_file_with_chunks(doc_id)
                if f_row is None or int(f_row["is_deleted"]) == 1:
                    self.tantivy.delete_document(doc_id, commit=False)
                    succeeded.append((job_id, doc_id, target_version))
                    continue

                self.tantivy.upsert_document(
                    doc_id=doc_id,
                    filename=str(f_row["filename"]),
                    rel_path=str(f_row["rel_path"]),
                    compartment=str(f_row["compartment"]),
                    department=str(f_row["department"]),
                    doc_type=str(f_row["doc_type"]),
                    is_sensitive=bool(f_row["is_sensitive"]),
                    chunks=chunks,
                    commit=False,
                )
                succeeded.append((job_id, doc_id, int(f_row["current_version"])))
            except Exception as exc:
                failed.append((job_id, doc_id, str(exc)))

        if succeeded:
            try:
                self.tantivy.commit()
                for job_id, doc_id, ver in succeeded:
                    self.catalog.mark_outbox_done(job_id, doc_id, "tantivy", ver)
            except Exception as commit_exc:
                for job_id, doc_id, _ver in succeeded:
                    self.catalog.mark_outbox_failed(job_id, doc_id, "tantivy", str(commit_exc))

        for job_id, doc_id, err in failed:
            self.catalog.mark_outbox_failed(job_id, doc_id, "tantivy", err)

        return len(jobs)

    def _drain_hnsw_batch(self, batch_size: int) -> int:
        if self.vector is None:
            return 0
        jobs = self.catalog.claim_outbox_batch("hnswlib", limit=batch_size)
        if not jobs:
            self._flush_hnsw_locked()
            return 0

        succeeded: list[tuple[int, str, int]] = []
        failed: list[tuple[int, str, str]] = []

        for job in jobs:
            job_id = int(job["job_id"])
            doc_id = str(job["doc_id"])
            op = str(job["op"])
            target_version = int(job["target_version"])
            payload = {}
            try:
                payload = json.loads(job["payload_json"] or "{}")
            except Exception:
                pass

            try:
                if op == "DELETE":
                    self.vector.delete_document(doc_id, compartment=payload.get("compartment"))
                    succeeded.append((job_id, doc_id, target_version))
                    continue

                f_row, chunks = self.catalog.get_file_with_chunks(doc_id)
                if f_row is None or int(f_row["is_deleted"]) == 1:
                    self.vector.delete_document(doc_id, compartment=payload.get("compartment"))
                    succeeded.append((job_id, doc_id, target_version))
                    continue

                compartment = str(f_row["compartment"])
                eligible = [c for c in chunks if c.get("embed_eligible", True) and str(c.get("content", "")).strip()]
                if not eligible:
                    self.vector.delete_document(doc_id, compartment=compartment)
                    succeeded.append((job_id, doc_id, int(f_row["current_version"])))
                    continue

                # Check content-addressed SQLite vector_cache first to skip redundant ONNX passes.
                hashes = [str(c["content_sha256"]) for c in eligible]
                cached = self.catalog.get_cached_vectors(hashes, model_id=self.vector.model_id)
                missing = [c for c in eligible if str(c["content_sha256"]) not in cached]

                if missing:
                    if not self.vector.ensure_model_ready():
                        # Model unavailable offline before first download; re-queue with retry without failing data.
                        raise RuntimeError("semantic_model_not_cached_offline")
                    texts = [str(c["content"]) for c in missing]
                    vecs = self.vector.embed_texts(texts)
                    to_cache = [
                        (str(chunk["content_sha256"]), vec)
                        for chunk, vec in zip(missing, vecs)
                    ]
                    self.catalog.put_cached_vectors(
                        to_cache,
                        model_id=self.vector.model_id,
                        vector_dtype=self.vector.storage_dtype,
                    )
                    for sha, vec in to_cache:
                        cached[sha] = vec

                chunk_vectors = [
                    (str(c["chunk_id"]), cached[str(c["content_sha256"])])
                    for c in eligible
                    if str(c["content_sha256"]) in cached
                ]
                self.vector.upsert_document_vectors(
                    doc_id=doc_id,
                    compartment=compartment,
                    chunk_vectors=chunk_vectors,
                    save=False,
                )
                succeeded.append((job_id, doc_id, int(f_row["current_version"])))
            except Exception as exc:
                failed.append((job_id, doc_id, str(exc)))

        if succeeded:
            self._pending_hnsw_acks.extend(succeeded)
            if self._hnsw_dirty_since == 0.0:
                self._hnsw_dirty_since = time.monotonic()
            if (
                len(self._pending_hnsw_acks) >= 240
                or len(jobs) < batch_size
                or (time.monotonic() - self._hnsw_dirty_since) >= 40.0
            ):
                self._flush_hnsw_locked()

        for job_id, doc_id, err in failed:
            self.catalog.mark_outbox_failed(job_id, doc_id, "hnswlib", err)

        return len(jobs)

    def _maybe_retire_redundant_fts(self) -> None:
        if not self.tantivy.available or self.catalog.is_chunks_fts_retired():
            return
        pending = self.catalog.count_pending_outbox("tantivy").get("tantivy", 0)
        if pending == 0 and self.tantivy.num_docs() > 0:
            self.catalog.retire_chunks_fts()


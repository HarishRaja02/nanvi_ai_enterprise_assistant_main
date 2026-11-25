from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import gc
import logging
import os
from pathlib import Path
import re
import threading
import time
from typing import Any, Callable
import uuid

import numpy as np

from backend.integrations.files.company_data.extraction import (
    _evaluate_invoice_dates_and_overdue,
    _parse_numeric_amount,
    aggregate_entities_from_documents,
    filter_entities_by_numeric_query,
    format_structured_invoice_analysis,
)
from backend.retrieval.semantic import (
    detect_entity_aggregation_intent,
    expand_semantic_tokens,
    is_overdue_invoice_query,
    normalize_query_typos,
    parse_numeric_filter_query,
    parse_query_constraints,
    parse_structured_invoice_filter,
    semantic_text_similarity,
    tokenize_for_search,
    validate_text_against_constraints,
)

from .catalog import CatalogStore
from .governor import ResourceGovernor, detect_hardware_profile
from .models import (
    CanonicalFileRecord,
    EngineHit,
    IndexingHealthStatus,
    ResourceProfile,
    SearchFilter,
    UnifiedSearchResult,
)
from .outbox import OutboxDispatcher
from .parsers import (
    IMAGE_EXTENSIONS,
    SUPPORTED_EXTENSIONS,
    compute_sha256_streaming,
    extract_ntfs_identity,
    extract_structured_metadata,
    infer_doc_type,
    parse_file_to_chunks,
)
from .security import (
    IGNORED_DIR_NAMES,
    LocalPayloadCipher,
    _blocked_windows_roots,
    authorize_document_access,
    classify_file_compartment,
    compute_workspace_id,
    get_machine_id,
    harden_directory_acl,
    is_blocked_system_path,
    is_cloud_placeholder,
    resolve_allowed_compartments,
    resolve_local_data_dir,
    resolve_model_cache_dir,
    resolve_workspace_data_dir,
    validate_scan_root,
)
from .tantivy_engine import TantivyBM25Engine
from .vector_engine import PartitionedVectorEngine
from .watcher import WorkspaceFileWatcher

logger = logging.getLogger(__name__)

_ENTERPRISE_IMAGE_HINTS = (
    "invoice",
    "receipt",
    "bill",
    "contract",
    "agreement",
    "statement",
    "report",
    "tax",
    "cheque",
    "check",
    "payslip",
    "salary",
    "purchase",
)

ID_TOKEN_RE = re.compile(
    r"\b(?:"
    r"(?:Customer|Employee|Project|Account|Vendor|Contract|Invoice|Bill|Task|Order)[-_ ]\d{1,6}(?:[-_][A-Za-z0-9]+)*|"
    r"(?:INV|PO|SO|CNT|CTR|CONTRACT|EMP|NDA|PUR|CUST|PRJ|DOC|TKT|TX|TAX|REF|P)[-_ ]?\d{1,8}(?:[-_][A-Za-z0-9]+)*"
    r")\b",
    re.IGNORECASE,
)
EXT_TOKEN_RE = re.compile(
    r"\b[\w.-]+\.(?:pdf|docx?|xlsx?|csv|txt|md|pptx|py|ts|json|png|jpe?g|webp|bmp|tiff?|gif)\b",
    re.IGNORECASE,
)
_SEARCH_NOISE_WORDS = frozenset({
    "can", "i", "you", "me", "we", "our", "my", "please", "find", "search", "show",
    "get", "give", "list", "look", "locate", "another", "other", "more", "some", "any",
    "all", "the", "a", "an", "that", "this", "these", "those", "they", "them", "their",
    "was", "were", "is", "are", "be", "been", "being", "do", "does", "did", "have", "has",
    "had", "already", "just", "only", "like", "with", "for", "from", "in", "on", "at",
    "by", "to", "of", "and", "or", "file", "files", "document", "documents", "created",
})


def _extract_core_search_terms(query: str) -> list[str]:
    norm_q = normalize_query_typos(query or "")
    toks = re.findall(r"[a-z0-9]+(?:[-_][a-z0-9]+)*", norm_q.casefold())
    core = [t for t in toks if len(t) >= 2 and t not in _SEARCH_NOISE_WORDS]
    if not core:
        core = [t for t in toks if len(t) >= 2]
    return list(dict.fromkeys(core))


def _id_matches_target(id_tok: str, text_low: str) -> bool:
    """Strictly check delimited or punctuation-normalized ID presence (so NDA-0008 never matches EMP-0008 or NDA-0001)."""
    if not id_tok or not text_low:
        return False
    id_low = id_tok.casefold()
    t_low = text_low.casefold()
    if re.search(rf"(?<![a-z0-9]){re.escape(id_low)}(?![a-z0-9])", t_low):
        return True
    norm_id = re.sub(r"[-_\s]+", "", id_low)
    norm_txt = re.sub(r"[-_\s]+", "", t_low)
    if norm_id and norm_id in norm_txt:
        return True
    # Enterprise prefix alias normalization: "Customer 001" -> "cust001", "Employee 1005" -> "emp1005"
    alias_map = {
        "customer": "cust",
        "employee": "emp",
        "project": "prj",
        "contract": "cnt",
        "invoice": "inv",
        "purchase": "pur",
    }
    for full_pref, short_pref in alias_map.items():
        if norm_id.startswith(full_pref):
            short_id = short_pref + norm_id[len(full_pref):]
            if short_id in norm_txt:
                return True
        elif norm_id.startswith(short_pref):
            full_id = full_pref + norm_id[len(short_pref):]
            if full_id in norm_txt:
                return True
    return False


def _classify_query_intent(query: str) -> dict[str, Any]:
    raw_q = (query or "").strip()
    norm_q = normalize_query_typos(raw_q)
    is_q = bool(re.search(r"^(?:what|which|who|whom|whose|where|when|why|how|is|are|was|were|can|does|do|did|tell\s+me)\b", norm_q.casefold())) or "?" in raw_q
    return {
        "normalized_query": norm_q,
        "core_terms": _extract_core_search_terms(norm_q),
        "is_exact_id": bool(ID_TOKEN_RE.search(raw_q)),
        "is_question": is_q,
        "is_filename_hint": bool(EXT_TOKEN_RE.search(raw_q)) or "/" in raw_q or "\\" in raw_q,
        "is_overdue_invoice": is_overdue_invoice_query(norm_q),
        "invoice_filter": parse_structured_invoice_filter(raw_q),
        "numeric_filter": parse_numeric_filter_query(norm_q),
        "entity_kind": detect_entity_aggregation_intent(norm_q),
        "token_count": len(norm_q.split()),
    }


def _format_overdue_summary(invoices: list[dict[str, Any]]) -> str:
    if not invoices:
        return ""
    lines = ["Structured Invoice Summary (Local Catalog):"]
    for inv in invoices[:15]:
        num = inv.get("invoice_number") or inv.get("filename") or "Invoice"
        party = inv.get("vendor") or inv.get("customer") or "Unknown"
        amt = inv.get("amount", "")
        cur = inv.get("currency", "")
        due = inv.get("due_date", "")
        st = inv.get("status", "")
        lines.append(f"- {num} — {party} · {cur} {amt} · Due: {due} · Status: {st}".strip())
    return "\n".join(lines)


class DesktopSearchWorkspace:
    """Self-contained local multi-engine search stack for one approved desktop folder."""

    def __init__(
        self,
        folder_path: str | Path,
        *,
        tenant_id: str = "default-tenant",
        user_id: str = "desktop-user",
        local_data_dir: str | Path | None = None,
        profile: ResourceProfile | None = None,
        encrypt_sensitive: bool = False,
        allow_model_download: bool = True,
        embed_fn: Callable[[list[str]], np.ndarray] | None = None,
        start_watcher: bool = True,
        start_background_workers: bool = True,
        cipher_key_bytes: bytes | None = None,
    ) -> None:
        self.local_data_dir = resolve_local_data_dir(local_data_dir)
        self.root_path = validate_scan_root(folder_path, local_data_dir=self.local_data_dir)
        self.tenant_id = tenant_id
        self.user_id = user_id
        self.machine_id = get_machine_id()
        self.workspace_id = compute_workspace_id(self.root_path, tenant_id=tenant_id)
        self.index_dir = resolve_workspace_data_dir(self.workspace_id, self.local_data_dir)
        harden_directory_acl(self.index_dir)

        self.profile = profile or detect_hardware_profile()
        self.governor = ResourceGovernor(self.index_dir, profile=self.profile)

        cipher = None
        if encrypt_sensitive:
            cipher = LocalPayloadCipher(
                key_bytes=cipher_key_bytes,
                key_path=self.local_data_dir / "local_index.key",
            )

        self.catalog = CatalogStore(
            self.index_dir / "catalog.sqlite3",
            cipher=cipher,
            encrypt_sensitive=encrypt_sensitive,
        )
        self.tantivy = TantivyBM25Engine(
            self.index_dir / "tantivy",
            heap_bytes=self.profile.tantivy_heap_bytes,
        )
        self.vector = PartitionedVectorEngine(
            self.index_dir / "hnsw",
            model_cache_dir=resolve_model_cache_dir(self.local_data_dir),
            profile=self.profile,
            embed_fn=embed_fn,
            allow_model_download=allow_model_download,
        )
        self.outbox = OutboxDispatcher(
            self.catalog,
            self.tantivy,
            self.governor,
            vector_engine=self.vector,
        )
        self._scan_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._scan_thread: threading.Thread | None = None
        self._watcher: WorkspaceFileWatcher | None = None
        root_str = str(self.root_path)
        self._root_prefix = root_str if root_str.endswith(os.sep) else (root_str + os.sep)
        self._root_prefix_cf = self._root_prefix.casefold()

        if start_background_workers:
            self.outbox.start_background()
        if start_watcher:
            self._watcher = WorkspaceFileWatcher(
                self.root_path,
                on_events=self._handle_watcher_events,
                local_data_dir=self.local_data_dir,
            )
            self._watcher.start()

    def close(self) -> None:
        self._stop_event.set()
        if self._watcher is not None:
            self._watcher.stop()
        scan_t = self._scan_thread
        if scan_t is not None and scan_t.is_alive():
            scan_t.join(timeout=5.0)
        self._scan_thread = None
        self.outbox.stop()
        self.vector.persist_all()
        self.tantivy.close()
        self.catalog.close()

    def _fast_rel_path(self, abs_path: Path) -> str:
        raw = str(abs_path)
        if raw.casefold().startswith(self._root_prefix_cf):
            return raw[len(self._root_prefix) :].replace("\\", "/")
        return abs_path.resolve().relative_to(self.root_path).as_posix()

    def _to_rel_path(self, abs_path: Path) -> str:
        return self._fast_rel_path(abs_path)

    def _discover_candidate_files(self) -> list[Path]:
        discovered: list[Path] = []
        blocked_prefixes = tuple(
            p.rstrip("\\/")
            for p in (
                str(self.local_data_dir.resolve()).casefold(),
                *(str(r).casefold() for r in _blocked_windows_roots()),
            )
            if p
        )
        stack: list[tuple[str, int]] = [(str(self.root_path), 0)]
        max_depth = 22

        while stack:
            cur_dir, depth = stack.pop()
            try:
                with os.scandir(cur_dir) as it:
                    entries = list(it)
            except OSError:
                continue

            for entry in entries:
                name = entry.name
                if not name or name.startswith("$"):
                    continue
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                except OSError:
                    continue
                if is_dir:
                    if depth >= max_depth:
                        continue
                    if name.casefold() in IGNORED_DIR_NAMES:
                        continue
                    ep_cf = entry.path.casefold()
                    if any(
                        ep_cf == bp or ep_cf.startswith(bp + os.sep) or ep_cf.startswith(bp + "/")
                        for bp in blocked_prefixes
                    ):
                        continue
                    stack.append((entry.path, depth + 1))
                    continue

                if name.startswith("~$") or name.endswith((".tmp", ".crdownload", ".part")):
                    continue
                try:
                    if not entry.is_file(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                dot = name.rfind(".")
                if dot == -1:
                    continue
                if name[dot:].casefold() in SUPPORTED_EXTENSIONS:
                    discovered.append(Path(entry.path))
        return discovered

    def ingest_single_file(
        self,
        file_path: Path,
        *,
        allow_ocr: bool = True,
        max_ocr_pages: int = 80,
    ) -> str:
        """Evaluate 3-layer file identity and index/move/skip a single file atomically."""
        resolved = file_path.resolve()
        if not resolved.exists() or not resolved.is_file():
            return "missing"
        if resolved.suffix.casefold() not in SUPPORTED_EXTENSIONS:
            return "unsupported"
        if is_blocked_system_path(
            resolved,
            local_data_dir=self.local_data_dir,
            scan_root=self.root_path,
        ):
            return "blocked"

        rel_path = self._to_rel_path(resolved)
        department, compartment, is_sensitive = classify_file_compartment(
            rel_path, resolved.name, self.root_path.name
        )

        vol, ino, size_bytes, mtime_ns = extract_ntfs_identity(resolved)

        # Skip OneDrive / Cloud Files placeholders cleanly without forcing hydration downloads.
        if is_cloud_placeholder(resolved):
            self.catalog.register_cloud_stub(
                tenant_id=self.tenant_id,
                user_id=self.user_id,
                machine_id=self.machine_id,
                workspace_id=self.workspace_id,
                abs_path=str(resolved),
                rel_path=rel_path,
                filename=resolved.name,
                ext=resolved.suffix.casefold(),
                size_bytes=size_bytes,
                mtime_ns=mtime_ns,
                department=department,
                compartment=compartment,
                is_sensitive=is_sensitive,
            )
            return "cloud_stub"

        existing_at_path = self.catalog.lookup_active_by_path(
            tenant_id=self.tenant_id,
            user_id=self.user_id,
            machine_id=self.machine_id,
            workspace_id=self.workspace_id,
            rel_path=rel_path,
        )
        if (
            existing_at_path is not None
            and int(existing_at_path["size_bytes"]) == size_bytes
            and int(existing_at_path["mtime_ns"]) == mtime_ns
            and not int(existing_at_path["is_cloud_stub"])
            and str(existing_at_path["extraction_status"]) == "indexed"
        ):
            return "unchanged"

        # Fast-path move/rename detection via NTFS (volume_serial, file_index) before hashing.
        if existing_at_path is None:
            moved_row = self.catalog.find_move_candidate(
                workspace_id=self.workspace_id,
                volume_serial=vol,
                file_index=ino,
                rel_path=rel_path,
            )
            if (
                moved_row is not None
                and int(moved_row["size_bytes"]) == size_bytes
                and int(moved_row["mtime_ns"]) == mtime_ns
                and str(moved_row["extraction_status"]) == "indexed"
            ):
                self.catalog.apply_move_or_rename(
                    doc_id=str(moved_row["doc_id"]),
                    abs_path=str(resolved),
                    rel_path=rel_path,
                    filename=resolved.name,
                    ext=resolved.suffix.casefold(),
                    volume_serial=vol,
                    file_index=ino,
                    size_bytes=size_bytes,
                    mtime_ns=mtime_ns,
                    department=department,
                    compartment=compartment,
                    is_sensitive=is_sensitive,
                )
                return "moved"

        sha256 = compute_sha256_streaming(resolved)

        # Even if mtime touched or Safe-Save replaced file with identical bytes, avoid re-parsing.
        if existing_at_path is not None and str(existing_at_path["content_sha256"]) == sha256 and str(existing_at_path["extraction_status"]) == "indexed":
            self.catalog.apply_move_or_rename(
                doc_id=str(existing_at_path["doc_id"]),
                abs_path=str(resolved),
                rel_path=rel_path,
                filename=resolved.name,
                ext=resolved.suffix.casefold(),
                volume_serial=vol,
                file_index=ino,
                size_bytes=size_bytes,
                mtime_ns=mtime_ns,
                department=department,
                compartment=compartment,
                is_sensitive=is_sensitive,
                enqueue_engines=(),
            )
            return "unchanged"

        if existing_at_path is None:
            hash_moved = self.catalog.find_move_candidate(
                workspace_id=self.workspace_id,
                volume_serial="0",
                file_index="0",
                rel_path=rel_path,
                content_sha256=sha256,
            )
            if hash_moved is not None and str(hash_moved["extraction_status"]) == "indexed":
                self.catalog.apply_move_or_rename(
                    doc_id=str(hash_moved["doc_id"]),
                    abs_path=str(resolved),
                    rel_path=rel_path,
                    filename=resolved.name,
                    ext=resolved.suffix.casefold(),
                    volume_serial=vol,
                    file_index=ino,
                    size_bytes=size_bytes,
                    mtime_ns=mtime_ns,
                    department=department,
                    compartment=compartment,
                    is_sensitive=is_sensitive,
                )
                return "moved"

        doc_id = str(existing_at_path["doc_id"]) if existing_at_path is not None else uuid.uuid4().hex
        next_ver = int(existing_at_path["current_version"]) + 1 if existing_at_path is not None else 1

        file_rec = CanonicalFileRecord(
            doc_id=doc_id,
            tenant_id=self.tenant_id,
            user_id=self.user_id,
            machine_id=self.machine_id,
            workspace_id=self.workspace_id,
            volume_serial=vol,
            file_index=ino,
            abs_path=str(resolved),
            rel_path=rel_path,
            filename=resolved.name,
            ext=resolved.suffix.casefold(),
            size_bytes=size_bytes,
            mtime_ns=mtime_ns,
            content_sha256=sha256,
            department=department,
            compartment=compartment,
            doc_type=infer_doc_type(resolved.suffix.casefold(), resolved.name, rel_path),
            is_sensitive=is_sensitive,
            is_cloud_stub=False,
            extraction_status="indexed",
            current_version=next_ver,
            is_deleted=False,
        )

        try:
            chunks, preview_text = parse_file_to_chunks(
                resolved,
                file_rec,
                target_chars=self.profile.chunk_target_chars,
                overlap_chars=self.profile.chunk_overlap_chars,
                max_file_mb=self.profile.max_single_file_mb,
                allow_ocr=allow_ocr,
                max_ocr_pages=max_ocr_pages,
            )
            invoices, contracts, entities = extract_structured_metadata(file_rec, preview_text)
        except Exception as exc:
            file_rec.extraction_status = "error"
            file_rec.last_error = str(exc)[:400]
            self.catalog.upsert_file_with_chunks(
                file_rec,
                [],
                enqueue_engines=(),
            )
            return "error"

        self.catalog.upsert_file_with_chunks(
            file_rec,
            chunks,
            invoices=invoices,
            contracts=contracts,
            entities=entities,
        )
        return "indexed"

    def _handle_watcher_events(self, events: list[tuple[str, Path]]) -> None:
        changed = False
        for kind, path in events:
            try:
                if kind == "deleted":
                    resolved = path.resolve()
                    rel = self._to_rel_path(resolved)
                    row = self.catalog.lookup_active_by_path(
                        tenant_id=self.tenant_id,
                        user_id=self.user_id,
                        machine_id=self.machine_id,
                        workspace_id=self.workspace_id,
                        rel_path=rel,
                    )
                    if row is not None and not resolved.exists():
                        self.catalog.mark_file_deleted(str(row["doc_id"]))
                        changed = True
                else:
                    res = self.ingest_single_file(path)
                    if res in {"indexed", "moved", "cloud_stub"}:
                        changed = True
            except Exception as exc:
                logger.debug("Watcher event failed for %s: %s", path, exc)
        if changed:
            self.outbox.trigger()

    def scan_and_sync(
        self,
        *,
        drain_outbox: bool = True,
        respect_governor: bool = False,
    ) -> dict[str, Any]:
        """Scan folder incrementally, reconcile moves/deletes, and optionally drain outbox."""
        started = time.perf_counter()
        counts = {
            "discovered": 0,
            "indexed": 0,
            "moved": 0,
            "unchanged": 0,
            "cloud_stub": 0,
            "deleted": 0,
            "error": 0,
            "paused_reason": None,
        }
        with self._scan_lock:
            if self._stop_event.is_set():
                counts["paused_reason"] = "shutdown_requested"
                counts["elapsed_ms"] = int((time.perf_counter() - started) * 1000)
                return counts
            candidates = self._discover_candidate_files()
            counts["discovered"] = len(candidates)
            active_rels: set[str] = set()
            is_bulk_partition = len(candidates) > 1500
            stub_items: list[dict[str, Any]] = []
            root_name = self.root_path.name

            for p in candidates:
                rel = self._fast_rel_path(p)
                active_rels.add(rel)
                if len(candidates) > 200:
                    ext = p.suffix.casefold()
                    department, compartment, is_sensitive = classify_file_compartment(rel, p.name, root_name)
                    stub_items.append(
                        {
                            "abs_path": str(p),
                            "rel_path": rel,
                            "filename": p.name,
                            "ext": ext,
                            "department": department,
                            "compartment": compartment,
                            "doc_type": infer_doc_type(ext, p.name, rel),
                            "is_sensitive": is_sensitive,
                        }
                    )

            if stub_items and not self._stop_event.is_set():
                self.catalog.register_discovered_stubs_batch(
                    tenant_id=self.tenant_id,
                    user_id=self.user_id,
                    machine_id=self.machine_id,
                    workspace_id=self.workspace_id,
                    items=stub_items,
                )

            # Reconcile deletions FIRST or handle moves smartly: process adds/moves first so
            # (volume_serial, file_index) finds existing rows before they get marked deleted!
            batch_size = max(1, min(self.profile.parse_workers * 4, 24))
            paused_during_scan = False
            pdf_ocr_cap = 3 if is_bulk_partition else 80

            def _should_ocr_file(fp: Path) -> bool:
                if not is_bulk_partition:
                    return True
                ext_cf = fp.suffix.casefold()
                if ext_cf in IMAGE_EXTENSIONS:
                    low_name = fp.name.casefold()
                    return any(h in low_name for h in _ENTERPRISE_IMAGE_HINTS)
                return True

            with ThreadPoolExecutor(max_workers=self.profile.parse_workers) as pool:
                for batch_idx, start in enumerate(range(0, len(candidates), batch_size)):
                    if self._stop_event.is_set():
                        counts["paused_reason"] = "shutdown_requested"
                        paused_during_scan = True
                        break
                    if respect_governor:
                        preempt_waits = 0
                        while True:
                            if self._stop_event.is_set():
                                counts["paused_reason"] = "shutdown_requested"
                                paused_during_scan = True
                                break
                            allowed, reason = self.governor.check_indexing_allowed()
                            if allowed:
                                break
                            if reason == "preempted_for_active_search":
                                if preempt_waits >= 40:
                                    counts["paused_reason"] = reason
                                    paused_during_scan = True
                                    break
                                self.governor.wait_if_preempted(0.20)
                                preempt_waits += 1
                                continue
                            if reason and reason.startswith("ram_budget_exceeded"):
                                gc.collect()
                                time.sleep(0.25)
                                allowed_after, reason_after = self.governor.check_indexing_allowed()
                                if allowed_after:
                                    break
                                counts["paused_reason"] = reason_after
                                paused_during_scan = True
                                break
                            counts["paused_reason"] = reason
                            paused_during_scan = True
                            break
                        if paused_during_scan:
                            break
                    slice_paths = candidates[start : start + batch_size]
                    futures = [
                        pool.submit(
                            self.ingest_single_file,
                            p,
                            allow_ocr=_should_ocr_file(p),
                            max_ocr_pages=pdf_ocr_cap,
                        )
                        for p in slice_paths
                    ]
                    for fut in as_completed(futures):
                        status = fut.result()
                        if status in counts:
                            counts[status] += 1
                    if not drain_outbox and is_bulk_partition and batch_idx > 0 and batch_idx % 8 == 0:
                        self.outbox.trigger()
                    if is_bulk_partition and batch_idx > 0 and batch_idx % 150 == 0:
                        gc.collect()

            # Only prune deleted paths if full scan completed without resource pause!
            if not paused_during_scan and not self._stop_event.is_set():
                counts["deleted"] = self.catalog.mark_missing_files_deleted(
                    workspace_id=self.workspace_id,
                    active_rel_paths=active_rels,
                )

            if not self._stop_event.is_set():
                if drain_outbox and not paused_during_scan:
                    self.outbox.drain_all(respect_governor=respect_governor)
                else:
                    self.outbox.trigger()

        counts["elapsed_ms"] = int((time.perf_counter() - started) * 1000)
        return counts

    def is_scanning(self) -> bool:
        return self._scan_lock.locked()

    def start_background_scan(
        self,
        *,
        drain_outbox: bool = False,
        respect_governor: bool = True,
    ) -> threading.Thread | None:
        if self._scan_lock.locked():
            return None
        self._stop_event.clear()
        t = threading.Thread(
            target=self.scan_and_sync,
            kwargs={"drain_outbox": drain_outbox, "respect_governor": respect_governor},
            name=f"scan-{self.workspace_id}",
            daemon=True,
        )
        self._scan_thread = t
        t.start()
        return t

    def health(self) -> IndexingHealthStatus:
        st = self.catalog.collect_health(self.workspace_id)
        st.tantivy_available = self.tantivy.available
        st.hnsw_available = self.vector.available
        st.semantic_model_ready = self.vector.is_semantic_model_ready()
        st.watcher_active = bool(self._watcher and self._watcher.active)
        st.rss_mb = self.governor.current_rss_mb()
        st.disk_free_mb = self.governor.disk_free_mb()
        st.profile_tier = self.profile.tier
        st.is_scanning = self.is_scanning()
        allowed, reason = self.governor.check_indexing_allowed()
        st.paused_reason = None if allowed else reason
        return st

    def _run_numeric_filter_search(
        self,
        *,
        sf: SearchFilter,
        numeric_spec: dict[str, Any],
        allowed_compartments: tuple[str, ...],
        folder_stats: dict[str, Any],
        aggregated_entities: dict[str, Any],
        effective_offset: int,
        effective_page_size: int,
        generation_mode: str,
        offline_mode: bool,
        started: float,
    ) -> UnifiedSearchResult | None:
        domain = str(numeric_spec.get("domain") or "employees")
        if domain not in ("employees", "customers"):
            return None
        field = str(numeric_spec.get("field") or "salary")
        op = str(numeric_spec.get("op") or "gt")
        min_val = numeric_spec.get("min_val")
        max_val = numeric_spec.get("max_val")
        sort_dir = str(numeric_spec.get("sort_dir") or "desc")
        top_n = numeric_spec.get("top_n")
        dept_filter = str(numeric_spec.get("dept_filter") or "").casefold()

        ent_type = "employee" if domain == "employees" else "customer"
        raw_ents = self.catalog.query_structured_entities(
            allowed_compartments=allowed_compartments,
            entity_type=ent_type,
        )
        # Keep only RBAC-authorized entity rows that actually contain a numeric field
        auth_docs_cache: list[dict[str, Any]] = []
        dedup: dict[str, dict[str, Any]] = {}
        file_meta_by_rel: dict[str, dict[str, Any]] = {}
        for row in raw_ents:
            if not authorize_document_access(
                sf,
                doc_id=str(row.get("doc_id", "")),
                rel_path=str(row.get("rel_path", "")),
                department=str(row.get("file_department") or row.get("department") or "General"),
                is_sensitive=bool(row.get("is_sensitive", True)),
            ):
                continue
            rel = str(row.get("rel_path") or "")
            if rel and rel not in file_meta_by_rel:
                file_meta_by_rel[rel] = {
                    "doc_id": row.get("doc_id", ""),
                    "filename": row.get("filename", Path(rel).name),
                    "rel_path": rel,
                    "abs_path": row.get("abs_path") or str((self.root_path / rel).resolve()),
                    "ext": row.get("ext", Path(rel).suffix.casefold()),
                    "department": row.get("file_department") or row.get("department") or "General",
                }
            num_v = row.get(field)
            if not isinstance(num_v, (int, float)):
                raw_fallback = row.get("salary_display") if field == "salary" else row.get("value_display")
                num_v = _parse_numeric_amount(raw_fallback)
            key = str(row.get("id") or row.get("name") or "").strip().upper()
            if not key:
                continue
            prev = dedup.get(key)
            if prev is None:
                item = dict(row)
                item[field] = num_v
                item["files"] = [rel] if rel else []
                dedup[key] = item
            else:
                if num_v is not None and prev.get(field) is None:
                    prev[field] = num_v
                for k in ("department", "role", "status", "salary_display", "value_display", "segment", "city"):
                    if row.get(k) and not prev.get(k):
                        prev[k] = row.get(k)
                if rel and rel not in prev["files"] and len(prev["files"]) < 8:
                    prev["files"].append(rel)

        records_with_num = [r for r in dedup.values() if isinstance(r.get(field), (int, float))]

        # Fallback for existing v1 SQLite catalogs that predate entity raw_json storage
        if not records_with_num:
            kw_hints = ("employee", "emp", "hr", "attendance", "salary") if domain == "employees" else ("customer", "client", "directory")
            scanned_docs = self.catalog.fetch_docs_for_structured_scan(
                allowed_compartments=allowed_compartments,
                keywords=kw_hints,
                limit_files=300,
            )
            auth_docs_cache = [
                d for d in scanned_docs
                if authorize_document_access(
                    sf,
                    doc_id=str(d.get("doc_id", "")),
                    rel_path=str(d.get("relative_path", "")),
                    department=str(d.get("department", "General")),
                    is_sensitive=bool(d.get("is_sensitive", True)),
                )
            ]
            for d in auth_docs_cache:
                file_meta_by_rel[str(d["relative_path"])] = {
                    "doc_id": d["doc_id"],
                    "filename": d["filename"],
                    "rel_path": d["relative_path"],
                    "abs_path": d["abs_path"],
                    "ext": d["ext"],
                    "department": d["department"],
                }
            f_res = filter_entities_by_numeric_query(
                auth_docs_cache,
                numeric_spec,
                offset=effective_offset,
                limit=max(25, effective_page_size),
            )
            total_scanned = int(f_res["total_scanned_records"])
            matched_recs = list(f_res["records"])
            total_matching = int(f_res["total_matching"])
            max_observed = f_res["max_observed"]
            breakdown = dict(f_res["breakdown"])
            matched_rel_files = list(f_res["source_files"])
            scanned_file_count = int(f_res["scanned_files"])
        else:
            status_filter = str(numeric_spec.get("status_filter") or "").casefold()
            filtered_items: list[dict[str, Any]] = []
            max_observed = None
            total_scanned = 0
            for item in records_with_num:
                val = float(item[field])
                if dept_filter:
                    d_low = str(item.get("department") or item.get("segment") or "").casefold()
                    r_low = str(item.get("role") or "").casefold()
                    if dept_filter not in d_low and dept_filter not in r_low:
                        continue
                if status_filter:
                    st_low = str(item.get("status") or item.get("segment") or "").casefold()
                    if status_filter not in st_low:
                        continue
                total_scanned += 1
                if max_observed is None or val > max_observed:
                    max_observed = val
                keep = False
                if op == "gt" and min_val is not None:
                    keep = val > float(min_val)
                elif op == "ge" and min_val is not None:
                    keep = val >= float(min_val)
                elif op == "lt" and max_val is not None:
                    keep = val < float(max_val)
                elif op == "le" and max_val is not None:
                    keep = val <= float(max_val)
                elif op == "between" and min_val is not None and max_val is not None:
                    keep = float(min_val) <= val <= float(max_val)
                elif op == "rank":
                    keep = True
                if keep:
                    filtered_items.append(item)

            filtered_items.sort(key=lambda r: float(r.get(field) or 0.0), reverse=(sort_dir != "asc"))
            if op == "rank" and isinstance(top_n, int) and top_n > 0:
                filtered_items = filtered_items[:top_n]
            total_matching = len(filtered_items)
            matched_recs = filtered_items[effective_offset : effective_offset + max(25, effective_page_size)]
            breakdown = {}
            matched_rel_files = []
            seen_rel: set[str] = set()
            group_key = "department" if domain == "employees" else "segment"
            for item in filtered_items:
                g = str(item.get(group_key) or "").strip()
                if g:
                    breakdown[g] = breakdown.get(g, 0) + 1
                for fp in item.get("files") or []:
                    if fp not in seen_rel:
                        seen_rel.add(fp)
                        matched_rel_files.append(fp)
            scanned_file_count = len(file_meta_by_rel)

        if total_scanned == 0:
            if records_with_num and (dept_filter or numeric_spec.get("status_filter")):
                qual_desc = " / ".join(q for q in (numeric_spec.get("status_filter"), dept_filter) if q)
                return UnifiedSearchResult(
                    folder_path=str(self.root_path),
                    files=[],
                    chunks=[],
                    total_matches=0,
                    offset=effective_offset,
                    page_size=effective_page_size,
                    has_more=False,
                    all_ranked_files=[],
                    structured_summary=(
                        f"Evaluated **{len(records_with_num)}** unique {domain} records and found **0 {domain}** matching `{qual_desc}`."
                    ),
                    aggregated_entities=aggregated_entities,
                    folder_stats=folder_stats,
                    zero_match=False,
                    elapsed_ms=int((time.perf_counter() - started) * 1000),
                    engines_used=["sqlite_structured"],
                    degraded_engines=[],
                    engine_latencies_ms={"sqlite_structured": int((time.perf_counter() - started) * 1000)},
                    compartments_searched=list(allowed_compartments),
                    offline_mode=offline_mode,
                    generation_mode=generation_mode,
                    semantic_model_ready=self.vector.is_semantic_model_ready(),
                )
            return None

        lbl_field = "Annual Value" if field == "annual_value" else "Salary"
        all_ranked_files: list[dict[str, Any]] = []
        top_chunks: list[dict[str, Any]] = []

        if total_matching > 0:
            bd_str = ", ".join(f"{k}: {v}" for k, v in list(breakdown.items())[:8])
            bd_str = ", ".join(f"{k}: {v}" for k, v in list(breakdown.items())[:5])
            summary_lines = [
                f"Evaluated **{total_scanned}** unique {domain} records across **{scanned_file_count or folder_stats.get('total_files', 0)}** authorized files: "
                f"found **{total_matching} unique {domain}** matching your {lbl_field.lower()} filter"
                f"Found **{total_matching} {domain}** matching your {lbl_field.lower()} filter"
                + (f" ({bd_str})" if bd_str else "")
                + ".",
                + f" across **{scanned_file_count or folder_stats.get('total_files', 0)}** files:",
                + f" across **{scanned_file_count or folder_stats.get('total_files', 0)}** authorized files:",
            ]
            for rec in matched_recs[:20]:
            if total_matching > 5:
                summary_lines.append("**Key Highlights**")
            for rec in matched_recs[:5]:
                v_num = rec.get(field)
                v_str = f"INR {int(v_num):,}" if isinstance(v_num, (int, float)) and float(v_num).is_integer() else (
                    f"{v_num:,.2f}" if isinstance(v_num, (int, float)) else str(rec.get("salary_display") or rec.get("value_display") or "")
                )
                bits = [b for b in (rec.get("id"), rec.get("department") or rec.get("segment"), rec.get("role"), rec.get("status")) if b]
                meta_short = " · ".join(b for b in (rec.get("id"), rec.get("department") or rec.get("segment")) if b)
                src_fp = (rec.get("files") or [""])[0]
                src_name = Path(src_fp).name if src_fp else ""
                summary_lines.append(
                    f"- **{rec.get('name') or rec.get('id')}** ({' · '.join(bits)}) — {lbl_field}: **{v_str}**"
                    + (f" · File: `{src_fp}`" if src_fp else "")
                    f"• **{rec.get('name') or rec.get('id')}**"
                    + (f" ({meta_short})" if meta_short else "")
                    + f" · **{v_str}**"
                    + (f" (`{src_name}`)" if src_name else "")
                )
            if total_matching > 20:
                summary_lines.append(f"*... and {total_matching - 20} more qualifying {domain} records matched.*")
            if total_matching > 5:
                summary_lines.extend([
                    "",
                    f"| Name | ID | Department | Role | {lbl_field} | Source |",
                    "| --- | --- | --- | --- | --- | --- |",
                ])
                for rec in matched_recs[:25]:
                    v_num = rec.get(field)
                    v_str = f"INR {int(v_num):,}" if isinstance(v_num, (int, float)) and float(v_num).is_integer() else (
                        f"{v_num:,.2f}" if isinstance(v_num, (int, float)) else str(rec.get("salary_display") or rec.get("value_display") or "—")
                    )
                    src_fp = (rec.get("files") or [""])[0]
                    src_name = Path(src_fp).name if src_fp else "—"
                    summary_lines.append(
                        f"| {str(rec.get('name') or rec.get('id') or '—').replace('|', '/')} | "
                        f"{str(rec.get('id') or '—').replace('|', '/')} | "
                        f"{str(rec.get('department') or rec.get('segment') or '—').replace('|', '/')} | "
                        f"{str(rec.get('role') or '—').replace('|', '/')} | "
                        f"{v_str} | {src_name} |"
                    )
            structured_summary = "\n".join(summary_lines)

            for idx_f, rel in enumerate(matched_rel_files):
                fm = file_meta_by_rel.get(rel) or {}
                abs_p = fm.get("abs_path") or str((self.root_path / rel).resolve())
                fn = fm.get("filename") or Path(rel).name
                samples = [
                    r for r in matched_recs
                    if rel in (r.get("files") or [])
                ][:3]
                snip = " | ".join(
                    f"{r.get('name') or r.get('id')} ({r.get('department') or ''}): {r.get(field):,.0f}"
                    for r in samples
                    if isinstance(r.get(field), (int, float))
                ) or f"Contains qualifying {domain} records matching {lbl_field} filter."
                all_ranked_files.append({
                    "name": fn,
                    "path": rel,
                    "full_path": abs_p,
                    "display_path": f"{self.root_path.name}/{rel}",
                    "type": fm.get("ext") or Path(fn).suffix.casefold(),
                    "open_url": f"/api/sources/{fm.get('doc_id', f'num-{idx_f}')}",
                    "source": "sqlite_structured",
                    "department": fm.get("department", "HR"),
                    "match_type": "content",
                    "content_snippet": snip,
                    "score": 1.0,
                })
                if len(top_chunks) < max(1, top_chunks_limit):
                    top_chunks.append({
                        "chunk_id": f"struct-num:{idx_f}",
                        "folder_path": str(self.root_path),
                        "relative_path": rel,
                        "filename": fn,
                        "citation": abs_p,
                        "text": structured_summary if idx_f == 0 else snip,
                        "engine": "sqlite_structured",
                        "score": 1.0,
                    })
        else:
            max_disp = f"INR {int(max_observed):,}" if max_observed is not None else "N/A"
            if op in ("gt", "ge") and min_val is not None:
                cond_disp = f"{'>=' if op == 'ge' else '>'} {int(min_val):,}" + (f" ({min_val / 100_000:.1f} LPA)" if min_val >= 100_000 else "")
            elif op in ("lt", "le") and max_val is not None:
                cond_disp = f"{'<=' if op == 'le' else '<'} {int(max_val):,}"
            else:
                cond_disp = "your criteria"
            structured_summary = (
                f"Evaluated all **{total_scanned}** unique {domain} records across **{scanned_file_count or folder_stats.get('total_files', 0)}** authorized files "
                f"and found **0 {domain}** matching `{lbl_field.lower()} {cond_disp}`.\n\n"
                f"• **Highest recorded {lbl_field.lower()} in this folder:** **{max_disp}**"
                + (f" (~{max_observed / 100_000:.2f} LPA)" if max_observed and domain == "employees" else "")
                + "."
            )

        total_matches = len(all_ranked_files)
        paged_files = all_ranked_files[effective_offset : effective_offset + effective_page_size]
        has_more = (effective_offset + effective_page_size) < total_matches
        return UnifiedSearchResult(
            folder_path=str(self.root_path),
            files=paged_files,
            chunks=top_chunks,
            total_matches=total_matches,
            offset=effective_offset,
            page_size=effective_page_size,
            has_more=has_more,
            all_ranked_files=all_ranked_files,
            structured_summary=structured_summary,
            aggregated_entities=aggregated_entities,
            folder_stats=folder_stats,
            zero_match=False,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
            engines_used=["sqlite_structured"],
            degraded_engines=[],
            engine_latencies_ms={"sqlite_structured": int((time.perf_counter() - started) * 1000)},
            compartments_searched=list(allowed_compartments),
            offline_mode=offline_mode,
            generation_mode=generation_mode,
            semantic_model_ready=self.vector.is_semantic_model_ready(),
        )

    def _run_structured_invoice_search(
        self,
        *,
        sf: SearchFilter,
        invoice_spec: dict[str, Any],
        allowed_compartments: tuple[str, ...],
        folder_stats: dict[str, Any],
        aggregated_entities: dict[str, Any],
        effective_offset: int,
        effective_page_size: int,
        top_chunks_limit: int,
        generation_mode: str,
        offline_mode: bool,
        started: float,
    ) -> UnifiedSearchResult | None:
        raw_invs = self.catalog.query_structured_invoices(
            allowed_compartments=allowed_compartments,
            overdue_only=False,
            limit=500,
        )
        auth_invs = [
            inv for inv in raw_invs
            if authorize_document_access(
                sf,
                doc_id=str(inv.get("doc_id", "")),
                rel_path=str(inv.get("rel_path", "")),
                department=str(inv.get("department", "Finance")),
                is_sensitive=bool(inv.get("is_sensitive", True)),
            )
        ]

        # Ensure invoice_date & CSV schedule rows exist even on pre-existing v1 SQLite catalogs
        if not auth_invs or not any(inv.get("invoice_date") for inv in auth_invs):
            from backend.integrations.files.company_data.extraction import extract_invoice_records_from_files
            scan_docs = self.catalog.fetch_docs_for_structured_scan(
                allowed_compartments=allowed_compartments,
                keywords=("invoice", "payment", "billing"),
                limit_files=250,
            )
            docs_map = {
                str(d["relative_path"]): d
                for d in scan_docs
                if authorize_document_access(
                    sf,
                    doc_id=str(d.get("doc_id", "")),
                    rel_path=str(d.get("relative_path", "")),
                    department=str(d.get("department", "Finance")),
                    is_sensitive=bool(d.get("is_sensitive", True)),
                )
            }
            if docs_map:
                extracted_invs, _ = extract_invoice_records_from_files(
                    docs_map,
                    lambda _u, _f: True,
                    UserAttributes(sf.user_id, sf.tenant_id, sf.department, frozenset()),
                    limit=500,
                )
                if extracted_invs:
                    for item in extracted_invs:
                        meta = docs_map.get(item.get("file_path", ""), {})
                        item.setdefault("doc_id", meta.get("doc_id", ""))
                        item.setdefault("rel_path", item.get("file_path", ""))
                        item.setdefault("abs_path", meta.get("abs_path", ""))
                        item.setdefault("filename", meta.get("filename") or Path(item.get("file_path", "")).name)
                        item.setdefault("department", meta.get("department", "Finance"))
                        item.setdefault("ext", meta.get("ext", ".pdf"))
                    auth_invs = extracted_invs

        if not auth_invs:
            return None

        # Refresh status & dates dynamically against today's date, deduplicating canonical invoice IDs
        dedup_invs: dict[str, dict[str, Any]] = {}
        files_by_id: dict[str, list[dict[str, Any]]] = {}
        for inv in auth_invs:
            iid = str(inv.get("id") or inv.get("invoice_number") or inv.get("filename") or "")
            eff_st, n_inv_dt, n_due_dt, is_ov, days_ov = _evaluate_invoice_dates_and_overdue(
                status=str(inv.get("raw_status") or inv.get("status") or ""),
                invoice_date_raw=str(inv.get("invoice_date") or ""),
                due_date_raw=str(inv.get("due_date") or ""),
                payment_terms_raw=str(inv.get("payment_terms") or ""),
            )
            norm_rec = dict(inv)
            norm_rec["id"] = iid
            norm_rec["status"] = eff_st
            norm_rec["invoice_date"] = n_inv_dt
            norm_rec["due_date"] = n_due_dt
            norm_rec["is_overdue"] = is_ov
            norm_rec["days_overdue"] = days_ov
            if "has_explicit_customer" not in norm_rec:
                c_val = str(norm_rec.get("customer") or "").strip()
                v_val = str(norm_rec.get("vendor") or "").strip()
                norm_rec["has_explicit_customer"] = bool(c_val and c_val != v_val and c_val != "Enterprise Client")

            files_by_id.setdefault(iid, []).append(norm_rec)
            # Prefer root Finance/ copy over subdirectory duplicate when deduplicating by ID
            prev = dedup_invs.get(iid)
            if prev is None or (norm_rec.get("rel_path", "").count("/") < prev.get("rel_path", "").count("/")):
                dedup_invs[iid] = norm_rec

        summary_body, matched_recs = format_structured_invoice_analysis(
            list(dedup_invs.values()),
            invoice_spec,
        )
        if not matched_recs and not invoice_spec.get("status_filter") and invoice_spec.get("year") is None and not invoice_spec.get("group_by"):
            return None
        structured_summary = f"Structured Invoice Summary (Local Catalog):\n{summary_body}"
        structured_summary = f"Structured Invoice Summary:\n\n{summary_body}"

        all_ranked_files: list[dict[str, Any]] = []
        seen_paths: set[str] = set()
        top_chunks: list[dict[str, Any]] = []

        for idx_r, rec in enumerate(matched_recs):
            iid = str(rec.get("id") or "")
            rel = str(rec.get("rel_path") or rec.get("file_path") or "")
            abs_p = str(rec.get("abs_path") or rec.get("full_path") or (self.root_path / rel).resolve())
            path_key = rel.casefold()
            if not rel or path_key in seen_paths:
                continue
            seen_paths.add(path_key)
            fn = str(rec.get("filename") or Path(rel).name)
            snip = (
                f"{iid} · {rec.get('customer') or rec.get('vendor')} · {rec.get('amount')} · "
                f"Status: {rec.get('status')}"
                + (f" · Inv Date: {rec.get('invoice_date')}" if rec.get("invoice_date") else "")
                + (f" · Due: {rec.get('due_date')}" if rec.get("due_date") else "")
            )
            all_ranked_files.append({
                "name": fn,
                "path": rel,
                "full_path": abs_p,
                "display_path": f"{self.root_path.name}/{rel}",
                "type": str(rec.get("ext") or Path(fn).suffix.casefold() or ".pdf"),
                "open_url": f"/api/sources/{rec.get('doc_id', f'inv-{idx_r}')}",
                "source": "sqlite_structured",
                "department": str(rec.get("department") or "Finance"),
                "match_type": "name" if "invoice" in fn.casefold() else "content",
                "content_snippet": snip,
                "score": 1.0,
            })
            if len(top_chunks) < max(1, top_chunks_limit):
                top_chunks.append({
                    "chunk_id": f"struct-inv:{idx_r}",
                    "folder_path": str(self.root_path),
                    "relative_path": rel,
                    "filename": fn,
                    "citation": abs_p,
                    "text": structured_summary if idx_r == 0 else snip,
                    "engine": "sqlite_structured",
                    "score": 1.0,
                })

        total_matches = len(all_ranked_files)
        paged_files = all_ranked_files[effective_offset : effective_offset + effective_page_size]
        has_more = (effective_offset + effective_page_size) < total_matches
        return UnifiedSearchResult(
            folder_path=str(self.root_path),
            files=paged_files,
            chunks=top_chunks,
            total_matches=total_matches,
            offset=effective_offset,
            page_size=effective_page_size,
            has_more=has_more,
            all_ranked_files=all_ranked_files,
            structured_summary=structured_summary,
            aggregated_entities=aggregated_entities,
            folder_stats=folder_stats,
            zero_match=False,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
            engines_used=["sqlite_structured"],
            degraded_engines=[],
            engine_latencies_ms={"sqlite_structured": int((time.perf_counter() - started) * 1000)},
            compartments_searched=list(allowed_compartments),
            offline_mode=offline_mode,
            generation_mode=generation_mode,
            semantic_model_ready=self.vector.is_semantic_model_ready(),
        )

    def search(
        self,
        query: str,
        *,
        search_filter: SearchFilter | None = None,
        offset: int = 0,
        page_size: int = 10,
        top_chunks_limit: int = 8,
        top_files_limit: int = 10,
        generation_mode: str = "retrieval_only",
        offline_mode: bool = True,
    ) -> UnifiedSearchResult:
        """Execute the 9-step unified multi-engine local desktop search."""
        started = time.perf_counter()
        sf = search_filter or SearchFilter(tenant_id=self.tenant_id, user_id=self.user_id)
        intent = _classify_query_intent(query)
        allowed_compartments = resolve_allowed_compartments(sf)
        folder_prefix = sf.folder_prefix
        effective_page_size = max(1, min(int(top_files_limit or page_size or 10), 50))
        effective_offset = max(0, int(offset or 0))

        aggregated_entities = self.catalog.query_aggregated_entities(
            allowed_compartments=allowed_compartments
        )
        folder_stats = self.catalog.get_folder_stats(allowed_compartments=allowed_compartments)

        # Deterministic precision short-circuit for numeric filters ("salary > 30lpa")
        numeric_spec = intent.get("numeric_filter")
        if numeric_spec and not intent["is_exact_id"] and not intent["is_filename_hint"]:
            num_res = self._run_numeric_filter_search(
                sf=sf,
                numeric_spec=numeric_spec,
                allowed_compartments=allowed_compartments,
                folder_stats=folder_stats,
                aggregated_entities=aggregated_entities,
                effective_offset=effective_offset,
                effective_page_size=effective_page_size,
                generation_mode=generation_mode,
                offline_mode=offline_mode,
                started=started,
            )
            if num_res is not None:
                return num_res

        # Deterministic precision short-circuit for structured invoice filters ("already paid", "didn't pay customers", "2026 invoice", "Vertex Logistics overdue", "overdue")
        inv_spec = intent.get("invoice_filter")
        if not intent["is_exact_id"] and not intent["is_filename_hint"] and (
            (inv_spec and (inv_spec.get("status_filter") or inv_spec.get("year") or inv_spec.get("group_by") or inv_spec.get("entity_filter")))
            or intent["is_overdue_invoice"]
        ):
            eff_inv_spec = inv_spec or {"status_filter": "overdue", "year": None, "group_by": None, "entity_filter": None}
            inv_res = self._run_structured_invoice_search(
                sf=sf,
                invoice_spec=eff_inv_spec,
                allowed_compartments=allowed_compartments,
                folder_stats=folder_stats,
                aggregated_entities=aggregated_entities,
                effective_offset=effective_offset,
                effective_page_size=effective_page_size,
                top_chunks_limit=top_chunks_limit,
                generation_mode=generation_mode,
                offline_mode=offline_mode,
                started=started,
            )
            if inv_res is not None:
                return inv_res

        engines_used: list[str] = []
        degraded_engines: list[str] = []
        latencies_ms: dict[str, int] = {}
        engine_lists: list[tuple[str, float, list[EngineHit]]] = []

        core_terms: list[str] = list(intent.get("core_terms") or [])
        constraints = parse_query_constraints(query)
        base_kw_query = " ".join(core_terms) if core_terms else intent["normalized_query"]
        expanded_query = base_kw_query
        if constraints.get("is_alternation"):
            # Include concise branch aliases (e.g. "purchase order" -> "purchase agreement pur") so both OR branches surface cleanly
            branch_toks: list[str] = list(core_terms)
            for grp_list in constraints.get("branches") or []:
                for grp in grp_list:
                    for al in sorted(grp["aliases"]):
                        clean_al = al.rstrip("-")
                        if clean_al and not clean_al.startswith(".") and " " not in clean_al and clean_al not in branch_toks:
                            branch_toks.append(clean_al)
            expanded_query = " ".join(branch_toks[:12])
        elif not intent["is_exact_id"] and not intent["is_filename_hint"]:
            exp_tokens = sorted(expand_semantic_tokens(base_kw_query))
            # Append only meaningful single-word semantic siblings (not internal __c_ tags) when single/few terms
            clean_exp = [t for t in exp_tokens if not t.startswith("__") and len(t) >= 3 and t not in core_terms]
            if clean_exp and len(core_terms) <= 2:
                expanded_query = f"{base_kw_query} " + " ".join(clean_exp[:4])

        id_tokens = [m.casefold() for m in ID_TOKEN_RE.findall(query)]
        ext_tokens = [m.casefold() for m in EXT_TOKEN_RE.findall(query)]

        with self.governor.search_priority_scope():
            # Step 3 & 4: Parallel fan-out across SQLite Trigram/FTS5, Tantivy BM25F, and HNSW Vector.
            def _run_trigram() -> tuple[str, float, list[EngineHit]]:
                t0 = time.perf_counter()
                trigram_q = " ".join(id_tokens or ext_tokens or core_terms) or query
                hits = self.catalog.search_filename_trigram(
                    trigram_q,
                    allowed_compartments=allowed_compartments,
                    folder_prefix=folder_prefix,
                    limit=40,
                )
                latencies_ms["sqlite_trigram"] = int((time.perf_counter() - t0) * 1000)
                return ("sqlite_trigram", 1.15 if intent["is_filename_hint"] or intent["is_exact_id"] else 0.90, hits)

            def _run_keyword() -> tuple[str, float, list[EngineHit]]:
                t0 = time.perf_counter()
                if self.tantivy.available:
                    if intent["is_exact_id"] and id_tokens:
                        if intent.get("is_question") and core_terms:
                            kw_query = " ".join(dict.fromkeys(id_tokens + core_terms))
                        else:
                            kw_query = " ".join(id_tokens)
                    elif intent["is_filename_hint"]:
                        kw_query = " ".join(ext_tokens or core_terms)
                    else:
                        kw_query = expanded_query
                    hits = self.tantivy.search(
                        kw_query,
                        allowed_compartments=allowed_compartments,
                        doc_types=sf.doc_types,
                        folder_prefix=folder_prefix,
                        exclude_sensitive=sf.exclude_sensitive,
                        limit=40,
                        skip_fuzzy=bool(id_tokens or ext_tokens),
                        prefer_conjunction=True,
                    )
                    # If Tantivy outbox still has pending writes for newly added files, supplement with SQLite FTS5 if active.
                    if not self.catalog.is_chunks_fts_retired() and self.catalog.count_pending_outbox("tantivy").get("tantivy", 0) > 0:
                        fts_hits = self.catalog.search_chunks_fts(
                            base_kw_query,
                            allowed_compartments=allowed_compartments,
                            folder_prefix=folder_prefix,
                            limit=20,
                        )
                        seen_c = {h.chunk_id for h in hits}
                        for fh in fts_hits:
                            if fh.chunk_id not in seen_c:
                                hits.append(fh)
                    latencies_ms["tantivy"] = int((time.perf_counter() - t0) * 1000)
                    return ("tantivy", 1.25 if intent["is_exact_id"] else 1.10, hits)
                degraded_engines.append("tantivy")
                hits = self.catalog.search_chunks_fts(
                    base_kw_query,
                    allowed_compartments=allowed_compartments,
                    folder_prefix=folder_prefix,
                    limit=40,
                )
                latencies_ms["sqlite_fts5"] = int((time.perf_counter() - t0) * 1000)
                return ("sqlite_fts5", 1.0, hits)

            def _run_semantic() -> tuple[str, float, list[EngineHit]]:
                t0 = time.perf_counter()
                if not self.vector.available:
                    degraded_engines.append("hnswlib")
                    latencies_ms["hnswlib"] = 0
                    return ("hnswlib", 0.0, [])

                q_vec = self.vector.embed_query(query)
                if q_vec is None:
                    degraded_engines.append("semantic_model_not_cached")
                    latencies_ms["hnswlib"] = int((time.perf_counter() - t0) * 1000)
                    return ("hnswlib", 0.0, [])

                raw_candidates = self.vector.search(
                    q_vec,
                    allowed_compartments=allowed_compartments,
                    k_per_compartment=25,
                    limit=45,
                )
                filtered_candidates = [c for c in raw_candidates if c[2] >= 0.15]
                chunk_map = self.catalog.fetch_chunks_by_ids([c[0] for c in filtered_candidates])
                hits: list[EngineHit] = []
                for rank_i, (cid, doc_id, sim, comp) in enumerate(filtered_candidates, start=1):
                    meta = chunk_map.get(cid)
                    if not meta:
                        continue
                    rel = meta["rel_path"]
                    if folder_prefix and not rel.replace("\\", "/").casefold().startswith(folder_prefix.strip("/").casefold()):
                        continue
                    cit = rel + (f" [{meta['page_label']}]" if meta["page_label"] else "")
                    hits.append(
                        EngineHit(
                            chunk_id=cid,
                            doc_id=doc_id,
                            rel_path=rel,
                            filename=meta["filename"],
                            source_engine="hnswlib",
                            score=sim,
                            rank=rank_i,
                            department=meta["department"],
                            compartment=comp,
                            is_sensitive=bool(meta["is_sensitive"]),
                            doc_type=meta["doc_type"],
                            page_label=meta["page_label"],
                            section_label=meta["section_label"],
                            snippet=meta["content"][:400],
                            citation=cit,
                            content=meta["content"],
                            abs_path=meta["abs_path"],
                            ext=meta["ext"],
                            size_bytes=meta["size_bytes"],
                            mtime_ns=meta["mtime_ns"],
                        )
                    )

                if (len(hits) < 5 and folder_prefix) or self.catalog.count_pending_outbox("hnswlib").get("hnswlib", 0) > 0:
                    exact_hits = self.catalog.search_vectors_exact(
                        q_vec,
                        allowed_compartments=allowed_compartments,
                        folder_prefix=folder_prefix,
                        model_id=self.vector.model_id,
                        limit=20,
                    )
                    seen_cids = {h.chunk_id for h in hits}
                    for eh in exact_hits:
                        if eh.chunk_id not in seen_cids:
                            hits.append(eh)

                latencies_ms["hnswlib"] = int((time.perf_counter() - t0) * 1000)
                return ("hnswlib", 1.15 if intent["token_count"] >= 3 and not intent["is_exact_id"] else 0.90, hits)

            with ThreadPoolExecutor(max_workers=3) as pool:
                futs = [pool.submit(_run_trigram), pool.submit(_run_keyword), pool.submit(_run_semantic)]
                for fut in as_completed(futs):
                    name, weight, res_hits = fut.result()
                    if weight > 0:
                        engines_used.append(name)
                        engine_lists.append((name, weight, res_hits))

        # Step 5: Weighted RRF merge + exact ID boost + domain/README weighting.
        rrf_scores: dict[str, float] = {}
        chunk_best_hit: dict[str, EngineHit] = {}
        q_low = intent["normalized_query"].strip().casefold()

        for _engine_name, weight, hit_list in engine_lists:
            for rank_idx, hit in enumerate(hit_list, start=1):
                if not authorize_document_access(
                    sf,
                    doc_id=hit.doc_id,
                    rel_path=hit.rel_path,
                    department=hit.department,
                    is_sensitive=hit.is_sensitive,
                ):
                    continue
                add = weight / (60.0 + rank_idx)
                fname_low = hit.filename.casefold()
                rel_low = hit.rel_path.casefold()
                content_low = hit.content.casefold()
                dept_low = hit.department.casefold()
                if q_low and (q_low in fname_low or q_low == Path(fname_low).stem):
                    add += 0.045
                if id_tokens:
                    if any(_id_matches_target(tok, fname_low) or _id_matches_target(tok, rel_low) for tok in id_tokens):
                        add += 0.075
                    elif any(_id_matches_target(tok, content_low) for tok in id_tokens):
                        add += 0.035
                if core_terms:
                    matched_cnt = sum(
                        1 for ct in core_terms
                        if ct in fname_low or ct in rel_low or ct in content_low
                    )
                    add += 0.014 * (matched_cnt / len(core_terms))
                    if dept_low in core_terms:
                        add += 0.015
                if fname_low == "readme.txt" and "readme" not in core_terms:
                    add -= 0.010

                rrf_scores[hit.chunk_id] = rrf_scores.get(hit.chunk_id, 0.0) + max(0.001, add)
                if hit.chunk_id not in chunk_best_hit:
                    chunk_best_hit[hit.chunk_id] = hit

        # Enrich missing abs_path/ext/size metadata from SQLite for Tantivy hits in one batch.
        enrich_ids = [cid for cid, h in chunk_best_hit.items() if not h.abs_path and ":fname" not in cid]
        if enrich_ids:
            enriched = self.catalog.fetch_chunks_by_ids(enrich_ids)
            for cid, meta in enriched.items():
                h = chunk_best_hit.get(cid)
                if h:
                    h.abs_path = meta["abs_path"]
                    h.ext = meta["ext"]
                    h.size_bytes = meta["size_bytes"]
                    h.mtime_ns = meta["mtime_ns"]

        # Exact ID / specific filename isolation: "if we search for a thing it need to give that specific thing only not more"
        wants_linked_docs = any(
            w in q_low for w in ("linked", "related", "referencing", "mentioning", "other", "similar", "with this")
        )
        if id_tokens or ext_tokens:
            exact_fname_cids: set[str] = set()
            exact_content_cids: set[str] = set()
            for cid, h in chunk_best_hit.items():
                fn_l = h.filename.casefold()
                rel_l = h.rel_path.casefold()
                c_l = h.content.casefold()
                toks_to_check = id_tokens or ext_tokens
                in_fn = all(_id_matches_target(t, fn_l) or _id_matches_target(t, rel_l) for t in toks_to_check)
                in_body = all(_id_matches_target(t, fn_l) or _id_matches_target(t, rel_l) or _id_matches_target(t, c_l) for t in toks_to_check)
                if in_fn:
                    exact_fname_cids.add(cid)
                elif in_body:
                    exact_content_cids.add(cid)

            if exact_fname_cids and not wants_linked_docs:
                allowed_cids = exact_fname_cids
            elif exact_fname_cids or exact_content_cids:
                allowed_cids = exact_fname_cids | exact_content_cids
            else:
                allowed_cids = set(rrf_scores.keys())

            if allowed_cids and allowed_cids != set(rrf_scores.keys()):
                rrf_scores = {cid: sc for cid, sc in rrf_scores.items() if cid in allowed_cids}

        # Rank chunks and group deduplicated files.
        sorted_chunk_ids = sorted(rrf_scores.keys(), key=lambda c: rrf_scores[c], reverse=True)
        top_chunks: list[dict[str, Any]] = []
        file_best: dict[str, tuple[float, EngineHit]] = {}

        for cid in sorted_chunk_ids:
            hit = chunk_best_hit[cid]
            score = rrf_scores[cid]
            prev = file_best.get(hit.rel_path)
            if prev is None or score > prev[0]:
                file_best[hit.rel_path] = (score, hit)

            if len(top_chunks) < max(1, top_chunks_limit) and ":fname" not in cid:
                top_chunks.append(
                    {
                        "chunk_id": hit.chunk_id,
                        "folder_path": str(self.root_path),
                        "relative_path": hit.rel_path,
                        "filename": hit.filename,
                        "citation": hit.citation or hit.rel_path,
                        "text": hit.content,
                        "engine": hit.source_engine,
                        "score": round(score, 5),
                    }
                )

        # Pre-output validation: verify multi-constraint & OR-alternation queries against full document text
        structured_summary = ""
        ranked_files_tuples = sorted(file_best.values(), key=lambda item: item[0], reverse=True)
        branches = constraints.get("branches") or []
        branch_labels = constraints.get("branch_labels") or []
        if not id_tokens and not ext_tokens and ranked_files_tuples and (constraints.get("is_alternation") or (len(branches) == 1 and len(branches[0]) >= 2)):
            doc_texts = self.catalog.fetch_doc_texts_by_doc_ids([hit.doc_id for _, hit in ranked_files_tuples])
            validated_tuples: list[tuple[float, EngineHit]] = []
            matched_branch_idxs: set[int] = set()
            matched_partial_labels: set[str] = set()

            for sc, hit in ranked_files_tuples:
                full_content = doc_texts.get(hit.doc_id) or hit.content
                v = validate_text_against_constraints(hit.filename, hit.rel_path, full_content, constraints)
                if v["valid"]:
                    validated_tuples.append((sc, hit))
                    matched_branch_idxs.update(v["matched_branches"])
                elif v["matched_groups"]:
                    matched_partial_labels.update(v["matched_groups"])

            if constraints.get("is_alternation"):
                ranked_files_tuples = validated_tuples
                missing_branches = [branch_labels[i] for i in range(len(branch_labels)) if i not in matched_branch_idxs]
                if not ranked_files_tuples:
                    structured_summary = (
                        f"No files matching **{ ' or '.join(branch_labels) }** were found in your connected folder."
                    )
                elif missing_branches:
                    matched_names = ", ".join(f"`{h.filename}`" for _, h in ranked_files_tuples[:8])
                    found_branches = [branch_labels[i] for i in sorted(matched_branch_idxs) if i < len(branch_labels)]
                    structured_summary = (
                        f"Found **{len(ranked_files_tuples)}** verified file{'s' if len(ranked_files_tuples) != 1 else ''} for "
                        f"**{', '.join(found_branches)}** ({matched_names}).\n\n"
                        f"• No matching **{', '.join(missing_branches)}** files were found in this folder."
                    )
            else:
                if validated_tuples:
                    ranked_files_tuples = validated_tuples
                else:
                    req_terms_disp = ", ".join(f"`{g['label']}`" for g in branches[0])
                    partial_hint = (
                        f" *(Individual matches existed for {', '.join(sorted(matched_partial_labels))}, but no document satisfied every criterion together.)*"
                        if matched_partial_labels
                        else ""
                    )
                    ranked_files_tuples = []
                    structured_summary = (
                        f"No documents matching **all** criteria ({req_terms_disp}) were found in your connected folder.{partial_hint}"
                    )

        all_ranked_files: list[dict[str, Any]] = []
        kept_rels = {hit.rel_path for _, hit in ranked_files_tuples}
        top_chunks = [c for c in top_chunks if c["relative_path"] in kept_rels]
        for sc, hit in ranked_files_tuples:
            clean_snip = re.sub(r"^\[(?:CSV|TSV|PDF|DOCX|XLSX|PPTX|Body|Metadata|Rows[^\]]*)\]\s*", "", str(hit.snippet or ""), flags=re.IGNORECASE)
            clean_snip = re.sub(r"\b(?:Attribute|Field)\s+Value\b", " ", clean_snip, flags=re.IGNORECASE)
            clean_snip = re.sub(r"(?:^|\s)I(\d[\d,.]*\s*(?:lakhs?|crores?))\b", r" ₹\1", clean_snip, flags=re.IGNORECASE)
            all_ranked_files.append(
                {
                    "name": hit.filename,
                    "path": hit.rel_path,
                    "full_path": hit.abs_path or str((self.root_path / hit.rel_path).resolve()),
                    "display_path": f"{self.root_path.name}/{hit.rel_path}",
                    "type": hit.ext or Path(hit.filename).suffix.casefold(),
                    "open_url": f"/api/sources/{hit.doc_id}",
                    "source": hit.source_engine,
                    "department": hit.department,
                    "match_type": "exact_id" if intent["is_exact_id"] else hit.source_engine,
                    "content_snippet": clean_snip.strip(),
                    "score": round(sc, 5),
                }
            )

        # Structured summaries & entity aggregations respecting RBAC compartments.
        if intent["is_exact_id"] and any("inv" in t for t in id_tokens):
            invoices = self.catalog.query_structured_invoices(
                allowed_compartments=allowed_compartments,
                overdue_only=False,
                limit=50,
            )
            authorized_invs = [
                inv
                for inv in invoices
                if authorize_document_access(
                    sf,
                    doc_id=str(inv.get("doc_id", "")),
                    rel_path=str(inv.get("rel_path", "")),
                    department=str(inv.get("department", "Finance")),
                    is_sensitive=bool(inv.get("is_sensitive", True)),
                )
                and (
                    not id_tokens
                    or any(
                        _id_matches_target(tok, str(inv.get("invoice_number") or inv.get("id") or ""))
                        or _id_matches_target(tok, str(inv.get("filename") or ""))
                        for tok in id_tokens
                    )
                )
            ]
            structured_summary = _format_overdue_summary(authorized_invs)

        total_matches = len(all_ranked_files)
        paged_files = all_ranked_files[effective_offset : effective_offset + effective_page_size]
        has_more = (effective_offset + effective_page_size) < total_matches

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return UnifiedSearchResult(
            folder_path=str(self.root_path),
            files=paged_files,
            chunks=top_chunks,
            total_matches=total_matches,
            offset=effective_offset,
            page_size=effective_page_size,
            has_more=has_more,
            all_ranked_files=all_ranked_files,
            structured_summary=structured_summary,
            aggregated_entities=aggregated_entities,
            folder_stats=folder_stats,
            zero_match=(total_matches == 0 and not structured_summary),
            elapsed_ms=elapsed_ms,
            engines_used=sorted(engines_used),
            degraded_engines=sorted(set(degraded_engines)),
            engine_latencies_ms=latencies_ms,
            compartments_searched=list(allowed_compartments),
            offline_mode=offline_mode,
            generation_mode=generation_mode,
            semantic_model_ready=self.vector.is_semantic_model_ready(),
        )

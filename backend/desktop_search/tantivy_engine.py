from __future__ import annotations

import logging
from pathlib import Path
import threading
from typing import Any

from .models import EngineHit

logger = logging.getLogger(__name__)

try:
    import tantivy
except Exception as exc:  # pragma: no cover - optional degraded fallback
    tantivy = None  # type: ignore[assignment]
    _TANTIVY_IMPORT_ERROR = str(exc)
else:
    _TANTIVY_IMPORT_ERROR = ""


def _first_val(doc_dict: dict[str, Any], key: str, default: Any = "") -> Any:
    val = doc_dict.get(key)
    if isinstance(val, list):
        return val[0] if val else default
    return default if val is None else val


class TantivyBM25Engine:
    """Persistent Lucene-class BM25F, phrase, facet, and fuzzy keyword engine via Tantivy."""

    def __init__(self, index_dir: Path, *, heap_bytes: int = 32 * 1024 * 1024) -> None:
        self.index_dir = Path(index_dir)
        self.heap_bytes = max(15_000_000, int(heap_bytes))
        self._lock = threading.RLock()
        self.available = tantivy is not None
        self.init_error = _TANTIVY_IMPORT_ERROR
        self._schema = None
        self._index = None
        self._writer = None
        if self.available:
            self._open_or_create()

    def _build_schema(self):
        b = tantivy.SchemaBuilder()
        b.add_text_field("chunk_id", stored=True, tokenizer_name="raw", index_option="basic")
        b.add_text_field("doc_id", stored=True, tokenizer_name="raw", index_option="basic")
        b.add_text_field("filename", stored=True, tokenizer_name="default", index_option="position")
        b.add_text_field("rel_path", stored=True, tokenizer_name="default", index_option="position")
        b.add_text_field("compartment", stored=True, fast=True, tokenizer_name="raw", index_option="basic")
        b.add_text_field("department", stored=True, fast=True, tokenizer_name="raw", index_option="basic")
        b.add_text_field("doc_type", stored=True, fast=True, tokenizer_name="raw", index_option="basic")
        b.add_boolean_field("is_sensitive", stored=True, indexed=True, fast=True)
        b.add_text_field("page_label", stored=True, tokenizer_name="raw", index_option="basic")
        b.add_text_field("content", stored=True, tokenizer_name="en_stem", index_option="position")
        return b.build()

    def _open_or_create(self) -> None:
        try:
            self.index_dir.mkdir(parents=True, exist_ok=True)
            self._schema = self._build_schema()
            self._index = tantivy.Index(self._schema, path=str(self.index_dir))
            try:
                self._writer = self._index.writer(self.heap_bytes, 1)
            except Exception as writer_exc:
                # Recover cleanly if a previous sidecar process crashed leaving a stale writer lock
                if "lock" in str(writer_exc).lower():
                    for lock_name in (".tantivy-writer.lock", ".tantivy-meta.lock"):
                        lock_path = self.index_dir / lock_name
                        if lock_path.exists():
                            try:
                                lock_path.unlink()
                            except OSError:
                                pass
                    self._index = tantivy.Index(self._schema, path=str(self.index_dir))
                    self._writer = self._index.writer(self.heap_bytes, 1)
                else:
                    raise
        except Exception as exc:
            logger.warning("Tantivy initialization failed (%s); falling back to SQLite.", exc)
            self.available = False
            self.init_error = str(exc)

    def close(self) -> None:
        with self._lock:
            self._writer = None
            self._index = None

    def upsert_document(
        self,
        *,
        doc_id: str,
        filename: str,
        rel_path: str,
        compartment: str,
        department: str,
        doc_type: str,
        is_sensitive: bool,
        chunks: list[dict[str, Any]],
        commit: bool = False,
    ) -> None:
        """Idempotently replace all indexed chunks for doc_id inside Tantivy."""
        if not self.available or self._writer is None:
            raise RuntimeError("Tantivy engine is unavailable")

        with self._lock:
            self._writer.delete_documents_by_term("doc_id", doc_id)
            for ch in chunks:
                doc = tantivy.Document()
                doc.add_text("chunk_id", str(ch["chunk_id"]))
                doc.add_text("doc_id", str(doc_id))
                doc.add_text("filename", str(filename))
                doc.add_text("rel_path", str(rel_path))
                doc.add_text("compartment", str(compartment))
                doc.add_text("department", str(department))
                doc.add_text("doc_type", str(doc_type))
                doc.add_boolean("is_sensitive", bool(is_sensitive))
                doc.add_text("page_label", str(ch.get("page_label") or ""))
                doc.add_text("content", str(ch.get("content") or ""))
                self._writer.add_document(doc)
            if commit:
                self._commit_locked()

    def delete_document(self, doc_id: str, *, commit: bool = False) -> None:
        if not self.available or self._writer is None:
            return
        with self._lock:
            self._writer.delete_documents_by_term("doc_id", doc_id)
            if commit:
                self._commit_locked()

    def commit(self) -> None:
        if not self.available or self._writer is None:
            return
        with self._lock:
            self._commit_locked()

    def _commit_locked(self) -> None:
        assert self._writer is not None and self._index is not None
        self._writer.commit()
        self._index.reload()

    def num_docs(self) -> int:
        if not self.available or self._index is None:
            return 0
        try:
            return int(self._index.searcher().num_docs)
        except Exception:
            return 0

    def search(
        self,
        query: str,
        *,
        allowed_compartments: tuple[str, ...],
        doc_types: tuple[str, ...] | None = None,
        folder_prefix: str | None = None,
        exclude_sensitive: bool = False,
        limit: int = 30,
        skip_fuzzy: bool = False,
        prefer_conjunction: bool = True,
    ) -> list[EngineHit]:
        """Execute RBAC-filtered BM25F with conjunctive-first + optional fuzzy Tantivy query."""
        if not self.available or self._index is None or self._schema is None:
            return []
        cleaned = (query or "").strip()
        if not cleaned or not allowed_compartments:
            return []

        searcher = self._index.searcher()
        if searcher.num_docs == 0:
            return []

        comp_filter = tantivy.Query.term_set_query(
            self._schema, "compartment", list(allowed_compartments)
        )
        filters: list[tuple[Any, Any]] = [(tantivy.Occur.Must, comp_filter)]
        if doc_types:
            dt_filter = tantivy.Query.term_set_query(self._schema, "doc_type", list(doc_types))
            filters.append((tantivy.Occur.Must, dt_filter))
        if exclude_sensitive:
            sens_filter = tantivy.Query.term_query(self._schema, "is_sensitive", True)
            filters.append((tantivy.Occur.MustNot, sens_filter))

        boosts = {"filename": 4.0, "rel_path": 2.0, "content": 1.0}
        fields = ["filename", "rel_path", "content"]
        fetch_limit = limit * 3 if folder_prefix else limit

        scored_addrs: dict[str, tuple[float, dict[str, Any]]] = {}

        def _collect(search_result, scale: float) -> None:
            for score, addr in search_result.hits:
                d = searcher.doc(addr).to_dict()
                cid = str(_first_val(d, "chunk_id", ""))
                rel = str(_first_val(d, "rel_path", ""))
                if not cid:
                    continue
                if folder_prefix and not rel.replace("\\", "/").casefold().startswith(
                    folder_prefix.strip("/").casefold()
                ):
                    continue
                eff_score = float(score) * scale
                prev = scored_addrs.get(cid)
                if prev is None or eff_score > prev[0]:
                    scored_addrs[cid] = (eff_score, d)

        # 1. Precision-first conjunctive search (requires ALL query tokens across document fields)
        token_count = len([t for t in cleaned.split() if len(t) >= 2])
        if prefer_conjunction and token_count >= 2:
            conj_query, _ = self._index.parse_query_lenient(
                cleaned,
                fields,
                field_boosts=boosts,
                conjunction_by_default=True,
            )
            conj_bool = tantivy.Query.boolean_query([(tantivy.Occur.Must, conj_query), *filters])
            conj_res = searcher.search(conj_bool, limit=fetch_limit)
            _collect(conj_res, 1.35)

        # 2. Disjunctive pass for broader recall when conjunctive didn't fill requested limit (skip on strict IDs once hit)
        if not (skip_fuzzy and scored_addrs) and len(scored_addrs) < limit:
            text_query, _ = self._index.parse_query_lenient(
                cleaned,
                fields,
                field_boosts=boosts,
                conjunction_by_default=False,
            )
            bool_query = tantivy.Query.boolean_query([(tantivy.Occur.Must, text_query), *filters])
            res = searcher.search(bool_query, limit=fetch_limit)
            _collect(res, 1.0 if token_count < 2 else 0.68)

        # 3. Fallback fuzzy matching when exact/stemmed hits are sparse (disabled for exact ID queries).
        if not skip_fuzzy and len(scored_addrs) < limit and any(len(tok) >= 4 for tok in cleaned.split()):
            fuzzy_q, _ = self._index.parse_query_lenient(
                cleaned,
                fields,
                field_boosts=boosts,
                fuzzy_fields={
                    "filename": (True, 1, True),
                    "rel_path": (False, 1, True),
                    "content": (False, 1, True),
                },
                conjunction_by_default=prefer_conjunction and token_count >= 2,
            )
            fuzzy_bool = tantivy.Query.boolean_query([(tantivy.Occur.Must, fuzzy_q), *filters])
            fuzzy_res = searcher.search(fuzzy_bool, limit=fetch_limit)
            _collect(fuzzy_res, 0.72)

        ordered = sorted(scored_addrs.items(), key=lambda kv: kv[1][0], reverse=True)[:limit]
        hits: list[EngineHit] = []
        for rank, (cid, (score, d)) in enumerate(ordered, start=1):
            rel = str(_first_val(d, "rel_path", ""))
            page_lbl = str(_first_val(d, "page_label", ""))
            cit = rel + (f" [{page_lbl}]" if page_lbl else "")
            text = str(_first_val(d, "content", ""))
            hits.append(
                EngineHit(
                    chunk_id=cid,
                    doc_id=str(_first_val(d, "doc_id", "")),
                    rel_path=rel,
                    filename=str(_first_val(d, "filename", "")),
                    source_engine="tantivy",
                    score=score,
                    rank=rank,
                    department=str(_first_val(d, "department", "General")),
                    compartment=str(_first_val(d, "compartment", "comp_general")),
                    is_sensitive=bool(_first_val(d, "is_sensitive", False)),
                    doc_type=str(_first_val(d, "doc_type", "document")),
                    page_label=page_lbl,
                    snippet=text[:400],
                    citation=cit,
                    content=text,
                )
            )
        return hits


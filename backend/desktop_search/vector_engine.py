from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import threading
from typing import Any, Callable

import numpy as np

from .models import (
    EMBEDDING_DIM,
    EMBEDDING_MODEL_ID,
    EngineHit,
    ONNX_WEIGHT_DTYPE,
    ResourceProfile,
    VECTOR_STORAGE_DTYPE,
)
from .security import ALL_COMPARTMENTS

logger = logging.getLogger(__name__)

try:
    import hnswlib
except Exception as exc:  # pragma: no cover
    hnswlib = None  # type: ignore[assignment]
    _HNSW_ERR = str(exc)
else:
    _HNSW_ERR = ""

try:
    from fastembed import TextEmbedding
except Exception as exc:  # pragma: no cover
    TextEmbedding = None  # type: ignore[assignment]
    _FASTEMBED_ERR = str(exc)
else:
    _FASTEMBED_ERR = ""


class _CompartmentGraph:
    """Single RBAC compartment HNSW vector graph with ID mapping and compaction."""

    def __init__(
        self,
        compartment: str,
        base_dir: Path,
        *,
        dim: int,
        profile: ResourceProfile,
    ) -> None:
        self.compartment = compartment
        self.bin_path = base_dir / f"{compartment}.hnsw.bin"
        self.map_path = base_dir / f"{compartment}.map.json"
        self.dim = dim
        self.profile = profile
        self.next_label = 0
        self.deleted_count = 0
        self.label_to_chunk: dict[int, tuple[str, str]] = {}  # label -> (chunk_id, doc_id)
        self.doc_to_labels: dict[str, set[int]] = {}
        self.index: Any = None
        self.dirty = False
        self._load_existing()

    def _init_empty(self, max_elements: int = 256) -> None:
        idx = hnswlib.Index(space="cosine", dim=self.dim)
        idx.init_index(
            max_elements=max(256, max_elements),
            ef_construction=self.profile.hnsw_ef_construction,
            M=self.profile.hnsw_m,
        )
        idx.set_ef(self.profile.hnsw_ef_search)
        idx.set_num_threads(1)
        self.index = idx
        self.next_label = 0
        self.deleted_count = 0
        self.label_to_chunk.clear()
        self.doc_to_labels.clear()

    def _load_existing(self) -> None:
        if hnswlib is None:
            return
        if not self.bin_path.exists() or not self.map_path.exists():
            return
        try:
            meta = json.loads(self.map_path.read_text(encoding="utf-8"))
            max_el = max(256, int(meta.get("max_elements", 256)))
            idx = hnswlib.Index(space="cosine", dim=self.dim)
            idx.load_index(str(self.bin_path), max_elements=max_el)
            idx.set_ef(self.profile.hnsw_ef_search)
            idx.set_num_threads(1)
            self.index = idx
            self.next_label = int(meta.get("next_label", 0))
            self.deleted_count = int(meta.get("deleted_count", 0))
            self.label_to_chunk = {
                int(k): (str(v[0]), str(v[1]))
                for k, v in meta.get("label_to_chunk", {}).items()
            }
            self.doc_to_labels = {}
            for lbl, (_, doc_id) in self.label_to_chunk.items():
                self.doc_to_labels.setdefault(doc_id, set()).add(lbl)
        except Exception as exc:
            logger.warning("Failed loading HNSW compartment %s (%s); starting fresh.", self.compartment, exc)
            self.index = None

    @property
    def live_count(self) -> int:
        return len(self.label_to_chunk)

    def _mark_doc_deleted(self, doc_id: str) -> None:
        labels = self.doc_to_labels.pop(doc_id, None)
        if not labels or self.index is None:
            return
        for lbl in labels:
            self.label_to_chunk.pop(lbl, None)
            try:
                self.index.mark_deleted(lbl)
                self.deleted_count += 1
            except Exception:
                pass
        self.dirty = True

    def upsert(self, doc_id: str, chunk_vectors: list[tuple[str, np.ndarray]]) -> None:
        if hnswlib is None:
            return
        if self.index is None and chunk_vectors:
            self._init_empty(max(256, len(chunk_vectors) * 2))

        self._mark_doc_deleted(doc_id)
        if not chunk_vectors or self.index is None:
            return

        total_elements = self.index.get_current_count() + len(chunk_vectors)
        cur_max = self.index.get_max_elements()
        if total_elements > cur_max:
            new_max = max(cur_max * 2, total_elements + 256)
            self.index.resize_index(new_max)

        vecs = []
        lbls = []
        new_doc_labels: set[int] = set()
        for chunk_id, vec in chunk_vectors:
            arr = np.asarray(vec, dtype=np.float32).reshape(-1)
            if arr.shape[0] != self.dim:
                continue
            norm = float(np.linalg.norm(arr))
            if norm > 0:
                arr = arr / norm
            lbl = self.next_label
            self.next_label += 1
            vecs.append(arr)
            lbls.append(lbl)
            self.label_to_chunk[lbl] = (chunk_id, doc_id)
            new_doc_labels.add(lbl)

        if vecs:
            self.index.add_items(np.vstack(vecs), lbls)
            self.doc_to_labels[doc_id] = new_doc_labels
            self.dirty = True
            self._maybe_compact()

    def delete(self, doc_id: str) -> None:
        self._mark_doc_deleted(doc_id)
        self._maybe_compact()

    def _maybe_compact(self) -> None:
        if self.index is None:
            return
        total_slots = max(1, self.live_count + self.deleted_count)
        if total_slots >= 100 and (self.deleted_count / total_slots) > 0.20:
            self.compact()

    def compact(self) -> None:
        """Rebuild HNSW graph without tombstones when deletions exceed 20%."""
        if self.index is None:
            return
        live_items = list(self.label_to_chunk.items())
        if not live_items:
            self._init_empty(256)
            self.dirty = True
            return

        old_labels = [lbl for lbl, _ in live_items]
        vecs = np.asarray(self.index.get_items(old_labels), dtype=np.float32)
        new_idx = hnswlib.Index(space="cosine", dim=self.dim)
        new_cap = max(256, len(live_items) * 2)
        new_idx.init_index(
            max_elements=new_cap,
            ef_construction=self.profile.hnsw_ef_construction,
            M=self.profile.hnsw_m,
        )
        new_idx.set_ef(self.profile.hnsw_ef_search)
        new_idx.set_num_threads(1)

        new_l2c: dict[int, tuple[str, str]] = {}
        new_d2l: dict[str, set[int]] = {}
        new_labels = list(range(len(live_items)))
        for new_lbl, (_, (chunk_id, doc_id)) in zip(new_labels, live_items):
            new_l2c[new_lbl] = (chunk_id, doc_id)
            new_d2l.setdefault(doc_id, set()).add(new_lbl)

        new_idx.add_items(vecs, new_labels)
        self.index = new_idx
        self.next_label = len(live_items)
        self.deleted_count = 0
        self.label_to_chunk = new_l2c
        self.doc_to_labels = new_d2l
        self.dirty = True

    def persist(self) -> None:
        if not self.dirty or self.index is None:
            return
        self.bin_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_bin = self.bin_path.with_suffix(".hnsw.tmp")
        tmp_map = self.map_path.with_suffix(".map.tmp")
        self.index.save_index(str(tmp_bin))
        payload = {
            "max_elements": int(self.index.get_max_elements()),
            "next_label": self.next_label,
            "deleted_count": self.deleted_count,
            "label_to_chunk": {str(k): [v[0], v[1]] for k, v in self.label_to_chunk.items()},
        }
        tmp_map.write_text(json.dumps(payload), encoding="utf-8")
        os.replace(tmp_bin, self.bin_path)
        os.replace(tmp_map, self.map_path)
        self.dirty = False

    def knn(self, query_vec: np.ndarray, k: int) -> list[tuple[str, str, float]]:
        if self.index is None or self.live_count == 0:
            return []
        req_k = min(self.live_count, max(1, k))
        q = np.asarray(query_vec, dtype=np.float32).reshape(1, self.dim)
        labels, distances = self.index.knn_query(q, k=req_k)
        out: list[tuple[str, str, float]] = []
        for lbl, dist in zip(labels[0], distances[0]):
            entry = self.label_to_chunk.get(int(lbl))
            if entry is None:
                continue
            chunk_id, doc_id = entry
            similarity = max(0.0, 1.0 - float(dist))
            out.append((chunk_id, doc_id, similarity))
        return out


class PartitionedVectorEngine:
    """RBAC-partitioned HNSW graphs + INT8 ONNX FastEmbed local embedding engine."""

    def __init__(
        self,
        vector_dir: Path,
        *,
        model_cache_dir: Path,
        profile: ResourceProfile,
        model_id: str = EMBEDDING_MODEL_ID,
        dim: int = EMBEDDING_DIM,
        embed_fn: Callable[[list[str]], np.ndarray] | None = None,
        allow_model_download: bool = True,
    ) -> None:
        self.vector_dir = Path(vector_dir)
        self.vector_dir.mkdir(parents=True, exist_ok=True)
        self.model_cache_dir = Path(model_cache_dir)
        self.model_cache_dir.mkdir(parents=True, exist_ok=True)
        self.profile = profile
        self.model_id = model_id
        self.dim = dim
        self.onnx_weight_dtype = ONNX_WEIGHT_DTYPE
        self.storage_dtype = VECTOR_STORAGE_DTYPE
        self._custom_embed_fn = embed_fn
        self._allow_model_download = allow_model_download
        self._lock = threading.RLock()
        self._model: Any = None
        self._model_failed = False

        self.available = hnswlib is not None and (embed_fn is not None or TextEmbedding is not None)
        self._compartments: dict[str, _CompartmentGraph] = {}
        if hnswlib is not None:
            for comp in ALL_COMPARTMENTS:
                self._compartments[comp] = _CompartmentGraph(
                    comp, self.vector_dir, dim=self.dim, profile=self.profile
                )

    def _is_model_cached(self) -> bool:
        if self._custom_embed_fn is not None or self._model is not None:
            return True
        try:
            for p in self.model_cache_dir.rglob("*.onnx"):
                if p.stat().st_size > 1_000_000:
                    return True
        except OSError:
            pass
        return False

    def is_semantic_model_ready(self) -> bool:
        return self._custom_embed_fn is not None or self._model is not None or self._is_model_cached()

    def ensure_model_ready(self, *, allow_download: bool | None = None) -> bool:
        """Load FastEmbed INT8 ONNX model lazily, respecting offline local_files_only mode."""
        if self._custom_embed_fn is not None:
            return True
        if self._model is not None:
            return True
        if self._model_failed or TextEmbedding is None:
            return False

        can_dl = self._allow_model_download if allow_download is None else allow_download
        cached = self._is_model_cached()
        if not cached and not can_dl:
            return False

        with self._lock:
            if self._model is not None:
                return True
            try:
                self._model = TextEmbedding(
                    model_name=self.model_id,
                    cache_dir=str(self.model_cache_dir),
                    threads=self.profile.onnx_threads,
                    local_files_only=not can_dl,
                )
                return True
            except Exception as exc:
                logger.warning("FastEmbed model load skipped/unavailable (%s)", exc)
                if not can_dl:
                    # Only transient offline absence; allow future online attempts.
                    return False
                self._model_failed = True
                return False

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        """Compute L2-normalized float32 (N, dim) vectors using INT8 ONNX weights."""
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)

        if self._custom_embed_fn is not None:
            vecs = np.asarray(self._custom_embed_fn(texts), dtype=np.float32)
        else:
            if not self.ensure_model_ready():
                raise RuntimeError("Semantic ONNX model not available")
            raw_list = list(self._model.embed(texts, batch_size=self.profile.embed_batch_size))
            vecs = np.asarray(raw_list, dtype=np.float32)

        if vecs.ndim == 1:
            vecs = vecs.reshape(1, -1)
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms = np.where(norms > 0, norms, 1.0)
        return (vecs / norms).astype(np.float32)

    def embed_query(self, query: str) -> np.ndarray | None:
        if not query.strip():
            return None
        if not self.ensure_model_ready(allow_download=False) and not self._allow_model_download:
            return None
        try:
            if not self.ensure_model_ready():
                return None
            arr = self.embed_texts([query])
            return arr[0] if arr.shape[0] else None
        except Exception:
            return None

    def upsert_document_vectors(
        self,
        *,
        doc_id: str,
        compartment: str,
        chunk_vectors: list[tuple[str, np.ndarray]],
        save: bool = True,
    ) -> None:
        with self._lock:
            target = compartment if compartment in self._compartments else "comp_general"
            for comp_name, graph in self._compartments.items():
                if comp_name != target:
                    graph.delete(doc_id)
            self._compartments[target].upsert(doc_id, chunk_vectors)
            if save:
                self.persist_all()

    def delete_document(self, doc_id: str, compartment: str | None = None) -> None:
        with self._lock:
            if compartment and compartment in self._compartments:
                self._compartments[compartment].delete(doc_id)
            else:
                for graph in self._compartments.values():
                    graph.delete(doc_id)

    def persist_all(self) -> None:
        with self._lock:
            for graph in self._compartments.values():
                graph.persist()

    def total_live_vectors(self) -> int:
        return sum(g.live_count for g in self._compartments.values())

    def search(
        self,
        query_vector: np.ndarray,
        *,
        allowed_compartments: tuple[str, ...],
        k_per_compartment: int = 20,
        limit: int = 25,
    ) -> list[tuple[str, str, float, str]]:
        """Query ONLY authorized HNSW partitions and return [(chunk_id, doc_id, sim, compartment)]."""
        if not self.available or not allowed_compartments:
            return []
        candidates: list[tuple[str, str, float, str]] = []
        with self._lock:
            for comp in allowed_compartments:
                graph = self._compartments.get(comp)
                if graph is None or graph.live_count == 0:
                    continue
                for chunk_id, doc_id, sim in graph.knn(query_vector, k_per_compartment):
                    candidates.append((chunk_id, doc_id, sim, comp))

        candidates.sort(key=lambda item: item[2], reverse=True)
        return candidates[:limit]


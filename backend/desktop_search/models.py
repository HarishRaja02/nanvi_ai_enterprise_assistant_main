from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


EMBEDDING_MODEL_ID = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384
ONNX_WEIGHT_DTYPE = "int8"
VECTOR_STORAGE_DTYPE = "float32"
CLOUD_VECTOR_STORAGE_DTYPE = "halfvec"


@dataclass(frozen=True)
class ResourceProfile:
    """Hardware-bounded runtime configuration for a Windows desktop machine."""

    tier: str
    total_ram_gb: float
    parse_workers: int
    embed_workers: int
    onnx_threads: int
    embed_batch_size: int
    ram_budget_mb: int
    disk_free_floor_mb: int
    max_pending_jobs: int
    tantivy_heap_bytes: int
    hnsw_m: int
    hnsw_ef_construction: int
    hnsw_ef_search: int
    max_single_file_mb: int = 256
    chunk_target_chars: int = 900
    chunk_overlap_chars: int = 120

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CanonicalFileRecord:
    """Canonical 3-layer file identity and indexing state stored in SQLite."""

    doc_id: str
    tenant_id: str
    user_id: str
    machine_id: str
    workspace_id: str
    abs_path: str
    rel_path: str
    filename: str
    ext: str
    size_bytes: int
    mtime_ns: int
    content_sha256: str
    volume_serial: str = "0"
    file_index: str = "0"
    department: str = "General"
    compartment: str = "comp_general"
    doc_type: str = "document"
    is_sensitive: bool = False
    is_cloud_stub: bool = False
    extraction_status: str = "pending"
    current_version: int = 1
    is_deleted: bool = False
    last_error: str | None = None
    indexed_at: float = 0.0
    updated_at: float = 0.0


@dataclass
class CanonicalChunkRecord:
    """Chunk payload anchored to a canonical file version."""

    chunk_id: str
    doc_id: str
    file_version: int
    chunk_index: int
    page_label: str
    section_label: str
    content: str
    content_sha256: str
    char_count: int
    embed_eligible: bool = True
    is_deleted: bool = False


@dataclass(frozen=True)
class SearchFilter:
    """Caller identity and metadata filters evaluated prior to ANN and FTS merges."""

    tenant_id: str = "default-tenant"
    user_id: str = "desktop-user"
    role: str = "Employee"
    roles: tuple[str, ...] = ("Employee",)
    department: str | None = None
    allowed_compartments: tuple[str, ...] | None = None
    departments: tuple[str, ...] | None = None
    doc_types: tuple[str, ...] | None = None
    folder_prefix: str | None = None
    extension: str | None = None
    exclude_sensitive: bool = False


@dataclass
class EngineHit:
    """Unified ranked candidate returned by SQLite, Tantivy, or hnswlib."""

    chunk_id: str
    doc_id: str
    rel_path: str
    filename: str
    source_engine: str
    score: float
    rank: int
    department: str = "General"
    compartment: str = "comp_general"
    is_sensitive: bool = False
    doc_type: str = "document"
    page_label: str = ""
    section_label: str = ""
    snippet: str = ""
    citation: str = ""
    content: str = ""
    abs_path: str = ""
    ext: str = ""
    size_bytes: int = 0
    mtime_ns: int = 0


@dataclass
class IndexingHealthStatus:
    """Observability snapshot surfaced to Electron UI and diagnostics."""

    workspace_id: str
    total_files: int = 0
    indexed_files: int = 0
    cloud_stub_files: int = 0
    failed_files: int = 0
    total_chunks: int = 0
    embedded_chunks: int = 0
    outbox_pending: dict[str, int] = field(default_factory=dict)
    outbox_dead_letter: dict[str, int] = field(default_factory=dict)
    fts5_chunks_retired: bool = False
    tantivy_available: bool = False
    hnsw_available: bool = False
    semantic_model_ready: bool = False
    onnx_weight_dtype: str = ONNX_WEIGHT_DTYPE
    vector_storage_dtype: str = VECTOR_STORAGE_DTYPE
    watcher_active: bool = False
    rss_mb: float = 0.0
    disk_free_mb: float = 0.0
    paused_reason: str | None = None
    profile_tier: str = "balanced"
    is_scanning: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class UnifiedSearchResult:
    """Search output matching Nanvi desktop searchDesktopFolder JSON contract."""

    folder_path: str
    files: list[dict[str, Any]]
    chunks: list[dict[str, Any]]
    total_matches: int
    offset: int
    page_size: int
    has_more: bool
    all_ranked_files: list[dict[str, Any]]
    structured_summary: str
    aggregated_entities: dict[str, Any]
    folder_stats: dict[str, Any]
    zero_match: bool
    elapsed_ms: int
    engines_used: list[str] = field(default_factory=list)
    degraded_engines: list[str] = field(default_factory=list)
    engine_latencies_ms: dict[str, int] = field(default_factory=dict)
    compartments_searched: list[str] = field(default_factory=list)
    offline_mode: bool = True
    generation_mode: str = "retrieval_only"
    semantic_model_ready: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

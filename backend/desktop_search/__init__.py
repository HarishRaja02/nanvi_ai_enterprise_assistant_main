from .catalog import CatalogStore
from .governor import ResourceGovernor, apply_background_priority, detect_hardware_profile
from .models import (
    CLOUD_VECTOR_STORAGE_DTYPE,
    CanonicalChunkRecord,
    CanonicalFileRecord,
    EMBEDDING_DIM,
    EMBEDDING_MODEL_ID,
    EngineHit,
    IndexingHealthStatus,
    ONNX_WEIGHT_DTYPE,
    ResourceProfile,
    SearchFilter,
    UnifiedSearchResult,
    VECTOR_STORAGE_DTYPE,
)
from .orchestrator import DesktopSearchWorkspace
from .outbox import OutboxDispatcher
from .security import (
    ALL_COMPARTMENTS,
    LocalPayloadCipher,
    authorize_document_access,
    classify_file_compartment,
    compute_workspace_id,
    generate_sidecar_token,
    harden_directory_acl,
    is_blocked_system_path,
    is_cloud_placeholder,
    resolve_allowed_compartments,
    resolve_local_data_dir,
    resolve_model_cache_dir,
    resolve_workspace_data_dir,
    validate_scan_root,
    verify_sidecar_token,
)
from .sidecar import WorkspaceManager, create_sidecar_app
from .tantivy_engine import TantivyBM25Engine
from .vector_engine import PartitionedVectorEngine
from .watcher import WorkspaceFileWatcher

__all__ = [
    "ALL_COMPARTMENTS",
    "CLOUD_VECTOR_STORAGE_DTYPE",
    "CanonicalChunkRecord",
    "CanonicalFileRecord",
    "CatalogStore",
    "DesktopSearchWorkspace",
    "EMBEDDING_DIM",
    "EMBEDDING_MODEL_ID",
    "EngineHit",
    "IndexingHealthStatus",
    "LocalPayloadCipher",
    "ONNX_WEIGHT_DTYPE",
    "OutboxDispatcher",
    "PartitionedVectorEngine",
    "ResourceGovernor",
    "ResourceProfile",
    "SearchFilter",
    "TantivyBM25Engine",
    "UnifiedSearchResult",
    "VECTOR_STORAGE_DTYPE",
    "WorkspaceFileWatcher",
    "WorkspaceManager",
    "apply_background_priority",
    "authorize_document_access",
    "classify_file_compartment",
    "compute_workspace_id",
    "create_sidecar_app",
    "detect_hardware_profile",
    "generate_sidecar_token",
    "harden_directory_acl",
    "is_blocked_system_path",
    "is_cloud_placeholder",
    "resolve_allowed_compartments",
    "resolve_local_data_dir",
    "resolve_model_cache_dir",
    "resolve_workspace_data_dir",
    "validate_scan_root",
    "verify_sidecar_token",
]


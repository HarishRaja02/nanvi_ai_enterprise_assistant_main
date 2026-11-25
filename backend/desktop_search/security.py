from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
from functools import lru_cache
import getpass
import hashlib
import hmac
import logging
import os
from pathlib import Path
import secrets
import socket
import subprocess
from typing import Iterable

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from backend.integrations.files.company_data.classification import _classify_department
from backend.security.authorization import (
    AuthorizationService,
    Permission,
    Resource,
    Role,
    UserAttributes,
)
from backend.security.authorization.rbac import LEGACY_ROLE_ALIASES

from .models import SearchFilter

logger = logging.getLogger(__name__)

# Windows file attribute flags indicating unhydrated OneDrive / Cloud Files placeholders.
FILE_ATTRIBUTE_OFFLINE = 0x00001000
FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000
FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000
CLOUD_STUB_MASK = (
    FILE_ATTRIBUTE_OFFLINE
    | FILE_ATTRIBUTE_RECALL_ON_OPEN
    | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
)

SENSITIVE_HR_TERMS = (
    "salary",
    "payroll",
    "compensation",
    "performance",
    "disciplinary",
    "medical",
    "tax",
    "resume",
    "resumes",
    "employee_record",
    "employee_records",
)

IGNORED_DIR_NAMES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".venv",
        "venv",
        "__pycache__",
        "node_modules",
        ".next",
        ".pytest_cache",
        ".cache",
        "dist",
        "build",
        "release",
        "$recycle.bin",
        "system volume information",
        "recovery",
        "$winreagent",
        "config.msi",
        "msocache",
        "windows",
        "program files",
        "program files (x86)",
        "programdata",
        "appdata",
        "windowsapps",
        "wpsystem",
        "steamlibrary",
        "xboxgames",
        "onedrivetemp",
        "perflogs",
        "found.000",
        "temp",
        "tmp",
    }
)

ALL_COMPARTMENTS = (
    "comp_general",
    "comp_finance",
    "comp_contracts",
    "comp_hr_sensitive",
    "comp_hr_public",
    "comp_projects",
    "comp_customers",
)

ROLE_NAME_MAP: dict[str, Role] = {
    role.value.casefold(): role for role in Role
}
for _role in Role:
    ROLE_NAME_MAP.setdefault(_role.name.casefold(), _role)
for _alias, _mapped_role in LEGACY_ROLE_ALIASES.items():
    ROLE_NAME_MAP.setdefault(_alias.casefold(), _mapped_role)

_AUTH_SERVICE = AuthorizationService()


def get_machine_id() -> str:
    """Return a stable non-PII machine fingerprint for workspace isolation."""
    raw = f"{socket.gethostname()}|{os.environ.get('COMPUTERNAME', '')}|{os.name}"
    return hashlib.sha256(raw.encode("utf-8", errors="ignore")).hexdigest()[:16]


def resolve_local_data_dir(explicit_dir: str | Path | None = None) -> Path:
    """Resolve %LOCALAPPDATA%/NanviAssistant (safe inside MSIX and standard Windows)."""
    if explicit_dir:
        base = Path(explicit_dir)
    elif os.environ.get("NANVI_LOCAL_DATA_DIR"):
        base = Path(os.environ["NANVI_LOCAL_DATA_DIR"])
    elif os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        base = Path(os.environ["LOCALAPPDATA"]) / "NanviAssistant"
    else:
        base = Path.home() / ".nanvi_assistant"
    base.mkdir(parents=True, exist_ok=True)
    return base


def compute_workspace_id(folder_path: str | Path, tenant_id: str = "default-tenant") -> str:
    """Create a short deterministic ID for a root folder within a tenant."""
    resolved = str(Path(folder_path).resolve()).casefold()
    payload = f"{tenant_id}|{resolved}".encode("utf-8", errors="ignore")
    return hashlib.sha256(payload).hexdigest()[:20]


def resolve_workspace_data_dir(
    workspace_id: str,
    local_data_dir: str | Path | None = None,
) -> Path:
    """Return isolated per-workspace index directory under local app data."""
    root = resolve_local_data_dir(local_data_dir) / "search_workspaces" / workspace_id
    root.mkdir(parents=True, exist_ok=True)
    return root


def resolve_model_cache_dir(local_data_dir: str | Path | None = None) -> Path:
    """Return persistent model cache directory outside %TEMP%."""
    cache = resolve_local_data_dir(local_data_dir) / "models"
    cache.mkdir(parents=True, exist_ok=True)
    return cache


@lru_cache(maxsize=8)
def _cached_blocked_windows_roots(env_sig: tuple[str, ...]) -> tuple[Path, ...]:
    roots: list[Path] = []
    if os.name == "nt":
        candidates = [
            env_sig[0] or r"C:\Windows",
            env_sig[1] or r"C:\Program Files",
            env_sig[2] or r"C:\Program Files (x86)",
            env_sig[3] or r"C:\ProgramData",
            f"{env_sig[4] or 'C:'}\\$Recycle.Bin",
            f"{env_sig[4] or 'C:'}\\System Volume Information",
            f"{env_sig[4] or 'C:'}\\Recovery",
        ]
        for item in candidates:
            try:
                roots.append(Path(item).resolve())
            except OSError:
                continue
    else:
        for item in ("/bin", "/sbin", "/usr", "/etc", "/proc", "/sys", "/dev"):
            try:
                roots.append(Path(item).resolve())
            except OSError:
                continue
    return tuple(roots)


def _blocked_windows_roots() -> list[Path]:
    """Build normalized list of OS system directories that must never be indexed."""
    if os.name == "nt":
        sig = (
            os.environ.get("WINDIR") or "",
            os.environ.get("ProgramFiles") or "",
            os.environ.get("ProgramFiles(x86)") or "",
            os.environ.get("ProgramData") or "",
            os.environ.get("SystemDrive") or "C:",
        )
    else:
        sig = ("posix",)
    return list(_cached_blocked_windows_roots(sig))


def is_blocked_system_path(
    path: str | Path,
    local_data_dir: Path | None = None,
    *,
    scan_root: Path | None = None,
) -> bool:
    """Return True if path points to OS system folders, Nanvi index data, or ignored subdirs."""
    try:
        resolved = Path(path).resolve()
    except OSError:
        return True

    data_root = (local_data_dir or resolve_local_data_dir()).resolve()
    try:
        if resolved == data_root or resolved.is_relative_to(data_root):
            return True
    except (OSError, ValueError):
        pass

    for blocked in _blocked_windows_roots():
        try:
            if resolved == blocked or resolved.is_relative_to(blocked):
                return True
        except (OSError, ValueError):
            continue

    if scan_root is not None:
        try:
            rel_parts = resolved.relative_to(scan_root.resolve()).parts
            for part in rel_parts:
                part_low = part.casefold()
                if part_low in IGNORED_DIR_NAMES or part_low.startswith("$"):
                    return True
        except (OSError, ValueError):
            pass
    name_low = resolved.name.casefold()
    if name_low in IGNORED_DIR_NAMES or name_low.startswith("$"):
        return True
    return False


def validate_scan_root(folder_path: str | Path, local_data_dir: Path | None = None) -> Path:
    """Validate that a desktop folder is safe and readable before indexing."""
    resolved = Path(folder_path).resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise ValueError(f"Workspace folder does not exist or is not a directory: {folder_path}")

    # Refuse filesystem roots (e.g. C:\ or /) as runaway scan targets,
    # but allow approved non-system storage partitions/drives (e.g. D:\, H:\) on Windows.
    if resolved == resolved.parent:
        if os.name == "nt":
            sys_drive = (os.environ.get("SystemDrive") or "C:").rstrip("\\").casefold()
            res_drive = resolved.drive.rstrip("\\").casefold()
            if not res_drive or res_drive == sys_drive:
                raise ValueError(f"Refusing to index system drive root: {resolved}")
        else:
            raise ValueError(f"Refusing to index entire drive root: {resolved}")

    if is_blocked_system_path(resolved, local_data_dir=local_data_dir):
        raise ValueError(f"Refusing to index protected system/application directory: {resolved}")
    return resolved


def is_cloud_placeholder(path: str | Path) -> bool:
    """Detect unhydrated OneDrive / Windows Cloud Files stubs without triggering download."""
    if os.name != "nt":
        return False
    try:
        attrs = ctypes.windll.kernel32.GetFileAttributesW(str(path))
        if attrs == -1 or attrs == 0xFFFFFFFF:
            return False
        return bool(attrs & CLOUD_STUB_MASK)
    except Exception:
        return False


def harden_directory_acl(target_dir: Path) -> bool:
    """Restrict a local index directory to the current Windows user and SYSTEM."""
    target_dir.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        try:
            os.chmod(target_dir, 0o700)
            return True
        except OSError:
            return False

    marker = target_dir / ".acl_hardened"
    if marker.exists():
        return True

    domain = os.environ.get("USERDOMAIN", "")
    user = os.environ.get("USERNAME") or getpass.getuser()
    principal = f"{domain}\\{user}" if domain else user
    cmd = [
        "icacls",
        str(target_dir),
        "/inheritance:r",
        "/grant:r",
        f"{principal}:(OI)(CI)F",
        "/grant:r",
        "SYSTEM:(OI)(CI)F",
    ]
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if res.returncode == 0:
            try:
                marker.write_text("ok", encoding="utf-8")
            except OSError:
                pass
            return True
        return False
    except Exception as exc:
        logger.debug("icacls ACL hardening skipped for %s: %s", target_dir, exc)
        return False


def generate_sidecar_token() -> str:
    """Generate a high-entropy shared secret for 127.0.0.1 sidecar IPC."""
    return secrets.token_urlsafe(32)


def verify_sidecar_token(provided: str | None, expected: str | None) -> bool:
    """Constant-time validation of X-Nanvi-Sidecar-Token."""
    if not provided or not expected:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _dpapi_protect(raw_bytes: bytes) -> bytes:
    """Protect key material using Windows DPAPI (CurrentUser scope)."""
    if os.name != "nt":
        return b"RAW:" + base64.b64encode(raw_bytes)
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = (ctypes.c_byte * len(raw_bytes))(*raw_bytes)
    in_blob = _DATA_BLOB(len(raw_bytes), buf)
    out_blob = _DATA_BLOB()
    if not crypt32.CryptProtectData(
        ctypes.byref(in_blob),
        "NanviDesktopSearchKey",
        None,
        None,
        None,
        0x01,  # CRYPTPROTECT_UI_FORBIDDEN
        ctypes.byref(out_blob),
    ):
        raise OSError("Windows DPAPI CryptProtectData failed")
    try:
        return b"DPAPI:" + base64.b64encode(ctypes.string_at(out_blob.pbData, out_blob.cbData))
    finally:
        kernel32.LocalFree(out_blob.pbData)


def _dpapi_unprotect(wrapped: bytes) -> bytes:
    """Unprotect Windows DPAPI-wrapped key material."""
    if wrapped.startswith(b"RAW:"):
        return base64.b64decode(wrapped[4:])
    if not wrapped.startswith(b"DPAPI:") or os.name != "nt":
        raise ValueError("Unsupported local key envelope")
    raw_cipher = base64.b64decode(wrapped[6:])
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = (ctypes.c_byte * len(raw_cipher))(*raw_cipher)
    in_blob = _DATA_BLOB(len(raw_cipher), buf)
    out_blob = _DATA_BLOB()
    if not crypt32.CryptUnprotectData(
        ctypes.byref(in_blob),
        None,
        None,
        None,
        None,
        0x01,  # CRYPTPROTECT_UI_FORBIDDEN
        ctypes.byref(out_blob),
    ):
        raise OSError("Windows DPAPI CryptUnprotectData failed")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        kernel32.LocalFree(out_blob.pbData)


class LocalPayloadCipher:
    """Optional DPAPI-wrapped AES-256-GCM encryption for local sensitive text payloads."""

    def __init__(self, key_bytes: bytes | None = None, key_path: Path | None = None) -> None:
        if key_bytes is not None:
            if len(key_bytes) not in (16, 24, 32):
                raise ValueError("AESGCM key must be 16, 24, or 32 bytes")
            self._key = key_bytes
        elif key_path is not None:
            self._key = self._load_or_create_key(key_path)
        else:
            self._key = self._load_or_create_key(resolve_local_data_dir() / "local_index.key")
        self._aes = AESGCM(self._key)

    @staticmethod
    def _load_or_create_key(key_path: Path) -> bytes:
        key_path.parent.mkdir(parents=True, exist_ok=True)
        if key_path.exists():
            return _dpapi_unprotect(key_path.read_bytes().strip())
        key = AESGCM.generate_key(bit_length=256)
        key_path.write_bytes(_dpapi_protect(key))
        return key

    def encrypt_text(self, plaintext: str, aad: str = "") -> str:
        nonce = secrets.token_bytes(12)
        cipher = self._aes.encrypt(nonce, plaintext.encode("utf-8"), aad.encode("utf-8"))
        return "ENC1:" + base64.b64encode(nonce + cipher).decode("ascii")

    def decrypt_text(self, payload: str, aad: str = "") -> str:
        if not payload.startswith("ENC1:"):
            return payload
        raw = base64.b64decode(payload[5:].encode("ascii"))
        nonce, cipher = raw[:12], raw[12:]
        return self._aes.decrypt(nonce, cipher, aad.encode("utf-8")).decode("utf-8")


def classify_file_compartment(
    rel_path: str,
    filename: str,
    base_root_name: str = "",
) -> tuple[str, str, bool]:
    """Map a workspace file to (department, hnsw_compartment, is_sensitive)."""
    norm = rel_path.replace("\\", "/")
    parts = tuple(p for p in norm.split("/")[:-1] if p)
    department, _sensitivity_label = _classify_department(parts, filename, base_root_name)
    lower_rel = norm.casefold()

    if department == "Finance":
        return "Finance", "comp_finance", True
    if department == "Contracts":
        return "Contracts", "comp_contracts", True
    if department == "Customers":
        return "Customers", "comp_customers", True
    if department == "HR" or department == "Resumes":
        if any(term in lower_rel for term in SENSITIVE_HR_TERMS) or department == "Resumes":
            return department, "comp_hr_sensitive", True
        return "HR", "comp_hr_public", False
    if department == "Projects":
        return "Projects", "comp_projects", False
    return department or "General", "comp_general", False


def _parse_roles(search_filter: SearchFilter) -> frozenset[Role]:
    raw_roles = list(search_filter.roles or ())
    if search_filter.role and search_filter.role not in raw_roles:
        raw_roles.append(search_filter.role)
    parsed: set[Role] = set()
    for r in raw_roles:
        found = ROLE_NAME_MAP.get(str(r).strip().casefold())
        if found is not None:
            parsed.add(found)
    if not parsed:
        parsed.add(Role.EMPLOYEE)
    return frozenset(parsed)


def build_user_attributes(search_filter: SearchFilter) -> UserAttributes:
    """Convert a desktop SearchFilter into enterprise UserAttributes."""
    return UserAttributes(
        user_id=search_filter.user_id,
        tenant_id=search_filter.tenant_id,
        department=search_filter.department,
        roles=_parse_roles(search_filter),
    )


def resolve_allowed_compartments(search_filter: SearchFilter) -> tuple[str, ...]:
    """Compute physical HNSW compartments a caller is authorized to search."""
    if search_filter.allowed_compartments is not None:
        return tuple(c for c in search_filter.allowed_compartments if c in ALL_COMPARTMENTS)

    user = build_user_attributes(search_filter)
    privileged = {
        Role.SUPERIOR,
        Role.SUPERVISOR,
        Role.CEO,
        Role.FINANCE,
        Role.MANAGER,
        Role.IT_ADMIN,
        Role.ADMIN,
    }
    allowed: list[str] = ["comp_general", "comp_projects"]

    if search_filter.exclude_sensitive:
        allowed.append("comp_hr_public")
        return tuple(allowed)

    if user.roles.intersection(privileged):
        return ALL_COMPARTMENTS

    if Role.HR in user.roles:
        allowed.extend(["comp_hr_sensitive", "comp_hr_public", "comp_customers"])
    elif Role.PROJECT_ENGINEER in user.roles:
    if Role.PROJECT_ENGINEER in user.roles:
        allowed.extend(["comp_hr_public", "comp_customers", "comp_contracts"])
    if Role.EMPLOYEE in user.roles or Role.INTERN in user.roles:
        allowed.append("comp_hr_public")
    elif Role.EMPLOYEE in user.roles:
        allowed.append("comp_hr_public")

    if user.department:
        dept_map = {
            "finance": "comp_finance",
            "contracts": "comp_contracts",
            "customers": "comp_customers",
            "hr": "comp_hr_sensitive",
        }
        mapped = dept_map.get(user.department.casefold())
        if mapped and mapped not in allowed:
            allowed.append(mapped)

    return tuple(dict.fromkeys(allowed))


def authorize_document_access(
    search_filter: SearchFilter,
    *,
    doc_id: str,
    rel_path: str,
    department: str,
    is_sensitive: bool,
) -> bool:
    """Evaluate exact Nanvi ABAC+RBAC policy before returning a candidate hit."""
    if search_filter.exclude_sensitive and is_sensitive:
        return False

    user = build_user_attributes(search_filter)
    # Infer restricted_department consistently with CompanyDataService indexing.
    restricted_department: str | None = None
    if is_sensitive or department in {"Finance", "Contracts", "Customers", "HR", "Resumes"}:
        restricted_department = "HR" if department == "Resumes" else department

    resource = Resource(
        resource_id=doc_id,
        resource_type="company_file",
        tenant_id=search_filter.tenant_id,
        department=department,
        attributes={
            "relative_path": rel_path,
            "restricted_department": restricted_department,
        },
    )
    decision = _AUTH_SERVICE.authorize(user, Permission.FILE_READ, resource)
    return decision.allowed

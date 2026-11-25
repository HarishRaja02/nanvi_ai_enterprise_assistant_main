"""Active folder persistence across server restarts and per-tenant configurations."""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PROJECT_STORAGE_FILE = Path(__file__).resolve().parents[4] / "storage" / "active_folders.json"
BACKEND_STORAGE_FILE = Path(__file__).resolve().parents[3] / "storage" / "active_folders.json"
ACTIVE_FOLDERS_FILE = PROJECT_STORAGE_FILE
ACTIVE_FOLDER_FILE = Path(__file__).resolve().parents[4] / "storage" / "active_folder.json"
BACKEND_ACTIVE_FOLDER_FILE = Path(__file__).resolve().parents[3] / "storage" / "active_folder.json"


def _is_valid_dir(path_str: str | None) -> bool:
    if not path_str or not isinstance(path_str, str):
        return False
    stripped = path_str.strip()
    norm = stripped.replace("\\", "/").lower()
    if not stripped or stripped == "." or "/var/task" in norm or "var/task" in norm:
        return False
    try:
        p = Path(stripped).resolve()
        repo_root = Path(__file__).resolve().parents[4]
        return p != repo_root and p.exists() and p.is_dir()
    except Exception:
        return False


def get_persisted_folder(tenant_id: str = "default") -> Path | None:
    """Read the last chosen active folder path for the given tenant from persistent storage."""
    if os.getenv("VERCEL") or os.getenv("VERCEL_ENV") or os.getenv("AWS_LAMBDA_FUNCTION_NAME"):
        return None
    t_id = (tenant_id or "default").strip()
    candidate_files = [PROJECT_STORAGE_FILE, BACKEND_STORAGE_FILE, ACTIVE_FOLDER_FILE, BACKEND_ACTIVE_FOLDER_FILE]

    for f in candidate_files:
        try:
            if not f.exists():
                continue
            data = json.loads(f.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                continue

            # 1. Direct tenant match
            t_data = data.get(t_id)
            if isinstance(t_data, dict) and _is_valid_dir(t_data.get("path")):
                return Path(t_data["path"]).resolve()

            # 2. enterprise-tenant / default match (only when querying default or enterprise-tenant)
            if t_id in ("enterprise-tenant", "default"):
                ent_data = data.get("enterprise-tenant")
                if isinstance(ent_data, dict) and _is_valid_dir(ent_data.get("path")):
                    return Path(ent_data["path"]).resolve()

                def_data = data.get("default")
                if isinstance(def_data, dict) and _is_valid_dir(def_data.get("path")):
                    return Path(def_data["path"]).resolve()

                # Top-level path object (e.g. active_folder.json)
                top_path = data.get("path")
                if _is_valid_dir(top_path):
                    return Path(top_path).resolve()
        except Exception as exc:
            logger.debug("Could not read persisted folder file %s: %s", f, exc)

    return None


def set_persisted_folder(path: Path | str, tenant_id: str = "default") -> None:
    """Save active folder path for the given tenant to persistent storage."""
    t_id = (tenant_id or "default").strip()
    try:
        resolved = Path(path).resolve()
        path_str = str(resolved)
        now_iso = datetime.now(timezone.utc).isoformat()

        for target_file in (PROJECT_STORAGE_FILE, BACKEND_STORAGE_FILE):
            try:
                target_file.parent.mkdir(parents=True, exist_ok=True)
                all_data: dict[str, Any] = {}
                if target_file.exists():
                    try:
                        all_data = json.loads(target_file.read_text(encoding="utf-8"))
                        if not isinstance(all_data, dict):
                            all_data = {}
                    except Exception:
                        all_data = {}

                record = {"path": path_str, "updated_at": now_iso}
                all_data[t_id] = record
                all_data["default"] = record
                all_data["enterprise-tenant"] = record
                target_file.write_text(json.dumps(all_data, indent=2), encoding="utf-8")
            except Exception as e:
                logger.debug("Could not write to %s: %s", target_file, e)

        for single_file in (ACTIVE_FOLDER_FILE, BACKEND_ACTIVE_FOLDER_FILE):
            try:
                single_file.parent.mkdir(parents=True, exist_ok=True)
                single_file.write_text(
                    json.dumps({"path": path_str, "updated_at": now_iso}, indent=2),
                    encoding="utf-8",
                )
            except Exception:
                pass

        logger.info("Persisted active company data folder for tenant '%s': %s", t_id, path_str)
    except Exception as exc:
        logger.warning("Could not persist active folder path for tenant '%s': %s", t_id, exc)


def clear_persisted_folder(tenant_id: str = "default") -> None:
    """Clear active folder paths from persistent storage files upon folder disconnection."""
    t_id = (tenant_id or "default").strip()
    candidate_storage_files = (PROJECT_STORAGE_FILE, BACKEND_STORAGE_FILE)
    for target_file in candidate_storage_files:
        try:
            if target_file.exists():
                all_data: dict[str, Any] = {}
                try:
                    all_data = json.loads(target_file.read_text(encoding="utf-8"))
                    if not isinstance(all_data, dict):
                        all_data = {}
                except Exception:
                    all_data = {}
                all_data.pop(t_id, None)
                all_data.pop("default", None)
                all_data.pop("enterprise-tenant", None)
                target_file.write_text(json.dumps(all_data, indent=2), encoding="utf-8")
        except Exception as exc:
            logger.debug("Could not clear target storage file %s: %s", target_file, exc)

    candidate_single_files = (ACTIVE_FOLDER_FILE, BACKEND_ACTIVE_FOLDER_FILE)
    for single_file in candidate_single_files:
        try:
            if single_file.exists():
                single_file.write_text("{}", encoding="utf-8")
        except Exception as exc:
            logger.debug("Could not clear single active folder file %s: %s", single_file, exc)

    logger.info("Cleared persisted active company data folder for tenant '%s'", t_id)

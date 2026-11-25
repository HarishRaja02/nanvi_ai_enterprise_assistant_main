"""Nanvi Local File Agent with Clean White GUI for Windows.

Designed for all users, including non-technical users and seniors aged 50-60.
Features:
- Pure white modern native graphical window (no scary black command prompt)
- 1-click Windows folder selection dialog
- Real-time indexing progress and chunk sync to Nanvi cloud
- Automatic heartbeat and folder-sync loop
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import re
import signal
import struct
import sys
import tempfile
import threading
import time
import webbrowser
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# Tkinter GUI imports
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

# Setup logging (safe under pythonw.exe where sys.stdout is None and in locked-down/sandbox envs)
_log_dir = Path.home() / "AppData" / "Local" / "NanviAgent"
_log_file = _log_dir / "agent.log"
_pid_file = _log_dir / "agent.pid"
_handlers: list[logging.Handler] = []
for _candidate_dir in (_log_dir, Path(tempfile.gettempdir()) / "NanviAgent"):
    try:
        _candidate_dir.mkdir(parents=True, exist_ok=True)
        _candidate_log = _candidate_dir / "agent.log"
        _handlers.append(logging.FileHandler(str(_candidate_log), encoding="utf-8"))
        _log_dir = _candidate_dir
        _log_file = _candidate_log
        _pid_file = _candidate_dir / "agent.pid"
        break
    except Exception:
        continue
if sys.stdout is not None:
    _handlers.append(logging.StreamHandler(sys.stdout))
if not _handlers:
    _handlers.append(logging.NullHandler())
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=_handlers,
)
logger = logging.getLogger("NanviLocalAgent")

LOCAL_CONFIG_FILE = Path(__file__).resolve().parent / "config.json"
CONFIG_FILE = Path.home() / ".nanvi_local_agent_config.json"
MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024  # 50 MB
CHUNK_SIZE_CHARS = 1000
CHUNK_OVERLAP_CHARS = 150

BLOCKED_EXTENSIONS = {
    ".exe", ".dll", ".bat", ".cmd", ".ps1", ".vbs", ".sh", ".bin",
    ".msi", ".sys", ".com", ".scr", ".jar", ".iso", ".img", ".dmg",
}

SUPPORTED_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".log", ".json", ".jsonl",
    ".xml", ".html", ".htm", ".yaml", ".yml", ".rtf",
    ".pdf", ".docx", ".xlsx", ".xlsm", ".pptx",
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif",
}

BLOCKED_SYSTEM_PATHS = [
    Path(os.environ.get("SystemRoot", "C:\\Windows")).resolve(),
    Path(os.environ.get("ProgramFiles", "C:\\Program Files")).resolve(),
    Path(os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")).resolve(),
    Path("C:\\Windows").resolve(),
]


class SecurityError(ValueError):
    """Raised when an unauthorized folder or file access is attempted."""
    pass


def sanitize_folder_path(raw_path: str) -> str:
    """Sanitize and clean folder paths, stripping quotes, environments, and accidental prefixes."""
    if not raw_path:
        return ""
    cleaned = str(raw_path).strip().strip("'\"“”`")
    for prefix in [
        "nanvi-agent add",
        "nanvi local agent add",
        "nanvi add",
        "python nanvi_local_agent.py add",
        "python nanvi_gui_agent.py add",
        "python local_agent.py add",
        "python add",
        "add folder",
        "add path",
        "add:",
        "add",
    ]:
        if cleaned.lower().startswith(prefix.lower() + " ") or cleaned.lower() == prefix.lower():
            cleaned = cleaned[len(prefix):].strip().strip("'\"“”`")
            break
    cleaned = cleaned.strip("'\"“”`:").strip()
    cleaned = os.path.expandvars(cleaned)
    return cleaned


class NanviLocalAgent:
    """Manages local approved folders, file indexing, filesystem watching, and cloud sync."""

    def __init__(self, server_url: str, token: str, config_path: Path | None = None) -> None:
        self.server_url = server_url.rstrip("/")
        self.token = token
        self.config_path = config_path or (LOCAL_CONFIG_FILE if LOCAL_CONFIG_FILE.exists() else CONFIG_FILE)
        self.approved_folders: dict[str, dict[str, Any]] = {}
        self.running = False
        self._sync_lock = threading.Lock()
        self.status_callback = None
        self.folder_callback = None
        self.browse_callback = None
        self._last_opened_time = 0.0
        self._failed_requested_folders: set[str] = set()
        self._load_config()

    def _load_config(self) -> None:
        if self.config_path.exists():
            try:
                data = json.loads(self.config_path.read_text(encoding="utf-8"))
                if not self.server_url and data.get("server_url"):
                    self.server_url = data["server_url"].rstrip("/")
                if not self.token and data.get("token"):
                    self.token = data["token"]
                for f_info in data.get("folders", []):
                    path = f_info.get("path")
                    if path and Path(path).exists() and Path(path).is_dir():
                        resolved = str(Path(path).resolve())
                        self.approved_folders[resolved] = {
                            "path": resolved,
                            "display_name": f_info.get("display_name") or Path(path).name or resolved,
                            "file_count": f_info.get("file_count", 0),
                            "chunk_count": f_info.get("chunk_count", 0),
                            "status": "ready",
                        }
            except Exception as exc:
                logger.warning("Could not read configuration: %s", exc)

    def _save_config(self) -> None:
        try:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
            export = {
                "server_url": self.server_url,
                "token": self.token,
                "folders": [
                    {
                        "path": v["path"],
                        "display_name": v.get("display_name", Path(v["path"]).name),
                        "file_count": v.get("file_count", 0),
                        "chunk_count": v.get("chunk_count", 0),
                    }
                    for v in self.approved_folders.values()
                ],
            }
            self.config_path.write_text(json.dumps(export, indent=2), encoding="utf-8")
        except Exception as exc:
            logger.warning("Could not save configuration: %s", exc)
    def validate_folder(self, folder_path: str | Path) -> Path:
        clean = sanitize_folder_path(str(folder_path))
        if not clean:
            raise ValueError("Folder path cannot be empty.")
        p = Path(clean).expanduser().resolve()
        if not p.exists() or not p.is_dir():
            raise FileNotFoundError(f"Folder does not exist or is not a directory: {clean}")

        for blocked in BLOCKED_SYSTEM_PATHS:
            try:
                if p == blocked or p.is_relative_to(blocked):
                    raise SecurityError(f"System directory access blocked: {p}")
            except (ValueError, TypeError):
                pass

        if p.parent == p:
            raise SecurityError(f"Root drive paths cannot be approved directly. Please select a subfolder: {p}")

        return p

    def set_single_folder(self, folder_path: str, display_name: str | None = None) -> Path:
        """Exclusively connect a single folder, replacing any previously connected folders."""
        p = self.validate_folder(folder_path)
        path_str = str(p)
        name = display_name or p.name or path_str
        self.approved_folders.clear()
        self.approved_folders[path_str] = {
            "path": path_str,
            "display_name": name,
            "file_count": 0,
            "chunk_count": 0,
            "status": "indexing",
        }
        self._save_config()
        if self.folder_callback:
            self.folder_callback()
        if self.running:
            threading.Thread(target=self.send_heartbeat, daemon=True).start()
            threading.Thread(target=self.index_and_sync_folder, args=(path_str,), daemon=True).start()
        return p

    def add_folder(self, folder_path: str, display_name: str | None = None) -> Path:
        return self.set_single_folder(folder_path, display_name=display_name)

    def remove_folder(self, folder_path: str) -> bool:
        target = str(Path(folder_path).expanduser().resolve())
        if target in self.approved_folders:
            del self.approved_folders[target]
            self._save_config()
            if self.folder_callback:
                self.folder_callback()
            return True
        return False

    def _extract_text(self, file_path: Path) -> str:
        ext = file_path.suffix.casefold()
        if ext in {".txt", ".md", ".markdown", ".csv", ".tsv", ".log", ".json", ".jsonl", ".xml", ".html", ".htm", ".yaml", ".yml", ".rtf"}:
            try:
                text = file_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                text = file_path.read_text(encoding="latin-1", errors="replace")
            if ext in {".html", ".htm", ".xml"}:
                text = re.sub(r"<[^>]+>", " ", text)
                text = re.sub(r"\s+", " ", text).strip()
            return text

        if ext in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"}:
            try:
                from backend.documents.ocr import extract_text_from_image_bytes

                ocr_txt, _ = extract_text_from_image_bytes(file_path.read_bytes(), filename=file_path.name)
                return ocr_txt
            except Exception:
                return ""

        if ext == ".pdf":
            try:
                from backend.documents.ocr import iter_pdf_pages_with_ocr

                pages = [txt for _pn, txt, _ocr in iter_pdf_pages_with_ocr(file_path)]
                if any(pages):
                    return "\n\n".join(pages)
            except Exception:
                pass
            try:
                import pypdf
                reader = pypdf.PdfReader(str(file_path))
                extracted = "\n\n".join(p.extract_text() or "" for p in reader.pages).strip()
                if extracted:
                    return extracted
            except Exception:
                pass
            raw = file_path.read_bytes()
            chunks: list[str] = []
            for stream in re.findall(rb"stream[\r\n]+(.*?)[\r\n]+endstream", raw, re.DOTALL):
                try:
                    data = zlib.decompress(stream)
                except Exception:
                    data = stream
                literals = re.findall(rb"\(([^()\\]*(?:\\.[^()\\]*)*)\)", data)
                if literals:
                    parts = []
                    for lit in literals:
                        txt = lit.decode("latin-1", errors="ignore")
                        txt = txt.replace(r"\(", "(").replace(r"\)", ")").replace(r"\\", "\\")
                        if any(c.isalnum() for c in txt):
                            parts.append(txt)
                    if parts:
                        chunks.append(" ".join(parts))
            if chunks:
                return "\n".join(chunks)
            ascii_strings = re.findall(rb"[\x20-\x7E\t\n\r]{4,}", raw)
            return "\n".join(s.decode("ascii", errors="ignore") for s in ascii_strings[:500])

        if ext == ".docx":
            try:
                import docx
                doc = docx.Document(str(file_path))
                return "\n".join(p.text for p in doc.paragraphs if p.text)
            except Exception:
                pass
            import zipfile
            try:
                with zipfile.ZipFile(file_path) as z:
                    xml = z.read("word/document.xml").decode("utf-8", errors="ignore")
                    text = re.sub(r"<[^>]+>", " ", xml)
                    return re.sub(r"\s+", " ", text).strip()
            except Exception:
                return ""

        if ext in {".xlsx", ".xlsm"}:
            try:
                import openpyxl
                wb = openpyxl.load_workbook(str(file_path), read_only=True, data_only=True)
                lines = []
                for sheet in wb.sheetnames[:10]:
                    lines.append(f"--- Sheet: {sheet} ---")
                    for row in wb[sheet].iter_rows(max_row=200, values_only=True):
                        row_vals = [str(v) for v in row if v is not None]
                        if row_vals:
                            lines.append(" | ".join(row_vals))
                extracted = "\n".join(lines).strip()
                if extracted:
                    return extracted
            except Exception:
                pass
            import zipfile
            import xml.etree.ElementTree as ET
            try:
                with zipfile.ZipFile(file_path) as z:
                    shared: list[str] = []
                    if "xl/sharedStrings.xml" in z.namelist():
                        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
                        for si in root.iter():
                            if si.tag.endswith("}t") or si.tag == "t":
                                shared.append(si.text or "")
                    lines = []
                    for name in sorted(z.namelist()):
                        if name.startswith("xl/worksheets/sheet") and name.endswith(".xml"):
                            lines.append(f"--- Sheet: {Path(name).stem} ---")
                            sroot = ET.fromstring(z.read(name))
                            for row_el in sroot.iter():
                                if row_el.tag.endswith("}row") or row_el.tag == "row":
                                    vals = []
                                    for c_el in row_el:
                                        ctype = c_el.attrib.get("t", "")
                                        v_el = next((ch for ch in c_el if ch.tag.endswith("}v") or ch.tag == "v"), None)
                                        if v_el is not None and v_el.text is not None:
                                            if ctype == "s" and v_el.text.isdigit() and int(v_el.text) < len(shared):
                                                vals.append(shared[int(v_el.text)])
                                            else:
                                                vals.append(v_el.text)
                                    if vals:
                                        lines.append(" | ".join(vals))
                    return "\n".join(lines)
            except Exception:
                return ""

        if ext == ".pptx":
            import zipfile
            try:
                with zipfile.ZipFile(file_path) as z:
                    slides = []
                    for name in sorted(z.namelist()):
                        if name.startswith("ppt/slides/slide") and name.endswith(".xml"):
                            xml = z.read(name).decode("utf-8", errors="ignore")
                            slides.append(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", xml)).strip())
                    return "\n\n".join(slides)
            except Exception:
                return ""

        return ""

    def _chunk_text(self, text: str) -> list[str]:
        clean = re.sub(r"\r\n|\r", "\n", text).strip()
        if not clean:
            return []
        chunks = []
        pos = 0
        while pos < len(clean):
            end = min(pos + CHUNK_SIZE_CHARS, len(clean))
            if end < len(clean):
                split_at = clean.rfind("\n", pos, end)
                if split_at > pos + (CHUNK_SIZE_CHARS // 2):
                    end = split_at
            chunk = clean[pos:end].strip()
            if len(chunk) > 20:
                chunks.append(chunk)
            pos += CHUNK_SIZE_CHARS - CHUNK_OVERLAP_CHARS
        return chunks

    def index_and_sync_folder(self, folder_path: str) -> None:
        p = Path(folder_path)
        if not p.exists():
            return

        with self._sync_lock:
            folder_info = self.approved_folders.get(folder_path, {})
            folder_name = folder_info.get("display_name", p.name)

            if self.status_callback:
                self.status_callback(f"Scanning '{folder_name}'...")

            files_meta = []
            all_chunks = []

            for root, _, filenames in os.walk(p):
                for fname in filenames:
                    if fname.startswith(".") or fname.startswith("~$"):
                        continue
                    fpath = Path(root) / fname
                    ext = fpath.suffix.casefold()
                    if ext in BLOCKED_EXTENSIONS or ext not in SUPPORTED_EXTENSIONS:
                        continue

                    try:
                        stat = fpath.stat()
                        if stat.st_size > MAX_FILE_SIZE_BYTES or stat.st_size == 0:
                            continue
                        rel_path = str(fpath.relative_to(p)).replace("\\", "/")
                        text = self._extract_text(fpath)
                        text_chunks = self._chunk_text(text)

                        files_meta.append({
                            "relative_path": rel_path,
                            "filename": fname,
                            "folder_name": folder_name,
                            "file_type": ext.lstrip("."),
                            "size_bytes": stat.st_size,
                            "chunk_count": len(text_chunks),
                            "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                        })

                        for idx, chunk_text in enumerate(text_chunks):
                            cid = hashlib.sha256(f"{rel_path}:{idx}:{chunk_text[:50]}".encode()).hexdigest()[:16]
                            all_chunks.append({
                                "chunk_id": cid,
                                "relative_path": rel_path,
                                "filename": fname,
                                "folder_name": folder_name,
                                "chunk_index": idx,
                                "text": chunk_text,
                                "char_count": len(chunk_text),
                                "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                                "metadata": {},
                            })
                    except Exception as e:
                        logger.debug("Skip file %s: %s", fpath, e)

            # Update local folder stats
            if folder_path in self.approved_folders:
                self.approved_folders[folder_path]["file_count"] = len(files_meta)
                self.approved_folders[folder_path]["chunk_count"] = len(all_chunks)
                self.approved_folders[folder_path]["status"] = "synced"
                self._save_config()

            if self.folder_callback:
                self.folder_callback()

            # Push to cloud
            self._send_sync_payload(folder_path, folder_name, files_meta, all_chunks)

    def _send_sync_payload(self, folder_path: str, display_name: str, files: list, chunks: list) -> bool:
        url = f"{self.server_url}/api/local-agent/sync"
        BATCH_SIZE = 150

        if not chunks:
            payload = {
                "folder_id": folder_path,
                "folder_path": folder_path,
                "display_name": display_name,
                "files": files,
                "chunks": [],
                "replace_all": True,
            }
            return self._post_single_sync(url, payload, display_name, len(files), 0)

        total_chunks = len(chunks)
        total_batches = (total_chunks + BATCH_SIZE - 1) // BATCH_SIZE

        # Batch 0
        first_payload = {
            "folder_id": folder_path,
            "folder_path": folder_path,
            "display_name": display_name,
            "files": files,
            "chunks": chunks[:BATCH_SIZE],
            "replace_all": True,
        }
        if not self._post_single_sync(url, first_payload, display_name, len(files), total_chunks):
            return False

        # Batches 1..N
        for b_idx in range(1, total_batches):
            chunk_slice = chunks[b_idx * BATCH_SIZE : (b_idx + 1) * BATCH_SIZE]
            batch_payload = {
                "folder_id": folder_path,
                "folder_path": folder_path,
                "display_name": display_name,
                "files": [],
                "chunks": chunk_slice,
                "replace_all": False,
            }
            self._post_single_sync(url, batch_payload, display_name, 0, 0, silent=True)

        if self.status_callback:
            self.status_callback(f"✓ '{display_name}' synced ({len(files)} files, {total_chunks} chunks)")
        return True

    def _post_single_sync(self, url: str, payload: dict, display_name: str, files_count: int, chunks_count: int, silent: bool = False) -> bool:
        try:
            req = Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.token}",
                },
                method="POST",
            )
            with urlopen(req, timeout=30) as resp:
                ok = resp.status == 200
                if ok and not silent and self.status_callback:
                    self.status_callback(f"✓ '{display_name}' registered ({files_count} files, {chunks_count} chunks)")
                return ok
        except Exception as exc:
            logger.warning("Sync failed: %s", exc)
            if not silent and self.status_callback:
                self.status_callback(f"Sync error: {exc}")
            return False

    def send_heartbeat(self) -> bool:
        url = f"{self.server_url}/api/local-agent/heartbeat"
        folders_list = []
        for p_str, info in self.approved_folders.items():
            folders_list.append({
                "folder_id": p_str,
                "folder_path": p_str,
                "display_name": info.get("display_name", Path(p_str).name),
                "file_count": info.get("file_count", 0),
                "chunk_count": info.get("chunk_count", 0),
                "status": info.get("status", "connected"),
            })

        payload = {
            "agent_version": "1.1.0",
            "folders": folders_list,
        }
        try:
            req = Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.token}",
                },
                method="POST",
            )
            with urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    try:
                        raw = resp.read().decode("utf-8")
                        data = json.loads(raw)
                        requested = data.get("requested_folders", [])
                        for rf in requested:
                            clean_rf = sanitize_folder_path(str(rf))
                            if clean_rf and clean_rf not in self._failed_requested_folders:
                                try:
                                    resolved_str = str(Path(clean_rf).expanduser().resolve())
                                    if resolved_str not in self.approved_folders:
                                        logger.info("Adding requested folder from cloud: %s", clean_rf)
                                        self.add_folder(clean_rf)
                                        if self.status_callback:
                                            self.status_callback(f"✓ Added folder: {Path(clean_rf).name}")
                                except Exception as exc:
                                    self._failed_requested_folders.add(clean_rf)
                                    logger.warning("Could not add folder '%s': %s", clean_rf, exc)
                        # Execute any remote commands queued by the cloud (deduplicating browse_folder)
                        commands = data.get("commands", [])
                        seen_browse = False
                        for cmd in commands:
                            c_type = cmd.get("command")
                            payload_data = cmd.get("payload", {})
                            if c_type == "open_file":
                                fp = payload_data.get("file_path", "")
                                if fp:
                                    self._execute_open_file(fp)
                            elif c_type == "remove_folder":
                                rem_p = payload_data.get("folder_path") or payload_data.get("folder_id") or ""
                                if rem_p:
                                    self.remove_folder(rem_p)
                                    if self.status_callback:
                                        self.status_callback("● Folder disconnected from Web UI")
                            elif c_type == "browse_folder" and not seen_browse:
                                seen_browse = True
                                if self.browse_callback:
                                    self.browse_callback()
                    except Exception:
                        pass
                    return True
                return False
        except Exception:
            return False

    def _execute_open_file(self, file_path: str) -> None:
        """Safely open a file in the user's default Windows application."""
        clean = sanitize_folder_path(file_path)
        if not clean:
            return
        if clean.startswith("file:///"):
            clean = clean[8:]

        p = Path(clean).expanduser().resolve()

        if not p.exists() or not p.is_file():
            found = False
            # Search inside approved folders
            for folder_str in list(self.approved_folders.keys()):
                folder_p = Path(folder_str)
                cand = (folder_p / clean).resolve()
                if cand.is_file():
                    p = cand
                    found = True
                    break
                matches = list(folder_p.rglob(Path(clean).name))
                if matches and matches[0].is_file():
                    p = matches[0]
                    found = True
                    break
            if not found:
                # Search approved folder subdirectories
                pass

        if p.exists() and p.is_file():
            logger.info("Opening local file requested by Nanvi Cloud: %s", p)
            self._last_opened_time = time.time()
            opened = False
            try:
                import os
                if hasattr(os, "startfile"):
                    try:
                        os.startfile(str(p))
                        opened = True
                    except Exception as sf_err:
                        logger.warning("os.startfile failed (%s), trying cmd start...", sf_err)

                if not opened:
                    import subprocess
                    subprocess.Popen(["cmd", "/c", "start", '""', str(p)], shell=True)
                    opened = True

                if self.status_callback:
                    self.status_callback(f"✓ Opened: {p.name}")
            except Exception as exc:
                logger.warning("Failed to open file %s: %s", p, exc)
                try:
                    import subprocess
                    subprocess.Popen(["explorer.exe", f"/select,{str(p)}"])
                except Exception:
                    pass
        else:
            logger.warning("Requested file not found on computer: %s", clean)
            self._last_opened_time = time.time()
            if self.status_callback:
                self.status_callback(f"⚠️ File not found: {Path(clean).name}")

    def _heartbeat_loop(self) -> None:
        while self.running:
            ok = self.send_heartbeat()
            # Only revert to generic status if 6 seconds have passed since last notification
            if self.status_callback and (time.time() - self._last_opened_time > 6):
                if ok:
                    self.status_callback("● Connected to Nanvi Cloud")
                else:
                    self.status_callback("○ Reconnecting to Nanvi Cloud...")
            for _ in range(2):
                if not self.running:
                    break
                time.sleep(1)

    def _file_watch_loop(self) -> None:
        """Lightweight filesystem poll (15s) to sync new/modified files automatically."""
        prev_snapshots: dict[str, dict[str, float]] = {}
        while self.running:
            for _ in range(15):
                if not self.running:
                    return
                time.sleep(1)
            for folder_path in list(self.approved_folders.keys()):
                try:
                    p = Path(folder_path)
                    if not p.exists():
                        continue
                    current: dict[str, float] = {}
                    for root, dirs, files in os.walk(p):
                        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__", ".git", "venv")]
                        for fname in files:
                            fpath = Path(root) / fname
                            if fpath.suffix.casefold() in SUPPORTED_EXTENSIONS:
                                try:
                                    current[str(fpath.relative_to(p))] = fpath.stat().st_mtime
                                except OSError:
                                    pass
                    if folder_path in prev_snapshots and prev_snapshots[folder_path] != current:
                        logger.info("File changes detected in '%s' — re-syncing", p.name)
                        self.index_and_sync_folder(folder_path)
                    prev_snapshots[folder_path] = current
                except Exception as exc:
                    logger.debug("Watch error for %s: %s", folder_path, exc)

    def start(self) -> None:
        self.running = True
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()
        threading.Thread(target=self._file_watch_loop, daemon=True).start()
        for f in list(self.approved_folders.keys()):
            threading.Thread(target=self.index_and_sync_folder, args=(f,), daemon=True).start()

    def stop(self) -> None:
        self.running = False


# ---------------------------------------------------------------------------
# Pure-Stdlib App Icon Generator & Single-Instance Helpers
# ---------------------------------------------------------------------------

def _build_nanvi_icon_png(size: int = 32) -> bytes:
    """Build a crisp 32x32 RGBA PNG icon in pure Python stdlib (no Pillow required)."""
    def _png_chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack("!I", len(data)) + tag + data + struct.pack("!I", crc)

    rows = bytearray()
    pad = 2
    inner_r = size - pad * 2
    for y in range(size):
        rows.append(0)  # filter type 0
        for x in range(size):
            # Rounded square mask
            dx = max(pad + 5 - x, 0, x - (size - pad - 6))
            dy = max(pad + 5 - y, 0, y - (size - pad - 6))
            dist2 = dx * dx + dy * dy
            if x < pad or x >= size - pad or y < pad or y >= size - pad or dist2 > 25:
                rows.extend((0, 0, 0, 0))
                continue

            # Subtle gradient background (#0369a1 -> #0f172a)
            t = (x + y) / (2.0 * max(1, inner_r))
            bg_r = int(2 + 13 * t)
            bg_g = int(132 - 90 * t)
            bg_b = int(199 - 140 * t)

            # White geometric "N" glyph inside [9..22] x [8..23]
            in_left_bar = 9 <= x <= 11 and 8 <= y <= 23
            in_right_bar = 20 <= x <= 22 and 8 <= y <= 23
            diag_x = 10 + (y - 8) * (11.0 / 15.0)
            in_diag = 9 <= y <= 22 and abs(x - diag_x) <= 1.45
            if in_left_bar or in_right_bar or in_diag:
                rows.extend((255, 255, 255, 255))
            else:
                rows.extend((bg_r, bg_g, bg_b, 255))

    ihdr = struct.pack("!IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(rows), 9)
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", idat) + _png_chunk(b"IEND", b"")


def _replace_previous_instance() -> None:
    """Terminate an older running instance recorded in agent.pid and write our PID."""
    my_pid = os.getpid()
    if _pid_file.exists():
        try:
            old_pid = int(_pid_file.read_text(encoding="utf-8").strip())
            if old_pid > 0 and old_pid != my_pid:
                os.kill(old_pid, signal.SIGTERM)
                time.sleep(0.3)
        except Exception:
            pass
    try:
        _pid_file.write_text(str(my_pid), encoding="utf-8")
    except Exception:
        pass


def _cleanup_pid_file() -> None:
    try:
        if _pid_file.exists() and _pid_file.read_text(encoding="utf-8").strip() == str(os.getpid()):
            _pid_file.unlink(missing_ok=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Clean White Windows GUI (Tkinter)
# ---------------------------------------------------------------------------

class NanviAgentWindow:
    """Modern, clean white Windows application window for Nanvi Local Agent."""

    def __init__(self, agent: NanviLocalAgent) -> None:
        self.agent = agent
        self._picker_open = False
        self._icon_image = None

        if sys.platform == "win32":
            try:
                import ctypes
                ctypes.windll.shcore.SetProcessDpiAwareness(1)
            except Exception:
                pass

        self.root = tk.Tk()
        self.root.title("Nanvi Local Connector")
        self.root.geometry("740x600")
        self.root.minsize(640, 480)
        self.root.configure(bg="#ffffff")

        try:
            icon_b64 = base64.b64encode(_build_nanvi_icon_png(32)).decode("ascii")
            self._icon_image = tk.PhotoImage(data=icon_b64)
            self.root.iconphoto(True, self._icon_image)
        except Exception:
            pass

        # Hook agent callbacks to UI
        self.agent.status_callback = self._on_status_change
        self.agent.folder_callback = self._refresh_folder_list
        self.agent.browse_callback = self._on_remote_browse
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self._build_ui()
        self.agent.start()
        self._refresh_folder_list()

    def _build_ui(self) -> None:
        # Top Header Banner (Clean White with action link)
        header_frame = tk.Frame(self.root, bg="#ffffff", padx=24, pady=18)
        header_frame.pack(fill="x")

        header_top = tk.Frame(header_frame, bg="#ffffff")
        header_top.pack(fill="x")

        header_left = tk.Frame(header_top, bg="#ffffff")
        header_left.pack(side="left", fill="x", expand=True)

        title_label = tk.Label(
            header_left,
            text="Nanvi Local Connector",
            font=("Segoe UI", 16, "bold"),
            fg="#0f172a",
            bg="#ffffff",
        )
        title_label.pack(anchor="w")

        subtitle_label = tk.Label(
            header_left,
            text="Enterprise File Search • Documents stay private on your computer",
            font=("Segoe UI", 10),
            fg="#64748b",
            bg="#ffffff",
        )
        subtitle_label.pack(anchor="w", pady=(2, 0))

        web_btn = tk.Button(
            header_top,
            text="Open Nanvi Web App ↗",
            font=("Segoe UI", 9, "bold"),
            bg="#f1f5f9",
            fg="#0f172a",
            activebackground="#e2e8f0",
            relief="flat",
            padx=12,
            pady=6,
            cursor="hand2",
            command=lambda: webbrowser.open(self.agent.server_url),
        )
        web_btn.pack(side="right", anchor="n")

        # Cloud Connection Status Badge
        self.status_label = tk.Label(
            header_frame,
            text="● Connecting to Nanvi Cloud...",
            font=("Segoe UI", 10, "bold"),
            fg="#0284c7",
            bg="#ffffff",
        )
        self.status_label.pack(anchor="w", pady=(8, 0))

        # Thin divider
        divider = tk.Frame(self.root, height=1, bg="#e2e8f0")
        divider.pack(fill="x")

        # Main Content Area
        content = tk.Frame(self.root, bg="#ffffff", padx=24, pady=16)
        content.pack(fill="both", expand=True)

        # Privacy Notice
        privacy_box = tk.Frame(
            content,
            bg="#f0fdf4",
            highlightbackground="#bbf7d0",
            highlightthickness=1,
            padx=14,
            pady=10,
        )
        privacy_box.pack(fill="x", pady=(0, 16))

        privacy_text = tk.Label(
            privacy_box,
            text="Privacy Protected: Nanvi only accesses the folder you explicitly connect below.\nSystem directories, executables, and personal folders outside your selection remain private.",
            font=("Segoe UI", 9),
            fg="#166534",
            bg="#f0fdf4",
            justify="left",
        )
        privacy_text.pack(anchor="w")

        # Action Buttons Row
        btn_frame = tk.Frame(content, bg="#ffffff")
        btn_frame.pack(fill="x", pady=(0, 10))

        self.add_btn = tk.Button(
            btn_frame,
            text="Select Folder to Connect...",
            font=("Segoe UI", 11, "bold"),
            bg="#0284c7",
            fg="#ffffff",
            activebackground="#0369a1",
            activeforeground="#ffffff",
            relief="flat",
            padx=20,
            pady=10,
            cursor="hand2",
            command=self._on_browse_click,
        )
        self.add_btn.pack(side="left")

        # Manual Path Entry Row
        entry_frame = tk.Frame(content, bg="#ffffff")
        entry_frame.pack(fill="x", pady=(0, 16))

        self.placeholder_text = "Or paste any folder path here, e.g. C:\\CompanyData or D:\\Projects..."
        self.path_entry = tk.Entry(
            entry_frame,
            font=("Segoe UI", 10),
            bg="#f8fafc",
            fg="#64748b",
            highlightbackground="#cbd5e1",
            highlightcolor="#0284c7",
            highlightthickness=1,
            relief="flat",
        )
        self.path_entry.pack(side="left", fill="x", expand=True, ipady=7, padx=(0, 10))
        self.path_entry.insert(0, self.placeholder_text)
        self.path_entry.bind("<FocusIn>", self._clear_placeholder)
        self.path_entry.bind("<Return>", lambda e: self._on_add_manual_click())

        self.manual_add_btn = tk.Button(
            entry_frame,
            text="+ Connect Folder",
            font=("Segoe UI", 10, "bold"),
            bg="#0f172a",
            fg="#ffffff",
            activebackground="#334155",
            relief="flat",
            padx=16,
            pady=7,
            cursor="hand2",
            command=self._on_add_manual_click,
        )
        self.manual_add_btn.pack(side="right")

        # Section Header: Connected Folders
        folders_header = tk.Label(
            content,
            text="Connected Company Folder:",
            font=("Segoe UI", 11, "bold"),
            fg="#1e293b",
            bg="#ffffff",
        )
        folders_header.pack(anchor="w", pady=(8, 6))

        # Scrollable container for folder cards
        list_container = tk.Frame(content, bg="#f8fafc", highlightbackground="#e2e8f0", highlightthickness=1)
        list_container.pack(fill="both", expand=True)

        self.canvas = tk.Canvas(list_container, bg="#f8fafc", highlightthickness=0)
        scrollbar = ttk.Scrollbar(list_container, orient="vertical", command=self.canvas.yview)
        self.scrollable_frame = tk.Frame(self.canvas, bg="#f8fafc", padx=10, pady=10)

        self.scrollable_frame.bind(
            "<Configure>",
            lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")),
        )
        self.canvas.create_window((0, 0), window=self.scrollable_frame, anchor="nw")
        self.canvas.configure(yscrollcommand=scrollbar.set)

        self.canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        # Bottom Footer Banner
        footer = tk.Frame(self.root, bg="#f1f5f9", padx=20, pady=10)
        footer.pack(fill="x", side="bottom")

        footer_text = tk.Label(
            footer,
            text="You can minimize this window anytime while working in Nanvi AI.",
            font=("Segoe UI", 9),
            fg="#475569",
            bg="#f1f5f9",
        )
        footer_text.pack(side="left")

        min_btn = tk.Button(
            footer,
            text="Minimize",
            font=("Segoe UI", 9),
            bg="#e2e8f0",
            fg="#1e293b",
            activebackground="#cbd5e1",
            relief="flat",
            padx=12,
            pady=3,
            cursor="hand2",
            command=self.root.iconify,
        )
        min_btn.pack(side="right")

    def _on_status_change(self, msg: str) -> None:
        def update():
            if "not found" in msg.lower() or "error" in msg.lower() or "blocked" in msg.lower():
                self.agent._last_opened_time = time.time()
            self.status_label.config(text=msg)
            if "Connected" in msg or "✓" in msg or "indexing" in msg.lower():
                self.status_label.config(fg="#16a34a")
            else:
                self.status_label.config(fg="#d97706")
        try:
            self.root.after(0, update)
        except Exception:
            pass

    def _clear_placeholder(self, event=None) -> None:
        if self.path_entry.get() == self.placeholder_text:
            self.path_entry.delete(0, tk.END)
            self.path_entry.config(fg="#0f172a")

    def _open_folder_picker(self, bring_to_front: bool = False) -> None:
        """Open a single native Windows Explorer folder picker without re-entrancy."""
        if self._picker_open:
            return
        self._picker_open = True
        try:
            if bring_to_front:
                self.root.deiconify()
                self.root.lift()
                self.root.focus_force()
            selected = filedialog.askdirectory(
                parent=self.root,
                title="Select Company Folder for Nanvi AI Assistant",
            )
            if selected:
                p = self.agent.set_single_folder(selected)
                self._on_status_change(f"✓ Connected '{p.name}' — indexing files...")
        except Exception as exc:
            messagebox.showerror("Cannot Connect Folder", str(exc))
        finally:
            self._picker_open = False

    def _on_remote_browse(self) -> None:
        try:
            self.root.after(0, lambda: self._open_folder_picker(bring_to_front=True))
        except Exception:
            pass

    def _on_add_manual_click(self) -> None:
        raw = self.path_entry.get().strip()
        if not raw or raw == self.placeholder_text:
            return
        clean = sanitize_folder_path(raw)
        try:
            p = self.agent.set_single_folder(clean)
            self.path_entry.delete(0, tk.END)
            self._on_status_change(f"✓ Connected '{p.name}' — indexing files...")
        except Exception as exc:
            messagebox.showerror("Cannot Connect Folder", str(exc))

    def _on_browse_click(self) -> None:
        self._open_folder_picker(bring_to_front=False)

    def _refresh_folder_list(self) -> None:
        def update():
            for widget in self.scrollable_frame.winfo_children():
                widget.destroy()

            folders = self.agent.approved_folders
            if not folders:
                empty_lbl = tk.Label(
                    self.scrollable_frame,
                    text="No folder connected yet. Click 'Select Folder to Connect...' above.",
                    font=("Segoe UI", 10),
                    fg="#94a3b8",
                    bg="#f8fafc",
                    pady=20,
                )
                empty_lbl.pack(anchor="center")
                return

            for path_str, info in list(folders.items()):
                card = tk.Frame(
                    self.scrollable_frame,
                    bg="#ffffff",
                    highlightbackground="#cbd5e1",
                    highlightthickness=1,
                    padx=14,
                    pady=10,
                )
                card.pack(fill="x", pady=4, expand=True)

                left = tk.Frame(card, bg="#ffffff")
                left.pack(side="left", fill="both", expand=True)

                name_lbl = tk.Label(
                    left,
                    text=info.get("display_name", Path(path_str).name),
                    font=("Segoe UI", 10, "bold"),
                    fg="#0f172a",
                    bg="#ffffff",
                )
                name_lbl.pack(anchor="w")

                path_lbl = tk.Label(
                    left,
                    text=path_str,
                    font=("Consolas", 8),
                    fg="#64748b",
                    bg="#ffffff",
                )
                path_lbl.pack(anchor="w")

                status_lbl = info.get("status", "connected").capitalize()
                count_text = f"{info.get('file_count', 0)} files ({info.get('chunk_count', 0)} chunks) • {status_lbl}"
                stats_lbl = tk.Label(
                    left,
                    text=count_text,
                    font=("Segoe UI", 8),
                    fg="#16a34a",
                    bg="#ffffff",
                )
                stats_lbl.pack(anchor="w")

                def make_remove(p=path_str):
                    def do_remove():
                        if messagebox.askyesno("Disconnect Folder", f"Disconnect this folder from Nanvi?\n\n{p}"):
                            self.agent.remove_folder(p)
                            threading.Thread(target=self.agent.send_heartbeat, daemon=True).start()
                    return do_remove

                rm_btn = tk.Button(
                    card,
                    text="Disconnect",
                    font=("Segoe UI", 9),
                    fg="#dc2626",
                    bg="#fee2e2",
                    activebackground="#fca5a5",
                    relief="flat",
                    padx=10,
                    pady=3,
                    cursor="hand2",
                    command=make_remove(path_str),
                )
                rm_btn.pack(side="right", padx=(10, 0))

        try:
            self.root.after(0, update)
        except Exception:
            pass

    def _on_close(self) -> None:
        self.agent.stop()
        _cleanup_pid_file()
        self.root.destroy()

    def run(self) -> None:
        try:
            self.root.mainloop()
        finally:
            self.agent.stop()
            _cleanup_pid_file()


def main() -> None:
    parser = argparse.ArgumentParser(description="Nanvi Local Connector GUI")
    parser.add_argument("--server", default=None, help="Nanvi Server URL")
    parser.add_argument("--token", default=None, help="Agent authentication token")
    parser.add_argument("--folder", default=None, help="Initial folder path to approve")
    parser.add_argument("--replace-folders", action="store_true", help="Replace previously approved folders")
    args = parser.parse_args()

    _replace_previous_instance()

    config_data: dict[str, Any] = {}
    config_file = LOCAL_CONFIG_FILE if LOCAL_CONFIG_FILE.exists() else CONFIG_FILE
    if config_file.exists():
        try:
            config_data = json.loads(config_file.read_text(encoding="utf-8"))
        except Exception:
            pass

    server_url = args.server or os.environ.get("NANVI_SERVER_URL") or config_data.get("server_url") or "http://127.0.0.1:8000"
    token = args.token or os.environ.get("NANVI_AGENT_TOKEN") or config_data.get("token") or "nanvi-local-token"

    agent = NanviLocalAgent(server_url=server_url, token=token, config_path=config_file)
    if args.server or args.token:
        agent._save_config()

    if args.folder:
        try:
            if args.replace_folders:
                agent.set_single_folder(args.folder)
            else:
                agent.add_folder(args.folder)
        except Exception as exc:
            logger.warning("Could not add startup folder %s: %s", args.folder, exc)

    app = NanviAgentWindow(agent)
    app.run()


if __name__ == "__main__":
    main()

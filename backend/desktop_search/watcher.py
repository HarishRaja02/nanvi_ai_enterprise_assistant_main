from __future__ import annotations

import logging
from pathlib import Path
import threading
from typing import Callable

from watchfiles import Change, DefaultFilter, watch

from .parsers import SUPPORTED_EXTENSIONS
from .security import IGNORED_DIR_NAMES, is_blocked_system_path

logger = logging.getLogger(__name__)


class WorkspaceFileWatcher:
    """Rust ReadDirectoryChangesW recursive watcher with 500ms debounce."""

    def __init__(
        self,
        root_path: Path,
        on_events: Callable[[list[tuple[str, Path]]], None],
        *,
        local_data_dir: Path | None = None,
        debounce_ms: int = 500,
    ) -> None:
        self.root_path = Path(root_path).resolve()
        self.on_events = on_events
        self.local_data_dir = local_data_dir
        self.debounce_ms = debounce_ms
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self.active = False

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run,
            name=f"nanvi-watcher-{self.root_path.name[:16]}",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout_s: float = 3.0) -> None:
        self._stop_event.set()
        self.active = False
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=timeout_s)
        self._thread = None

    def _should_watch(self, change: Change, raw_path: str) -> bool:
        p = Path(raw_path)
        name = p.name.casefold()
        if not name or name.startswith("~$") or name.endswith((".tmp", ".crdownload", ".part")):
            return False
        if any(part.casefold() in IGNORED_DIR_NAMES for part in p.parts):
            return False
        if change != Change.deleted and p.suffix and p.suffix.casefold() not in SUPPORTED_EXTENSIONS:
            return False
        if is_blocked_system_path(p, local_data_dir=self.local_data_dir, scan_root=self.root_path):
            return False
        return True

    def _run(self) -> None:
        self.active = True
        watch_filter = DefaultFilter(ignore_dirs=tuple(IGNORED_DIR_NAMES))
        try:
            for changes in watch(
                str(self.root_path),
                watch_filter=watch_filter,
                debounce=self.debounce_ms,
                stop_event=self._stop_event,
                recursive=True,
                ignore_permission_denied=True,
            ):
                if self._stop_event.is_set():
                    break
                filtered: list[tuple[str, Path]] = []
                for change, raw_path in changes:
                    if not self._should_watch(change, raw_path):
                        continue
                    kind = (
                        "deleted"
                        if change == Change.deleted
                        else ("added" if change == Change.added else "modified")
                    )
                    filtered.append((kind, Path(raw_path)))
                if filtered:
                    try:
                        self.on_events(filtered)
                    except Exception as exc:
                        logger.warning("Watcher callback failed: %s", exc)
        except Exception as exc:
            logger.warning("Workspace watcher stopped with error: %s", exc)
        finally:
            self.active = False

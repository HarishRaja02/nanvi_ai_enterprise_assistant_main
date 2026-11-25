from __future__ import annotations

from contextlib import contextmanager
import ctypes
import logging
import os
from pathlib import Path
import shutil
import threading
import time
from typing import Iterator

import psutil

from .models import ResourceProfile

logger = logging.getLogger(__name__)

BELOW_NORMAL_PRIORITY_CLASS = 0x00004000


def detect_hardware_profile(override_tier: str | None = None) -> ResourceProfile:
    """Detect RAM and CPU cores and return bounded desktop resource ceilings."""
    mem = psutil.virtual_memory()
    total_gb = round(mem.total / (1024**3), 2)
    cpu_cores = os.cpu_count() or 4

    tier = (override_tier or "").strip().casefold()
    if not tier:
        if total_gb <= 10.5:
            tier = "constrained_8gb"
        elif total_gb <= 20.0:
            tier = "balanced_16gb"
        else:
            tier = "high_32gb"

    if tier == "constrained_8gb":
        return ResourceProfile(
            tier="constrained_8gb",
            total_ram_gb=total_gb,
            parse_workers=2,
            embed_workers=1,
            onnx_threads=max(1, min(2, cpu_cores // 2)),
            embed_batch_size=8,
            ram_budget_mb=420,
            disk_free_floor_mb=1024,
            max_pending_jobs=500,
            tantivy_heap_bytes=16 * 1024 * 1024,
            hnsw_m=16,
            hnsw_ef_construction=100,
            hnsw_ef_search=40,
            max_single_file_mb=128,
        )

    if tier == "high_32gb":
        return ResourceProfile(
            tier="high_32gb",
            total_ram_gb=total_gb,
            parse_workers=min(6, max(2, cpu_cores // 2)),
            embed_workers=1,
            onnx_threads=min(4, max(2, cpu_cores // 2)),
            embed_batch_size=32,
            ram_budget_mb=1024,
            disk_free_floor_mb=2048,
            max_pending_jobs=4000,
            tantivy_heap_bytes=48 * 1024 * 1024,
            hnsw_m=24,
            hnsw_ef_construction=160,
            hnsw_ef_search=64,
            max_single_file_mb=512,
        )

    return ResourceProfile(
        tier="balanced_16gb",
        total_ram_gb=total_gb,
        parse_workers=min(4, max(2, cpu_cores // 2)),
        embed_workers=1,
        onnx_threads=min(3, max(1, cpu_cores // 2)),
        embed_batch_size=16,
        ram_budget_mb=650,
        disk_free_floor_mb=1536,
        max_pending_jobs=2000,
        tantivy_heap_bytes=32 * 1024 * 1024,
        hnsw_m=16,
        hnsw_ef_construction=120,
        hnsw_ef_search=48,
        max_single_file_mb=256,
    )


def apply_background_priority() -> bool:
    """Lower sidecar OS scheduling priority on Windows so foreground apps never stutter."""
    if os.name != "nt":
        return False
    try:
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        return bool(ctypes.windll.kernel32.SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS))
    except Exception:
        return False


class ResourceGovernor:
    """Enforces RAM, disk free space, backpressure, and search preemption."""

    def __init__(self, index_dir: Path, profile: ResourceProfile | None = None) -> None:
        self.index_dir = Path(index_dir)
        self.profile = profile or detect_hardware_profile()
        self._proc = psutil.Process(os.getpid())
        self._lock = threading.Lock()
        self._active_searches = 0
        self._manual_pause_reason: str | None = None

    def current_rss_mb(self) -> float:
        try:
            return round(self._proc.memory_info().rss / (1024 * 1024), 2)
        except Exception:
            return 0.0

    def disk_free_mb(self) -> float:
        try:
            target = self.index_dir if self.index_dir.exists() else self.index_dir.parent
            usage = shutil.disk_usage(str(target))
            return round(usage.free / (1024 * 1024), 2)
        except Exception:
            return 10000.0

    @contextmanager
    def search_priority_scope(self) -> Iterator[None]:
        """Signal background workers to yield immediately during an active user query."""
        with self._lock:
            self._active_searches += 1
        try:
            yield
        finally:
            with self._lock:
                self._active_searches = max(0, self._active_searches - 1)

    def is_search_active(self) -> bool:
        with self._lock:
            return self._active_searches > 0

    def check_indexing_allowed(self) -> tuple[bool, str | None]:
        """Return (allowed, paused_reason) under current memory/disk/search load."""
        if self._manual_pause_reason:
            return False, self._manual_pause_reason

        if self.is_search_active():
            return False, "preempted_for_active_search"

        rss_mb = self.current_rss_mb()
        if rss_mb > self.profile.ram_budget_mb * 1.15:
            return False, f"ram_budget_exceeded ({rss_mb:.0f} MB > {self.profile.ram_budget_mb} MB)"

        free_mb = self.disk_free_mb()
        if free_mb < self.profile.disk_free_floor_mb:
            return False, f"low_disk_space ({free_mb:.0f} MB < {self.profile.disk_free_floor_mb} MB)"

        return True, None

    def set_manual_pause(self, reason: str | None) -> None:
        self._manual_pause_reason = reason

    def wait_if_preempted(self, timeout_s: float = 0.25) -> None:
        """Yield briefly when an interactive search is running."""
        if self.is_search_active():
            time.sleep(timeout_s)


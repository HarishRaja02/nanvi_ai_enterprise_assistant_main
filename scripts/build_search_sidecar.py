"""Build frozen Windows x64 PyInstaller bundle for Nanvi Desktop Search Sidecar."""
from __future__ import annotations

from pathlib import Path
import shutil
import sys

import PyInstaller.__main__

REPO_ROOT = Path(__file__).resolve().parent.parent
TARGET_DIR = REPO_ROOT / "frontend" / "resources" / "search-sidecar"
DIST_ROOT = REPO_ROOT / "build_sidecar" / "dist"
WORK_ROOT = REPO_ROOT / "build_sidecar" / "work"


def prune_msix_incompatible_files(bundle_dir: Path) -> int:
    """Remove OPC template conflicts and MakeAppx-disallowed filenames from frozen bundle."""
    removed = 0
    internal = bundle_dir / "_internal"
    if not internal.exists():
        return 0
    for template_dir in (
        internal / "docx" / "templates",
        internal / "pptx" / "templates",
        internal / "onnxruntime" / "tools",
        internal / "pymupdf" / "layout",
        internal / "pymupdf" / "mupdf-devel",
    ):
        if template_dir.exists():
            shutil.rmtree(template_dir, ignore_errors=True)
            removed += 1
    for p in list(internal.rglob("*")):
        if not p.is_file():
            continue
        name = p.name
        if (
            "+" in name
            or "[" in name
            or "]" in name
            or name.endswith(".rels")
            or p.parent.name == "_rels"
            or name.lower().startswith("opencv_videoio_ffmpeg")
        ):
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def build_sidecar() -> Path:
    entry = REPO_ROOT / "scripts" / "sidecar_entry.py"
    if not entry.exists():
        raise FileNotFoundError(f"Sidecar entrypoint missing: {entry}")

    if DIST_ROOT.exists():
        shutil.rmtree(DIST_ROOT, ignore_errors=True)
    if WORK_ROOT.exists():
        shutil.rmtree(WORK_ROOT, ignore_errors=True)

    args = [
        str(entry),
        "--name",
        "nanvi-search-sidecar",
        "--onedir",
        "--console",
        "--noconfirm",
        "--clean",
        "--distpath",
        str(DIST_ROOT),
        "--workpath",
        str(WORK_ROOT),
        "--specpath",
        str(WORK_ROOT),
        "--paths",
        str(REPO_ROOT),
        "--collect-all",
        "tantivy",
        "--collect-all",
        "hnswlib",
        "--collect-all",
        "fastembed",
        "--collect-all",
        "tokenizers",
        "--collect-all",
        "onnxruntime",
        "--collect-all",
        "watchfiles",
        "--collect-all",
        "cryptography",
        "--collect-submodules",
        "backend",
        "--collect-submodules",
        "uvicorn",
        "--collect-submodules",
        "fastapi",
        "--collect-submodules",
        "pydantic",
        "--collect-submodules",
        "rapidfuzz",
        "--collect-submodules",
        "pypdf",
        "--collect-submodules",
        "openpyxl",
        "--collect-all",
        "docx",
        "--collect-all",
        "rapidocr_onnxruntime",
        "--collect-submodules",
        "pymupdf",
        "--collect-data",
        "pymupdf",
        "--collect-binaries",
        "pymupdf",
        "--collect-submodules",
        "cv2",
        "--collect-binaries",
        "cv2",
        "--collect-submodules",
        "pptx",
        "--exclude-module",
        "pymupdf.layout",
        "--exclude-module",
        "pymupdf_layout",
        "--exclude-module",
        "pyarrow",
        "--exclude-module",
        "pandas",
        "--exclude-module",
        "streamlit",
        "--exclude-module",
        "matplotlib",
        "--exclude-module",
        "scipy",
        "--exclude-module",
        "tkinter",
        "--exclude-module",
        "PyQt5",
        "--exclude-module",
        "PySide6",
        "--exclude-module",
        "pytest",
        "--exclude-module",
        "_pytest",
    ]
    PyInstaller.__main__.run(args)

    built_dir = DIST_ROOT / "nanvi-search-sidecar"
    exe_path = built_dir / "nanvi-search-sidecar.exe"
    if not exe_path.exists():
        raise RuntimeError(f"Expected PyInstaller output not found: {exe_path}")

    if TARGET_DIR.exists():
        shutil.rmtree(TARGET_DIR, ignore_errors=True)
    TARGET_DIR.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(built_dir, TARGET_DIR)
    pruned = prune_msix_incompatible_files(TARGET_DIR)
    print(f"Packaged desktop search sidecar into: {TARGET_DIR} (pruned {pruned} MSIX-incompatible entries)")
    return TARGET_DIR / "nanvi-search-sidecar.exe"


if __name__ == "__main__":
    out_exe = build_sidecar()
    print(f"Executable: {out_exe} ({out_exe.stat().st_size / (1024 * 1024):.2f} MB)")


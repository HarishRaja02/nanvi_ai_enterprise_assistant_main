"""PyInstaller frozen launcher entrypoint for Nanvi Desktop Search Sidecar."""
from __future__ import annotations

from backend.desktop_search.sidecar import main

if __name__ == "__main__":
    raise SystemExit(main())


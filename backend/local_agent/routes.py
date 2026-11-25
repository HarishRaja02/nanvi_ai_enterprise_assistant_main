"""FastAPI router for Nanvi Local File Agent endpoints."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse

from pydantic import BaseModel

from backend.core.config import settings
from backend.security.dependencies import get_current_user, get_optional_current_user
from backend.security.models import UserIdentity
from .models import (
    AddFolderRequest,
    FolderSyncPayload,
    LocalAgentHeartbeat,
    LocalAgentStatusResponse,
    LocalAgentTokenResponse,
    LocalSearchRequest,
    LocalSearchResponse,
)
from .service import LocalAgentService, get_local_agent_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/local-agent", tags=["local-agent"])


def _extract_agent_identity(
    authorization: Annotated[str | None, Header()] = None,
    service: LocalAgentService = Depends(get_local_agent_service),
) -> tuple[str, str]:
    """Authenticate incoming local agent requests using bearer pairing token."""
    import os
    is_strict = settings.is_production or bool(os.getenv("VERCEL"))
    if not authorization or not authorization.startswith("Bearer "):
        if not is_strict:
            return "enterprise-tenant", "default"
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header. Expected 'Bearer <pairing_token>'",
        )
    token = authorization.split(" ", 1)[1].strip()
    if not is_strict and token in ("default", "local", "demo", "nanvi-local-token"):
        return "enterprise-tenant", "default"
    try:
        payload = service.verify_agent_token(token)
        tenant_id = payload.get("tenant_id", "enterprise-tenant")
        user_id = payload.get("sub", "default")
        return tenant_id, user_id
    except Exception as exc:
        if not is_strict:
            return "enterprise-tenant", "default"
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid pairing token: {exc}",
        )


# ---------------------------------------------------------------------------
# User Endpoints (Accessed from Frontend Web App)
# ---------------------------------------------------------------------------

def _get_user_id(user: UserIdentity) -> str:
    return str(getattr(user, "subject", None) or getattr(user, "user_id", "default"))


class OpenFileRequest(BaseModel):
    file_path: str


def _allowed_document_roots(
    tenant_id: str, service: LocalAgentService, user_id: str = "default"
) -> list[Path]:
    """Return authorized, non-system directories from which this user's documents may be served."""
    import os
    import tempfile

    roots: list[Path] = []
    candidates: list[Path] = [
        Path(__file__).resolve().parents[1] / "storage" / "uploads",
        Path(tempfile.gettempdir()) / "nanvi_uploads",
    ]
    if not settings.is_production and not os.getenv("VERCEL"):
        candidates.append(Path(__file__).resolve().parents[1] / "CompanyData")

    if user_id == "default":
        try:
            from backend.integrations.files.company_data.persistence import get_persisted_folder
            p_cand = get_persisted_folder(tenant_id)
            if p_cand:
                candidates.append(p_cand)
        except Exception:
            pass

    try:
        user_entry = service.store._load_key(tenant_id, user_id)
        for f_info in user_entry.get("folders", {}).values():
            fp = f_info.get("folder_path")
            if fp:
                candidates.append(Path(fp))
    except Exception:
        pass

    seen: set[Path] = set()
    for cand in candidates:
        try:
            res = cand.resolve()
            norm = str(res).replace("\\", "/").lower()
            if "/var/task" in norm or "var/task" in norm:
                continue
            if res.exists() and res.is_dir() and res not in seen:
                seen.add(res)
                roots.append(res)
        except Exception:
            continue
    return roots


def _is_within_roots(candidate: Path, roots: list[Path]) -> bool:
    try:
        resolved = candidate.resolve()
    except Exception:
        return False
    for r in roots:
        try:
            if resolved.is_relative_to(r):
                return True
        except Exception:
            continue
    return False


@router.post("/open-file")
async def local_agent_open_file(
    body: OpenFileRequest,
    user: UserIdentity = Depends(get_current_user),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> dict[str, Any]:
    """Queue an open_file command to the user's connected Windows PC agent, or open directly if running on local machine."""
    raw_path = body.file_path.strip()
    if not raw_path or "\x00" in raw_path or ".." in raw_path.replace("\\", "/").split("/"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid file path")
    if raw_path.startswith("file:///"):
        raw_path = raw_path[8:]

    from pathlib import Path
    import os

    t_id = getattr(user, "tenant_id", None) or "enterprise-tenant"
    u_id = _get_user_id(user)

    clean_req = raw_path.replace("\\", "/").strip("/")
    if clean_req.lower().startswith("browserfolder/"):
        clean_req = clean_req[len("browserfolder/"):].strip("/")

    # 1. Resolve real path on local disk (supporting relative paths from connected folders too)
    allowed_roots = _allowed_document_roots(t_id, service, u_id)
    candidate_paths: list[Path] = [Path(raw_path)]
    if clean_req:
        for r in allowed_roots:
            candidate_paths.append(r / clean_req)
            if "/" in clean_req and clean_req.split("/", 1)[0].lower() == r.name.lower():
                candidate_paths.append(r / clean_req.split("/", 1)[1])

    for cand in candidate_paths:
        try:
            if hasattr(os, "startfile") and cand.exists() and cand.is_file() and _is_within_roots(cand, allowed_roots):
                os.startfile(str(cand.resolve()))
                return {
                    "status": "ok",
                    "opened": str(cand.resolve()),
                    "message": f"Opened {cand.name} on your computer",
                    "local": True,
                    "desktop_agent_online": True,
                }
        except Exception as exc:
            logger.warning("os.startfile failed on local machine: %s", exc)

    # 2. Check whether a real Windows Desktop Connector (non-browser agent) is online
    agent_status = service.store.get_agent_status(t_id, u_id)
    agent_ver = str(agent_status.get("agent_version") or "").lower()
    desktop_online = bool(agent_status.get("is_online")) and not agent_ver.startswith("browser-")

    # Resolve any stored real folder path on the user's PC if they linked a Windows folder path
    resolved_remote_path = raw_path
    for f in agent_status.get("connected_folders", []):
        fp = str(getattr(f, "folder_path", "") or "").strip()
        dn = str(getattr(f, "display_name", "") or "").strip()
        if fp and (":" in fp or fp.startswith("\\\\")):
            rel_part = clean_req
            if dn and clean_req.lower().startswith(dn.lower() + "/"):
                rel_part = clean_req[len(dn) + 1:]
            if "/" in clean_req and ":" not in clean_req:
                resolved_remote_path = f"{fp.rstrip('/\\')}\\{rel_part.replace('/', '\\')}"
                break

    if not desktop_online:
        return {
            "status": "browser_only",
            "opened": clean_req or raw_path,
            "message": f"Opening {Path(raw_path).name} directly in browser viewer...",
            "queued": False,
            "local": False,
            "desktop_agent_online": False,
        }

    # 3. Queue open_file command strictly when this user's Windows PC Desktop Connector is active
    cmd_id = service.queue_command(t_id, u_id, "open_file", {"file_path": resolved_remote_path})
    return {
        "status": "ok",
        "opened": resolved_remote_path,
        "message": f"Opening {Path(resolved_remote_path).name} on your connected Windows computer...",
        "queued": True,
        "desktop_agent_online": True,
        "command_id": cmd_id,
    }


def _launch_native_windows_folder_dialog(title: str = "Select Company Folder for Nanvi Assistant") -> str | None:
    """Launch the native Windows Explorer folder selection dialog directly on this computer."""
    import sys
    from pathlib import Path

    if sys.platform != "win32":
        return None

    # 1. Try Tkinter filedialog (built-in, lightweight)
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        selected = filedialog.askdirectory(title=title)
        root.destroy()
        if selected and Path(selected).exists():
            return str(Path(selected).resolve())
    except Exception as tk_exc:
        logger.debug("Tkinter folder picker could not open: %s", tk_exc)

    # 2. Try PowerShell FolderBrowserDialog
    try:
        import subprocess
        ps_code = f"""
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '{title}'
$dlg.ShowNewFolderButton = $true
$res = $dlg.ShowDialog()
if ($res -eq [System.Windows.Forms.DialogResult]::OK) {{
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $dlg.SelectedPath
}}
"""
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_code],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if proc.returncode == 0:
            out = proc.stdout.strip()
            if out and Path(out).exists():
                return str(Path(out).resolve())
    except Exception as ps_exc:
        logger.debug("PowerShell folder picker error: %s", ps_exc)

    return None


@router.post("/browse-folder")
async def local_agent_browse_folder(
    user: UserIdentity = Depends(get_current_user),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> dict[str, Any]:
    """Trigger the native Windows folder picker dialog on the host PC or connected agent."""
    import sys
    import asyncio

    t_id = getattr(user, "tenant_id", None) or "enterprise-tenant"
    u_id = _get_user_id(user)

    # If backend is running locally on Windows, open native Windows Explorer dialog directly
    if sys.platform == "win32":
        loop = asyncio.get_running_loop()
        selected_path = await loop.run_in_executor(None, _launch_native_windows_folder_dialog)
        if selected_path:
            res = service.request_folder(t_id, u_id, selected_path)
            return {
                "status": "ok",
                "folder_path": selected_path,
                "message": res.get("message") or f"✓ Folder '{selected_path}' linked to Nanvi Assistant.",
                "direct": True,
            }
        else:
            return {
                "status": "canceled",
                "message": "Folder selection was canceled or no folder was chosen.",
            }

    # Remote agent fallback: queue command for connected PC agent
    cmd_id = service.queue_command(t_id, u_id, "browse_folder", {})
    if u_id != "default":
        try:
            service.queue_command(t_id, "default", "browse_folder", {})
        except Exception:
            pass
    return {
        "status": "ok",
        "message": "Opening folder picker on your Windows PC...",
        "queued": True,
        "command_id": cmd_id,
    }


@router.get("/document-content")
def get_document_content(
    path: str = Query(..., description="File path or relative path to view"),
    download: bool = Query(False, description="Whether to download original file binary"),
    user: UserIdentity = Depends(get_current_user),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> Response:
    """Serve the document for ephemeral in-memory browser preview (PDF, HTML preview, images) or download."""
    from pathlib import Path
    import mimetypes
    from backend.integrations.files.company_data.extraction import create_default_document_service
    from backend.documents.preview_renderer import render_document_to_html
    from backend.documents.parsers.common import source_for, metadata_for
    from backend.documents.models import Document

    raw = path.strip()
    if not raw or "\x00" in raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid document path")
    if raw.startswith("file:///"):
        raw = raw[8:]

    clean = raw.replace("\\", "/").strip("/")
    parts = clean.split("/")
    if any(p == ".." for p in parts):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid document path")
    filename = parts[-1] if parts else clean

    # Strip drive letter and common prefixes like 'CompanyData'
    clean_parts = [p for p in parts if p and not p.endswith(":") and p.lower() != "companydata"]
    rel_path = "/".join(clean_parts)

    t_id = getattr(user, "tenant_id", None) or "enterprise-tenant"
    u_id = _get_user_id(user)
    search_roots = _allowed_document_roots(t_id, service, u_id)

    target_file: Path | None = None
    try:
        direct = Path(raw).resolve()
        if direct.is_file() and _is_within_roots(direct, search_roots):
            target_file = direct
    except Exception:
        pass

    if not target_file:
        for r in search_roots:
            for candidate_rel in (rel_path, filename):
                if not candidate_rel:
                    continue
                try:
                    cand = (r / candidate_rel).resolve()
                    if cand.is_relative_to(r) and cand.is_file():
                        target_file = cand
                        break
                except Exception:
                    continue
            if target_file:
                break

    if target_file and target_file.is_file():
        suffix = target_file.suffix.lower()
        media_type = mimetypes.guess_type(target_file.name)[0]

        # 1. If explicit download requested, return original file attachment
        if download:
            return Response(
                content=target_file.read_bytes(),
                media_type=media_type or "application/octet-stream",
                headers={
                    "Content-Disposition": f'attachment; filename="{target_file.name}"',
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                },
            )

        # 2. Ephemeral In-Memory Preview in Browser
        # Native PDF preview
        if suffix == ".pdf":
            return Response(
                content=target_file.read_bytes(),
                media_type="application/pdf",
                headers={
                    "Content-Disposition": f'inline; filename="{target_file.name}"',
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                },
            )

        # Native Image preview
        if suffix in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"):
            return Response(
                content=target_file.read_bytes(),
                media_type=media_type or "image/png",
                headers={
                    "Content-Disposition": f'inline; filename="{target_file.name}"',
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                },
            )

        # Native Video preview
        if suffix in (".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".ogg"):
            return Response(
                content=target_file.read_bytes(),
                media_type=media_type or "video/mp4",
                headers={
                    "Content-Disposition": f'inline; filename="{target_file.name}"',
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Accept-Ranges": "bytes",
                },
            )

        # Raw HTML
        if suffix in (".html", ".htm"):
            return FileResponse(
                path=str(target_file),
                media_type="text/html; charset=utf-8",
                headers={
                    "Content-Disposition": f'inline; filename="{target_file.name}"',
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                },
            )

        # Rich In-Memory Preview for Word, Excel, CSV, TSV, PPT, Text, JSON, XML, RTF
        try:
            doc_service = create_default_document_service()
            file_bytes = target_file.read_bytes()
            doc_model = doc_service.parse_bytes(
                filename=target_file.name,
                relative_path=rel_path or target_file.name,
                data=file_bytes,
            )
            html_preview = render_document_to_html(doc_model)
            return Response(
                content=html_preview,
                media_type="text/html; charset=utf-8",
                headers={
                    "Content-Disposition": f'inline; filename="{target_file.name}.html"',
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                },
            )
        except Exception as parse_err:
            logger.debug("Could not render HTML preview for %s (%s), falling back to raw", target_file.name, parse_err)

        if suffix in (".txt", ".log", ".csv", ".json", ".md", ".py"):
            media_type = media_type or "text/plain; charset=utf-8"
        else:
            media_type = media_type or "application/octet-stream"

        return FileResponse(
            path=str(target_file),
            media_type=media_type,
            headers={
                "Content-Disposition": f'inline; filename="{target_file.name}"',
                "Cache-Control": "no-cache, no-store, must-revalidate",
            },
        )

    # If file is not directly present on disk, check indexed chunks strictly for this user
    try:
        import html
        u_val = service.store._load_key(t_id, u_id)
        all_chunks: list[dict[str, Any]] = list(u_val.get("chunks", []))

        req_norm = clean.replace("\\", "/").strip("/")
        if req_norm.lower().startswith("browserfolder/"):
            req_norm = req_norm[len("browserfolder/"):].strip("/")
        req_low = req_norm.lower()
        fn_low = filename.lower()

        def _chunk_matches_exact_path(c: dict[str, Any]) -> bool:
            c_rel = str(c.get("relative_path") or "").replace("\\", "/").strip("/").lower()
            if not c_rel:
                return False
            c_folder = str(c.get("folder_name") or "").replace("\\", "/").strip("/").lower()
            c_fpath = str(c.get("folder_path") or "").replace("\\", "/").strip("/").lower()
            if c_fpath.startswith("browserfolder/"):
                c_fpath = c_fpath[len("browserfolder/"):].strip("/")
            full_disp = f"{c_folder}/{c_rel}".strip("/") if c_folder and not c_rel.startswith(c_folder + "/") else c_rel
            full_fp = f"{c_fpath}/{c_rel}".strip("/") if c_fpath else c_rel
            return (
                req_low in (c_rel, full_disp, full_fp)
                or req_low.endswith("/" + c_rel)
                or (len(req_low) > len(fn_low) and c_rel.endswith("/" + req_low))
            )

        exact_matches = [c for c in all_chunks if _chunk_matches_exact_path(c)]
        if not exact_matches:
            exact_matches = [c for c in all_chunks if str(c.get("filename") or "").lower() == fn_low]

        # Isolate chunks to ONLY one distinct file so identically-named files in other folders never mix
        matching = []
        if exact_matches:
            target_rel = str(exact_matches[0].get("relative_path") or "").replace("\\", "/").lower()
            target_fid = str(exact_matches[0].get("folder_id") or "").lower()
            matching = [
                c for c in exact_matches
                if str(c.get("relative_path") or "").replace("\\", "/").lower() == target_rel
                and str(c.get("folder_id") or "").lower() == target_fid
            ]

        if matching:
            matching.sort(key=lambda c: c.get("chunk_index", 0))
            joined_text = "\n\n".join(c.get("text", "") for c in matching)
            file_ext = filename.split(".")[-1].lower() if "." in filename else "txt"

            if download:
                return Response(
                    content=joined_text.encode("utf-8"),
                    media_type="text/csv" if file_ext == "csv" else "text/plain; charset=utf-8",
                    headers={
                        "Content-Disposition": f'attachment; filename="{filename}"',
                        "Cache-Control": "no-cache, no-store, must-revalidate",
                    },
                )

            try:
                doc_model = Document(
                    source=source_for(filename, rel_path or filename, file_ext),
                    metadata=metadata_for(len(joined_text)),
                    text=joined_text,
                )
                html_preview = render_document_to_html(doc_model)
                return Response(
                    content=html_preview,
                    media_type="text/html; charset=utf-8",
                    headers={
                        "Content-Disposition": f'inline; filename="{filename}.html"',
                        "Cache-Control": "no-cache, no-store, must-revalidate",
                    },
                )
            except Exception:
                return Response(
                    content=joined_text,
                    media_type="text/plain; charset=utf-8",
                    headers={
                        "Content-Disposition": f'inline; filename="{filename}.txt"',
                        "Cache-Control": "no-cache, no-store, must-revalidate",
                    },
                )
    except Exception as exc:
        logger.debug("Could not read chunks for document-content: %s", exc)

    # 5. Clean, informative fallback card if content is exclusively on user's PC (200 OK, never 404)
    import html
    fallback_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{html.escape(filename)} - Nanvi AI</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; padding: 36px 20px; color: #0f172a; display: flex; justify-content: center; }}
    .card {{ background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 12px; max-width: 640px; width: 100%; padding: 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }}
    .badge {{ display: inline-flex; align-items: center; gap: 6px; background: #ecfdf5; border: 1px solid #86efac; color: #166534; padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 12px; margin-bottom: 16px; }}
    h2 {{ font-size: 20px; color: #0f172a; margin-bottom: 12px; font-weight: 700; }}
    .path-box {{ background: #f1f5f9; border: 1px solid #cbd5e1; padding: 10px 14px; border-radius: 6px; font-size: 13px; color: #0369a1; word-break: break-all; font-family: monospace; margin: 12px 0 20px; }}
    p {{ color: #475569; font-size: 14.5px; line-height: 1.6; margin-bottom: 14px; }}
    .note {{ background: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px 16px; border-radius: 4px; font-size: 13.5px; color: #1e40af; margin-top: 18px; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">
      <span style="width:7px;height:7px;border-radius:50%;background:#16a34a;display:inline-block"></span>
      Windows PC Local File
    </div>
    <h2>📄 {html.escape(filename)}</h2>
    <p>This file is stored on your connected Windows computer:</p>
    <div class="path-box">{html.escape(path)}</div>
    <p>To inspect or edit the original document, use <strong>Open in Desktop App</strong> to open it directly in your native Windows application (Excel, Notepad, or Acrobat).</p>
    <div class="note">
      💡 <strong>Tip:</strong> The exact file path has also been automatically copied to your Windows clipboard.
    </div>
  </div>
</body>
</html>"""
    return Response(content=fallback_html, media_type="text/html; charset=utf-8")


@router.get("/document-download")
def download_document_endpoint(
    path: str = Query(..., description="File path to download"),
    user: UserIdentity = Depends(get_current_user),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> Response:
    """Download the original document binary file."""
    return get_document_content(path=path, download=True, user=user, service=service)


@router.get("/download")
@router.get("/download")
async def download_agent_package(
    request: Request,
    token: str | None = None,
    format: str = "exe",
    user: UserIdentity | None = Depends(get_optional_current_user),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> Response:
    """Download the Nanvi AI Windows Desktop installer (.exe)."""
    if format == "bat":
        raise HTTPException(
            status_code=410,
            detail="The legacy .bat connector option has been removed. Please install the Nanvi Desktop App or connect folders directly in your browser.",
        )

    import os
    from pathlib import Path
    from starlette.responses import FileResponse, RedirectResponse

    if format == "zip":
        from .packager import generate_agent_zip
        from backend.security.authorization.rbac import Role

        proto = request.headers.get("x-forwarded-proto", request.url.scheme)
        host = request.headers.get("x-forwarded-host", request.url.netloc)
        server_url = f"{proto}://{host}".rstrip("/") if host else str(request.base_url).rstrip("/")
        pairing_token = ""
        display_name = ""
        if user:
            resp = service.create_pairing_token(user, server_url)
            pairing_token = resp.token
            display_name = resp.display_name
        elif token:
            try:
                payload = service.verify_agent_token(token)
                pairing_token = token
                display_name = payload.get("display_name", "")
            except Exception:
                pairing_token = "nanvi-local-token"
                display_name = "Company User"
        else:
            default_user = UserIdentity(
                subject="default",
                issuer="nanvi",
                tenant_id="enterprise-tenant",
                roles=frozenset({Role.IT_ADMIN}),
                email="user@company.local",
                name="Company User",
            )
            try:
                resp = service.create_pairing_token(default_user, server_url)
                pairing_token = resp.token
                display_name = "Company User"
            except Exception:
                pairing_token = "nanvi-local-token"
                display_name = "Company User"

        zip_bytes = generate_agent_zip(server_url, pairing_token, display_name)
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="Nanvi_Windows_Agent.zip"',
                "Cache-Control": "no-store",
            },
        )

    desktop_download_url = os.environ.get("DESKTOP_DOWNLOAD_URL", "").strip()
    if not desktop_download_url and (os.environ.get("VERCEL") or settings.is_production):
        desktop_download_url = "https://github.com/HarishRaja02/nanvi_ai_enterprise_assistant/releases/download/v0.1.2/Nanvi.AI.Assistant-Setup-0.1.2.exe"

    repo_root = Path(__file__).resolve().parents[2]
    candidate_exes = [
        repo_root / "frontend" / "release" / "Nanvi AI Assistant-Setup-0.1.2.exe",
        Path(__file__).resolve().parents[1] / "frontend" / "release" / "Nanvi AI Assistant-Setup-0.1.2.exe",
        Path.cwd() / "frontend" / "release" / "Nanvi AI Assistant-Setup-0.1.2.exe",
        repo_root / "frontend" / "release" / "Nanvi AI Assistant-Setup-0.1.1.exe",
        repo_root / "frontend" / "release" / "Nanvi AI Assistant-Setup-0.1.0.exe",
        repo_root / "frontend" / "release" / "win-unpacked" / "Nanvi AI Assistant.exe",
    ]
    for exe_path in candidate_exes:
        if exe_path.exists() and exe_path.is_file():
            dl_name = exe_path.name
            return FileResponse(
                path=str(exe_path),
                media_type="application/vnd.microsoft.portable-executable",
                filename=dl_name,
                headers={
                    "Content-Disposition": f'attachment; filename="{dl_name}"',
                    "Cache-Control": "public, max-age=3600",
                },
            )

    if desktop_download_url:
        return RedirectResponse(url=desktop_download_url, status_code=302)

    raise HTTPException(
        status_code=404,
        detail="Windows Desktop Installer (.exe) not found on server.",
    )


@router.post("/token", response_model=LocalAgentTokenResponse)
async def generate_pairing_token(
    request: Request,
    user: UserIdentity = Depends(get_current_user),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> LocalAgentTokenResponse:
    """Generate a pairing token for the user to authenticate their local agent."""
    server_url = str(request.base_url).rstrip("/")
    return service.create_pairing_token(user, server_url)


@router.get("/status", response_model=LocalAgentStatusResponse)
async def get_agent_status(
    request: Request,
    user: UserIdentity = Depends(get_current_user),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> LocalAgentStatusResponse:
    """Get the current live status, folder list, and file counts for the user's agent."""
    server_url = str(request.base_url).rstrip("/")
    tenant_id = getattr(user, "tenant_id", None) or "default"
    user_id = _get_user_id(user)
    return service.get_status(tenant_id, user_id, server_url)


def _require_folder_management_access(user: UserIdentity) -> None:
    """Ensure basic Tier 5 (Intern) accounts cannot connect or disconnect local folders."""
    from backend.security.authorization.rbac import Role

    if user.roles and not (user.roles - {Role.INTERN}):
        raise HTTPException(
            status_code=403,
            detail="Intern / Trainee accounts cannot connect or manage local folders.",
        )


@router.post("/folders")
async def add_local_folder(
    body: AddFolderRequest,
    user: UserIdentity = Depends(get_current_user),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> dict[str, Any]:
    """Request a local folder path to be approved and indexed by the local agent."""
    _require_folder_management_access(user)
    if not body.folder_path or not body.folder_path.strip():
        raise HTTPException(status_code=400, detail="Folder path cannot be empty.")
    tenant_id = getattr(user, "tenant_id", None) or "default"
    user_id = _get_user_id(user)
    return service.request_folder(tenant_id, user_id, body.folder_path.strip())


@router.delete("/folders")
@router.delete("/folders/{folder_id:path}")
async def remove_local_folder(
    folder_id: str | None = None,
    folder_path: str | None = Query(None),
    user: UserIdentity = Depends(get_current_user),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> dict[str, Any]:
    """Disconnect an approved local folder and delete its synced chunks."""
    _require_folder_management_access(user)
    import urllib.parse
    raw_target = folder_path or folder_id or ""
    target_id = urllib.parse.unquote(raw_target).strip()
    if not target_id:
        raise HTTPException(status_code=400, detail="Folder path or folder_id is required.")
    tenant_id = getattr(user, "tenant_id", None) or "default"
    user_id = _get_user_id(user)
    service.remove_folder(tenant_id, user_id, target_id)
    # Check if there are remaining connected folders for this user
    try:
        rem_status = service.get_status(tenant_id, user_id)
        rem_folders = rem_status.connected_folders or []
        from backend.integrations.files.company_data_service import CompanyDataService

        user_cds = CompanyDataService.for_user(tenant_id, user_id)
        if not rem_folders:
            from backend.integrations.files.company_data.persistence import clear_persisted_folder
            user_cds.root = Path("")
            user_cds._chunks = []
            user_cds._indexed_files = {}
            user_cds._file_hashes = {}

            clear_persisted_folder(tenant_id)

            cds = CompanyDataService.for_tenant(tenant_id)
            cds.root = Path("")
            cds._chunks = []
            cds._indexed_files = {}
            cds._file_hashes = {}
        else:
            next_cand = Path(rem_folders[0].folder_path)
            if next_cand.exists() and next_cand.is_dir():
                user_cds.update_root(next_cand)
                if user_id == "default":
                    CompanyDataService.for_tenant(tenant_id).update_root(next_cand)
            else:
                user_cds.ensure_indexed(force=True)
    except Exception as exc:
        logger.debug("Could not update company data service state on remove: %s", exc)

    return {"status": "ok", "message": f"Folder '{target_id}' disconnected."}


class ExtractTextRequest(BaseModel):
    """Stateless in-memory text extraction request for browser-connected binary documents."""
    filename: str
    content_base64: str


@router.post("/extract-text")
async def extract_document_text_stateless(
    body: ExtractTextRequest,
    user: UserIdentity = Depends(get_current_user),
) -> dict[str, Any]:
    """Extract text from binary document bytes purely in RAM (zero disk persistence)."""
    import base64
    from datetime import datetime, timezone
    from backend.integrations.files.company_data.extraction import create_default_document_service

    clean_name = Path(body.filename or "").name.strip()
    if not clean_name or "\x00" in clean_name:
        raise HTTPException(status_code=400, detail="Invalid filename.")

    ext = Path(clean_name).suffix.casefold()
    allowed = {
        ".pdf", ".docx", ".xlsx", ".xlsm", ".pptx", ".txt", ".md", ".csv", ".tsv",
        ".json", ".html", ".htm", ".xml", ".rtf",
        ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif",
    }
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"Unsupported file extension '{ext}'.")

    try:
        raw = base64.b64decode(body.content_base64, validate=False)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 payload.")

    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File exceeds 15MB stateless extraction limit.")

    doc_svc = create_default_document_service()
    doc = doc_svc.parse_bytes(
        filename=clean_name,
        relative_path=clean_name,
        data=raw,
        modified_at=datetime.now(timezone.utc),
    )
    return {
        "filename": clean_name,
        "text": (doc.text or "").strip(),
    }


@router.post("/search", response_model=LocalSearchResponse)
async def test_search_local(
    body: LocalSearchRequest,
    user: UserIdentity = Depends(get_current_user),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> LocalSearchResponse:
    """Search user's active local files directly."""
    tenant_id = getattr(user, "tenant_id", None) or "default"
    user_id = _get_user_id(user)
    hits = service.search_local_chunks(
        tenant_id=tenant_id,
        user_id=user_id,
        query=body.query,
        top_k=body.top_k,
        folder_id=body.folder_id,
    )
    return LocalSearchResponse(
        query=body.query,
        total_hits=len(hits),
        chunks=hits,
    )


# ---------------------------------------------------------------------------
# Agent Endpoints (Accessed from User's Local Windows Computer)
# ---------------------------------------------------------------------------

@router.post("/heartbeat")
async def agent_heartbeat(
    heartbeat: LocalAgentHeartbeat,
    identity: tuple[str, str] = Depends(_extract_agent_identity),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> dict[str, Any]:
    """Heartbeat signal sent periodically by the local agent."""
    tenant_id, user_id = identity
    return service.record_heartbeat(tenant_id, user_id, heartbeat)


@router.post("/sync")
async def agent_sync_folder(
    payload: FolderSyncPayload,
    identity: tuple[str, str] = Depends(_extract_agent_identity),
    service: LocalAgentService = Depends(get_local_agent_service),
) -> dict[str, Any]:
    """Sync batch of indexed chunks and files from an approved local folder."""
    tenant_id, user_id = identity
    res = service.sync_folder(tenant_id, user_id, payload)

    # Refresh only this user's isolated CompanyDataService workspace (never cross-user)
    try:
        from pathlib import Path
        from backend.integrations.files.company_data_service import CompanyDataService
        from backend.integrations.files.company_data.persistence import set_persisted_folder

        raw_fp = (payload.folder_path or "").strip()
        p = Path(raw_fp) if raw_fp and "://" not in raw_fp else None
        is_local_dir = bool(p is not None and p.exists() and p.is_dir())

        user_cds = CompanyDataService.for_user(tenant_id, user_id)
        if is_local_dir and p is not None:
            user_cds.update_root(p)
        else:
            user_cds._load_from_local_agent()

        if user_id == "default":
            if is_local_dir and p is not None:
                set_persisted_folder(raw_fp, tenant_id=tenant_id)
            cds = CompanyDataService.for_tenant(tenant_id)
            if is_local_dir and p is not None:
                cds.update_root(p)
            else:
                cds._load_from_local_agent()
    except Exception as exc:
        logger.warning("Could not sync CompanyDataService with agent folder: %s", exc)

    return res

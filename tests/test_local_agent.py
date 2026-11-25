"""Unit and integration tests for Nanvi Local File Agent and Cloud API."""
from __future__ import annotations

import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from backend.agents.models import AgentRequest
from backend.local_agent.models import (
    FolderSyncPayload,
    LocalAgentHeartbeat,
    LocalChunkRecord,
    LocalFileRecord,
    LocalFolderInfo,
)
from backend.local_agent.service import LocalAgentService
from backend.local_agent.store import LocalAgentStore
from backend.security.models import UserIdentity
from local_agent.nanvi_local_agent import NanviLocalAgent, SecurityError


@pytest.fixture
def temp_store(tmp_path):
    store_file = tmp_path / "test_local_agent_store.json"
    return LocalAgentStore(persistence_file=store_file)


@pytest.fixture
def local_service(temp_store):
    return LocalAgentService(store=temp_store)


@pytest.fixture
def mock_user():
    from backend.security.authorization.rbac import Role
    return UserIdentity(
        subject="usr-123",
        issuer="nanvi-test",
        tenant_id="tenant-abc",
        name="Test Engineer",
        roles=frozenset({Role.PROJECT_ENGINEER}),
    )


# ---------------------------------------------------------------------------
# 1. Pairing Token Tests
# ---------------------------------------------------------------------------

def test_pairing_token_creation_and_verification(local_service, mock_user):
    token_resp = local_service.create_pairing_token(mock_user, "http://127.0.0.1:8000")
    assert token_resp.token
    assert token_resp.tenant_id == "tenant-abc"
    assert token_resp.user_id == "usr-123"

    payload = local_service.verify_agent_token(token_resp.token)
    assert payload["sub"] == "usr-123"
    assert payload["tenant_id"] == "tenant-abc"
    assert payload["aud"] == "nanvi-local-agent"


def test_tampered_token_rejected(local_service):
    with pytest.raises(Exception):
        local_service.verify_agent_token("invalid.tampered.token")


# ---------------------------------------------------------------------------
# 2. Local Agent Store & Heartbeat Tests
# ---------------------------------------------------------------------------

def test_heartbeat_and_online_status(local_service):
    tenant_id = "tenant-abc"
    user_id = "usr-123"

    # Initially offline
    status = local_service.get_status(tenant_id, user_id)
    assert not status.is_online
    assert status.total_files == 0

    # Send heartbeat
    hb = LocalAgentHeartbeat(
        agent_version="1.0.0",
        folders=[
            LocalFolderInfo(
                folder_id="C:/Projects",
                folder_path="C:/Projects",
                display_name="Projects",
                file_count=12,
                chunk_count=24,
            )
        ],
    )
    local_service.record_heartbeat(tenant_id, user_id, hb)

    # Now online
    status_after = local_service.get_status(tenant_id, user_id)
    assert status_after.is_online
    assert len(status_after.connected_folders) == 1
    assert status_after.connected_folders[0].folder_path == "C:/Projects"


# ---------------------------------------------------------------------------
# 3. Sync & Search Tests
# ---------------------------------------------------------------------------

def test_sync_and_search_chunks(local_service):
    tenant_id = "tenant-abc"
    user_id = "usr-123"

    payload = FolderSyncPayload(
        folder_id="C:/Projects",
        folder_path="C:/Projects",
        display_name="Projects",
        files=[
            LocalFileRecord(
                relative_path="Chennai_Bridge/Inspection_Report.pdf",
                filename="Inspection_Report.pdf",
                folder_name="Projects",
                file_type="pdf",
                size_bytes=1024,
                chunk_count=2,
            )
        ],
        chunks=[
            LocalChunkRecord(
                chunk_id="chunk-001",
                relative_path="Chennai_Bridge/Inspection_Report.pdf",
                filename="Inspection_Report.pdf",
                folder_name="Projects",
                chunk_index=0,
                text="The Chennai River Bridge foundation pile load test exceeded the 4500 kN requirement.",
            ),
            LocalChunkRecord(
                chunk_id="chunk-002",
                relative_path="Cooum_Flyover/Safety_Audit.docx",
                filename="Safety_Audit.docx",
                folder_name="Projects",
                chunk_index=0,
                text="Safety helmets and harnesses are mandatory for all elevated beam workers.",
            ),
        ],
    )

    local_service.sync_folder(tenant_id, user_id, payload)

    # Search for bridge
    hits = local_service.search_local_chunks(tenant_id, user_id, "Chennai Bridge foundation", top_k=5)
    assert len(hits) >= 1
    top = hits[0]
    assert "Inspection_Report.pdf" in top.filename
    assert top.citation == "Projects/Chennai_Bridge/Inspection_Report.pdf"
    assert "4500 kN" in top.text

    # Search for safety
    safety_hits = local_service.search_local_chunks(tenant_id, user_id, "helmets safety", top_k=5)
    assert len(safety_hits) >= 1
    assert "Safety_Audit.docx" in safety_hits[0].filename


def test_remove_folder(local_service):
    tenant_id = "tenant-abc"
    user_id = "usr-123"

    payload = FolderSyncPayload(
        folder_id="C:/TempData",
        folder_path="C:/TempData",
        display_name="TempData",
        chunks=[
            LocalChunkRecord(
                chunk_id="chunk-temp",
                relative_path="file.txt",
                filename="file.txt",
                folder_name="TempData",
                text="Temporary content.",
            )
        ],
    )
    local_service.sync_folder(tenant_id, user_id, payload)

    assert len(local_service.search_local_chunks(tenant_id, user_id, "Temporary")) == 1

    # Remove folder
    removed = local_service.remove_folder(tenant_id, user_id, "C:/TempData")
    assert removed
    assert len(local_service.search_local_chunks(tenant_id, user_id, "Temporary")) == 0


# ---------------------------------------------------------------------------
# 4. Local Agent Client Security & Parsing Tests
# ---------------------------------------------------------------------------

def test_local_agent_security_blocks_system_roots(tmp_path):
    agent = NanviLocalAgent(server_url="http://127.0.0.1:8000", token="dummy-token", config_path=tmp_path / "cfg.json")

    # Reject non-existent
    with pytest.raises(SecurityError, match="does not exist"):
        agent.validate_folder_path("C:/NonExistentPath_XYZ_123")

    # Reject system root (if Windows)
    win_path = Path("C:/Windows")
    if win_path.exists():
        with pytest.raises(SecurityError, match="restricted|prohibited"):
            agent.validate_folder_path(win_path)


def test_local_agent_chunking_and_extraction(tmp_path):
    agent = NanviLocalAgent(server_url="http://127.0.0.1:8000", token="dummy-token", config_path=tmp_path / "cfg.json")

    # Create dummy text file
    sample_dir = tmp_path / "sample_folder"
    sample_dir.mkdir()
    sample_file = sample_dir / "report.txt"
    sample_file.write_text("Nanvi enterprise assistant bridge construction inspection data.", encoding="utf-8")

    text = agent._extract_text(sample_file)
    assert "bridge construction" in text

    chunks = agent.chunk_text(text, "report.txt", "report.txt", "sample_folder", "2026-10-03T00:00:00Z")
    assert len(chunks) == 1
    assert chunks[0]["filename"] == "report.txt"
    assert "bridge construction" in chunks[0]["text"]


# ---------------------------------------------------------------------------
# 5. KnowledgeAgent RAG Integration Test
# ---------------------------------------------------------------------------

def test_knowledge_agent_retrieves_local_chunks(local_service, mock_user, monkeypatch):
    from backend.agents.knowledge_agent import KnowledgeAgent
    from backend.agents.models import Capability

    # Seed local chunk
    payload = FolderSyncPayload(
        folder_id="C:/Engineering",
        folder_path="C:/Engineering",
        display_name="Engineering",
        chunks=[
            LocalChunkRecord(
                chunk_id="chunk-eng-1",
                relative_path="Pylons/Stress_Analysis.csv",
                filename="Stress_Analysis.csv",
                folder_name="Engineering",
                text="The bridge pylon maximum tensile stress is 320 MPa under dynamic wind load.",
            )
        ],
    )
    local_service.sync_folder(mock_user.tenant_id, mock_user.subject, payload)

    # Monkeypatch singleton
    monkeypatch.setattr("backend.local_agent.service._service_instance", local_service)

    agent = KnowledgeAgent(company_data_service=None)
    req = AgentRequest(
        request_id="req-test-1",
        user=mock_user,
        query="What is the pylon maximum tensile stress?",
    )

    resp = agent.run(req)
    assert resp.capability == Capability.KNOWLEDGE
    assert "320 MPa" in str(resp.content)
    assert len(resp.sources) >= 1
    assert "Stress_Analysis.csv" in resp.sources[0].title


def test_request_folder_via_web_and_heartbeat_dispatch(local_service, mock_user):
    tenant_id = mock_user.tenant_id
    user_id = mock_user.subject

    # User adds folder from Web UI
    res = local_service.request_folder(tenant_id, user_id, "C:/Projects/Bridge")
    assert res["status"] == "ok"

    # Agent heartbeats and receives the requested folder in response
    hb_resp = local_service.record_heartbeat(
        tenant_id,
        user_id,
        LocalAgentHeartbeat(agent_version="1.0.0", folders=[]),
    )
    assert hb_resp["status"] == "ok"
    assert "C:/Projects/Bridge" in hb_resp["requested_folders"]


def test_sanitize_folder_path_strips_prefixes(local_service, mock_user):
    from backend.local_agent.service import sanitize_folder_path

    assert sanitize_folder_path("add C:\\Users\\haris\\Documents") == "C:\\Users\\haris\\Documents"
    assert sanitize_folder_path('add "C:\\CompanyData"') == "C:\\CompanyData"
    assert sanitize_folder_path("nanvi-agent add D:\\Projects") == "D:\\Projects"
    assert sanitize_folder_path("  'C:\\Data\\Reports'  ") == "C:\\Data\\Reports"
    assert sanitize_folder_path("python nanvi_local_agent.py add C:\\Docs") == "C:\\Docs"


def test_command_queue_and_heartbeat_dispatch(local_service, mock_user):
    tenant_id = mock_user.tenant_id
    user_id = mock_user.subject

    # Queue an open_file command
    cmd_id = local_service.queue_command(tenant_id, user_id, "open_file", {"file_path": r"C:\CompanyData\test.pdf"})
    assert cmd_id.startswith("cmd_")

    # Agent heartbeats and receives the command in response
    hb_resp = local_service.record_heartbeat(
        tenant_id,
        user_id,
        LocalAgentHeartbeat(agent_version="1.1.0", folders=[]),
    )
    assert hb_resp["status"] == "ok"
    assert len(hb_resp["commands"]) == 1
    assert hb_resp["commands"][0]["command"] == "open_file"
    assert hb_resp["commands"][0]["payload"]["file_path"] == r"C:\CompanyData\test.pdf"

    # Second heartbeat should have no commands (popped)
    hb_resp_2 = local_service.record_heartbeat(
        tenant_id,
        user_id,
        LocalAgentHeartbeat(agent_version="1.1.0", folders=[]),
    )
    assert len(hb_resp_2["commands"]) == 0


def test_document_content_retrieval(local_service):
    from backend.local_agent.routes import get_document_content
    from backend.security.authorization.rbac import Role

    user = UserIdentity(
        subject="usr-doc-test",
        issuer="nanvi-test",
        tenant_id="tenant-abc",
        name="Doc Tester",
        roles=frozenset({Role.FINANCE}),
    )

    # Test retrieving invoice_022.pdf
    resp = get_document_content(
        path=r"C:\CompanyData\Finance\01_Invoices_PDF\invoice_022.pdf",
        download=False,
        user=user,
        service=local_service,
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert "inline" in resp.headers["content-disposition"]
    assert len(resp.body) > 0


def test_set_single_folder_exclusive_replacement(tmp_path):
    folder1 = tmp_path / "folder1"
    folder1.mkdir()
    folder2 = tmp_path / "folder2"
    folder2.mkdir()

    cfg_file = tmp_path / "agent_config.json"
    agent = NanviLocalAgent("http://127.0.0.1:8000", "test-token", config_path=cfg_file)

    # Add first folder
    agent.add_folder(str(folder1))
    assert str(folder1.resolve()) in agent.approved_folders
    assert len(agent.approved_folders) == 1

    # Switch to second folder with set_single_folder
    agent.set_single_folder(str(folder2))
    assert str(folder2.resolve()) in agent.approved_folders
    assert str(folder1.resolve()) not in agent.approved_folders
    assert len(agent.approved_folders) == 1


def test_download_agent_package_bat_and_zip():
    from backend.local_agent.packager import generate_agent_bat, generate_agent_zip

    bat_code = generate_agent_bat("https://example.com", "token-123", "User")
    assert "@echo off" in bat_code
    assert "Nanvi Assistant - Local File Agent" in bat_code
    assert len(bat_code) > 1000

    zip_bytes = generate_agent_zip("https://example.com", "token-123", "User")
    assert isinstance(zip_bytes, bytes)
    assert len(zip_bytes) > 500


def test_folder_sync_allows_multiple_folders(local_service):
    tenant_id = "tenant-multi"
    user_id = "usr-multi"

    # Sync Folder A
    payload_a = FolderSyncPayload(
        folder_id="C:/FolderA",
        folder_path="C:/FolderA",
        display_name="FolderA",
        files=[LocalFileRecord(relative_path="a.txt", filename="a.txt", folder_name="FolderA", file_type="txt")],
        chunks=[LocalChunkRecord(chunk_id="chunk-a", relative_path="a.txt", filename="a.txt", folder_name="FolderA", text="Alpha secret text")],
        replace_all=True,
    )
    local_service.sync_folder(tenant_id, user_id, payload_a)

    files_a = local_service.get_all_local_files(tenant_id, user_id)
    assert len(files_a) == 1
    assert files_a[0]["name"] == "a.txt"

    # Add Folder B
    payload_b = FolderSyncPayload(
        folder_id="C:/FolderB",
        folder_path="C:/FolderB",
        display_name="FolderB",
        files=[LocalFileRecord(relative_path="b.txt", filename="b.txt", folder_name="FolderB", file_type="txt")],
        chunks=[LocalChunkRecord(chunk_id="chunk-b", relative_path="b.txt", filename="b.txt", folder_name="FolderB", text="Beta new content")],
        replace_all=True,
    )
    local_service.sync_folder(tenant_id, user_id, payload_b)

    files_both = local_service.get_all_local_files(tenant_id, user_id)
    assert len(files_both) == 2
    assert any(f["name"] == "a.txt" for f in files_both)
    assert any(f["name"] == "b.txt" for f in files_both)
    hits_a = local_service.search_local_chunks(tenant_id, user_id, "Alpha")
    assert len(hits_a) == 1
    hits_b = local_service.search_local_chunks(tenant_id, user_id, "Beta")
    assert len(hits_b) == 1





def test_packager_launches_detached_gui_without_cmd_prompts(tmp_path):
    """Nanvi_Assistant.bat must unpack nanvi_gui_agent.pyw and launch via pythonw cleanly."""
    import base64
    import io
    import shutil
    import subprocess
    import zipfile
    from backend.local_agent.packager import generate_agent_bat, generate_agent_zip

    bat_code = generate_agent_bat("https://nanvi.example.com/", "tok-123\"&whoami", "Harish")
    assert "@echo off" in bat_code
    assert "Nanvi Assistant - Local File Agent" in bat_code
    assert "nanvi_gui_agent.pyw" in bat_code
    assert "PYTHONW_EXE" in bat_code
    assert 'start "" "%PYTHONW_EXE%" "%TARGET_PYW%"' in bat_code
    assert "Nanvi Local Connector.lnk" in bat_code
    assert "exit /b 0" in bat_code
    assert "FolderBrowserDialog" not in bat_code
    assert "SELECT COMPANY FOLDER" not in bat_code
    assert 'start "" "https://nanvi.example.com"' not in bat_code
    assert 'tok-123"&whoami' not in bat_code
    assert "tok-123whoami" in bat_code

    # Verify PEM base64 block decodes byte-for-byte to gui_agent.py
    begin_marker = "echo -----BEGIN CERTIFICATE-----"
    end_marker = "echo -----END CERTIFICATE-----"
    assert begin_marker in bat_code and end_marker in bat_code
    pem_body = bat_code.split(begin_marker, 1)[1].split(end_marker, 1)[0]
    b64_payload = "".join(
        line.strip()[5:] for line in pem_body.splitlines() if line.strip().startswith("echo ")
    )
    decoded_src = base64.b64decode(b64_payload).decode("utf-8")
    expected_src = (Path(__file__).resolve().parents[1] / "backend" / "local_agent" / "gui_agent.py").read_text(encoding="utf-8")
    assert decoded_src == expected_src
    compile(decoded_src, "nanvi_gui_agent.pyw", "exec")

    certutil_bin = shutil.which("certutil")
    if certutil_bin:
        b64_file = tmp_path / "agent.b64"
        out_pyw = tmp_path / "nanvi_gui_agent.pyw"
        pem_lines = ["-----BEGIN CERTIFICATE-----"]
        pem_lines.extend(line.strip()[5:] for line in pem_body.splitlines() if line.strip().startswith("echo "))
        pem_lines.append("-----END CERTIFICATE-----")
        b64_file.write_text("\r\n".join(pem_lines) + "\r\n", encoding="ascii")
        proc = subprocess.run([certutil_bin, "-f", "-decode", str(b64_file), str(out_pyw)], capture_output=True, text=True)
        assert proc.returncode == 0, proc.stderr
        assert out_pyw.read_text(encoding="utf-8") == expected_src

    zip_bytes = generate_agent_zip("https://nanvi.example.com", "tok-123", "Harish")
    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
        names = set(zf.namelist())
        assert "Nanvi_Local_Agent/nanvi_gui_agent.pyw" in names
        assert "Nanvi_Local_Agent/config.json" in names
        assert "Nanvi_Local_Agent/Start_Nanvi_Agent.bat" in names
        start_bat = zf.read("Nanvi_Local_Agent/Start_Nanvi_Agent.bat").decode("utf-8")
        assert "nanvi_gui_agent.pyw" in start_bat
        assert "PYTHONW_EXE" in start_bat or "pyw" in start_bat


def test_gui_agent_single_folder_stdlib_extract_and_deduplicated_browse(tmp_path, monkeypatch):
    """Verify gui_agent supports single-folder replacement, stdlib xlsx extraction, and deduplicated browse callbacks."""
    import io
    import json
    import zipfile
    import backend.local_agent.gui_agent as gui_agent

    folder_a = tmp_path / "FolderA"
    folder_b = tmp_path / "FolderB"
    folder_a.mkdir()
    folder_b.mkdir()
    config_file = tmp_path / "config.json"

    agent = gui_agent.NanviLocalAgent(
        server_url="https://example.com",
        token="tok-gui",
        config_path=config_file,
    )
    agent.add_folder(str(folder_a))
    assert str(folder_a.resolve()) in agent.approved_folders

    agent.set_single_folder(str(folder_b))
    assert str(folder_a.resolve()) not in agent.approved_folders
    assert list(agent.approved_folders.keys()) == [str(folder_b.resolve())]

    # Build a minimal valid XLSX archive using pure stdlib
    xlsx_path = folder_b / "budget.xlsx"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "xl/sharedStrings.xml",
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Bridge Steel</t></si><si><t>45000</t></si></sst>',
        )
        zf.writestr(
            "xl/worksheets/sheet1.xml",
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>',
        )
    xlsx_path.write_bytes(buf.getvalue())

    extracted = agent._extract_text(xlsx_path)
    assert "Bridge Steel" in extracted
    assert "45000" in extracted

    # Verify browse_folder commands in a single heartbeat invoke browse_callback only once
    browse_calls = []
    agent.browse_callback = lambda: browse_calls.append(1)

    class _FakeResp:
        status = 200
        def __init__(self, payload: dict):
            self._data = json.dumps(payload).encode("utf-8")
        def read(self):
            return self._data
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False

    monkeypatch.setattr(
        gui_agent,
        "urlopen",
        lambda req, timeout=10: _FakeResp({
            "requested_folders": [str(tmp_path / "DoesNotExist")],
            "commands": [
                {"command": "browse_folder", "payload": {}},
                {"command": "browse_folder", "payload": {}},
                {"command": "browse_folder", "payload": {}},
            ],
        }),
    )
    assert agent.send_heartbeat() is True
    assert len(browse_calls) == 1
    assert any("DoesNotExist" in p for p in agent._failed_requested_folders)

    # Verify app PNG icon generation
    png_bytes = gui_agent._build_nanvi_icon_png(32)
    assert png_bytes.startswith(b"\x89PNG\r\n\x1a\n")


def test_browser_folder_sync_extract_text_and_disconnect(tmp_path, monkeypatch):
    """Browser File System Access API sync, stateless extract-text, and disconnect cleanup."""
    import base64
    from starlette.testclient import TestClient
    from backend.main import app
    from backend.integrations.files.company_data_service import CompanyDataService
    from backend.local_agent.store import LocalAgentStore
    import backend.local_agent.service as local_agent_svc

    monkeypatch.setenv("VERCEL", "1")
    isolated_store = LocalAgentStore(dsn="", persistence_file=tmp_path / "local_agent_store.json")
    monkeypatch.setattr(local_agent_svc, "_store", isolated_store)
    CompanyDataService.clear_registry()

    client = TestClient(app)
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "admin@company"})
    assert login_resp.status_code == 200, login_resp.text
    user_headers = {"Authorization": f"Bearer {login_resp.json()['access_token']}"}

    # 1. Obtain scoped pairing token
    tok_resp = client.post("/api/local-agent/token", headers=user_headers)
    assert tok_resp.status_code == 200, tok_resp.text
    tok_data = tok_resp.json()
    pairing_token = tok_data["token"]
    admin_uid = tok_data["user_id"]
    agent_headers = {"Authorization": f"Bearer {pairing_token}"}

    # 2. Sync chunks extracted directly in the browser
    sync_payload = {
        "folder_id": "browser://ClientDocs",
        "folder_path": "BrowserFolder/ClientDocs",
        "display_name": "ClientDocs",
        "files": [
            {
                "relative_path": "02_Projects/bridge_summary.txt",
                "filename": "bridge_summary.txt",
                "folder_name": "ClientDocs",
                "file_type": "txt",
                "size_bytes": 64,
                "chunk_count": 1,
            }
        ],
        "chunks": [
            {
                "chunk_id": "browser-chunk-1",
                "relative_path": "02_Projects/bridge_summary.txt",
                "filename": "bridge_summary.txt",
                "folder_name": "ClientDocs",
                "chunk_index": 0,
                "text": "Suspension bridge cable tension inspection passed with 0 defects.",
                "char_count": 64,
            }
        ],
        "replace_all": True,
    }
    sync_resp = client.post("/api/local-agent/sync", headers=agent_headers, json=sync_payload)
    assert sync_resp.status_code == 200, sync_resp.text
    assert sync_resp.json()["chunks_synced"] == 1

    # Heartbeat marks browser session online
    hb_resp = client.post(
        "/api/local-agent/heartbeat",
        headers=agent_headers,
        json={"agent_version": "browser-fs-1.0.0", "folders": []},
    )
    assert hb_resp.status_code == 200

    # Verify CompanyDataService immediately sees synced browser folder chunks strictly for the uploader
    cds = CompanyDataService.for_user("enterprise-tenant", admin_uid)
    assert any("bridge_summary.txt" == c.filename for c in cds.chunks)
    # Other users in the same tenant must not see admin's synced folder
    other_cds = CompanyDataService.for_user("enterprise-tenant", "usr-other-same-tenant")
    assert not any("bridge_summary.txt" == c.filename for c in other_cds.chunks)

    # 3. Verify stateless extract-text fallback endpoint
    raw_txt = base64.b64encode(b"Quarterly bridge audit complete.").decode("ascii")
    ex_resp = client.post(
        "/api/local-agent/extract-text",
        headers=user_headers,
        json={"filename": "audit.txt", "content_base64": raw_txt},
    )
    assert ex_resp.status_code == 200, ex_resp.text
    assert "Quarterly bridge audit complete." in ex_resp.json()["text"]

    # 4. Disconnecting browser folder purges chunks in both store and CompanyDataService
    del_resp = client.delete(
        "/api/local-agent/folders?folder_path=browser%3A%2F%2FClientDocs",
        headers=user_headers,
    )
    assert del_resp.status_code == 200, del_resp.text
    assert not any(c.filename == "bridge_summary.txt" for c in cds.chunks)
    CompanyDataService.clear_registry()


def test_multi_folder_stacking_and_removal_10_iterations(temp_store, local_service, mock_user):
    """Stress-test multi-folder stacking, incremental sync, and selective removal over 10 iterations."""
    t_id = mock_user.tenant_id
    u_id = mock_user.subject

    for iteration in range(1, 11):
        f_a = f"browser://Folder_A_iter{iteration}"
        f_b = f"browser://Folder_B_iter{iteration}"
        f_c = f"browser://Folder_C_iter{iteration}"
        f_d = f"browser://Folder_D_iter{iteration}"

        # 1. Add Folder A (5 files, 10 chunks)
        chunks_a = [
            LocalChunkRecord(
                chunk_id=f"a_{iteration}_{c}",
                relative_path=f"file_a_{c % 5}.txt",
                filename=f"file_a_{c % 5}.txt",
                folder_name=f"Folder_A_{iteration}",
                chunk_index=c,
                text=f"Folder A content chunk {c} iteration {iteration}",
                char_count=35,
                modified_at="2026-11-18T10:00:00Z",
            )
            for c in range(10)
        ]
        files_a = [
            LocalFileRecord(
                relative_path=f"file_a_{f}.txt",
                filename=f"file_a_{f}.txt",
                folder_name=f"Folder_A_{iteration}",
                file_type="txt",
                size_bytes=1024,
                chunk_count=2,
                modified_at="2026-11-18T10:00:00Z",
            )
            for f in range(5)
        ]
        local_service.sync_folder(
            t_id, u_id,
            FolderSyncPayload(
                folder_id=f_a,
                folder_path=f"Folder_A_{iteration}",
                display_name=f"Folder_A_{iteration}",
                files=files_a,
                chunks=chunks_a,
                replace_all=True,
            )
        )
        status = local_service.get_status(t_id, u_id)
        assert len(status.connected_folders) == 1
        assert status.connected_folders[0].chunk_count == 10
        assert status.total_chunks == 10
        assert status.total_files == 5

        # 2. Add Folder B (8 files, 15 chunks) - must STACK with Folder A
        chunks_b = [
            LocalChunkRecord(
                chunk_id=f"b_{iteration}_{c}",
                relative_path=f"file_b_{c % 8}.txt",
                filename=f"file_b_{c % 8}.txt",
                folder_name=f"Folder_B_{iteration}",
                chunk_index=c,
                text=f"Folder B content chunk {c} iteration {iteration}",
                char_count=35,
                modified_at="2026-11-18T10:00:00Z",
            )
            for c in range(15)
        ]
        files_b = [
            LocalFileRecord(
                relative_path=f"file_b_{f}.txt",
                filename=f"file_b_{f}.txt",
                folder_name=f"Folder_B_{iteration}",
                file_type="txt",
                size_bytes=2048,
                chunk_count=2,
                modified_at="2026-11-18T10:00:00Z",
            )
            for f in range(8)
        ]
        local_service.sync_folder(
            t_id, u_id,
            FolderSyncPayload(
                folder_id=f_b,
                folder_path=f"Folder_B_{iteration}",
                display_name=f"Folder_B_{iteration}",
                files=files_b,
                chunks=chunks_b,
                replace_all=True,
            )
        )
        status = local_service.get_status(t_id, u_id)
        assert len(status.connected_folders) == 2, f"Iteration {iteration}: expected 2 stacked folders"
        f_map = {f.folder_id: f for f in status.connected_folders}
        assert f_a in f_map and f_b in f_map
        assert f_map[f_a].chunk_count == 10, "Folder A chunk count preserved"
        assert f_map[f_b].chunk_count == 15, "Folder B chunk count set"
        assert status.total_chunks == 25
        assert status.total_files == 13

        # 3. Add Folder C (4 files, 7 chunks) - must STACK to 3 folders
        chunks_c = [
            LocalChunkRecord(
                chunk_id=f"c_{iteration}_{c}",
                relative_path=f"file_c_{c % 4}.txt",
                filename=f"file_c_{c % 4}.txt",
                folder_name=f"Folder_C_{iteration}",
                chunk_index=c,
                text=f"Folder C content chunk {c} iteration {iteration}",
                char_count=35,
                modified_at="2026-11-18T10:00:00Z",
            )
            for c in range(7)
        ]
        files_c = [
            LocalFileRecord(
                relative_path=f"file_c_{f}.txt",
                filename=f"file_c_{f}.txt",
                folder_name=f"Folder_C_{iteration}",
                file_type="txt",
                size_bytes=512,
                chunk_count=2,
                modified_at="2026-11-18T10:00:00Z",
            )
            for f in range(4)
        ]
        local_service.sync_folder(
            t_id, u_id,
            FolderSyncPayload(
                folder_id=f_c,
                folder_path=f"Folder_C_{iteration}",
                display_name=f"Folder_C_{iteration}",
                files=files_c,
                chunks=chunks_c,
                replace_all=True,
            )
        )
        status = local_service.get_status(t_id, u_id)
        assert len(status.connected_folders) == 3, f"Iteration {iteration}: expected 3 stacked folders"
        f_map = {f.folder_id: f for f in status.connected_folders}
        assert f_map[f_a].chunk_count == 10
        assert f_map[f_b].chunk_count == 15
        assert f_map[f_c].chunk_count == 7
        assert status.total_chunks == 32
        assert status.total_files == 17

        # 4. Search across all stacked folders
        res_a = local_service.search_local_chunks(t_id, u_id, f"Folder A content chunk 0 iteration {iteration}", top_k=5)
        res_b = local_service.search_local_chunks(t_id, u_id, f"Folder B content chunk 0 iteration {iteration}", top_k=5)
        res_c = local_service.search_local_chunks(t_id, u_id, f"Folder C content chunk 0 iteration {iteration}", top_k=5)
        assert len(res_a) > 0
        assert len(res_b) > 0
        assert len(res_c) > 0

        # 5. Heartbeat keepalive with 0 chunk_count must NEVER wipe stored chunk counts
        local_service.record_heartbeat(
            t_id, u_id,
            LocalAgentHeartbeat(
                agent_version="browser-fs-1.0.0",
                folders=[
                    LocalFolderInfo(folder_id=f_a, folder_path=f"Folder_A_{iteration}", display_name=f"Folder_A_{iteration}", file_count=5, chunk_count=0),
                    LocalFolderInfo(folder_id=f_b, folder_path=f"Folder_B_{iteration}", display_name=f"Folder_B_{iteration}", file_count=8, chunk_count=0),
                    LocalFolderInfo(folder_id=f_c, folder_path=f"Folder_C_{iteration}", display_name=f"Folder_C_{iteration}", file_count=4, chunk_count=0),
                ]
            )
        )
        status = local_service.get_status(t_id, u_id)
        f_map = {f.folder_id: f for f in status.connected_folders}
        assert f_map[f_a].chunk_count == 10, "Keepalive must preserve Folder A chunks"
        assert f_map[f_b].chunk_count == 15, "Keepalive must preserve Folder B chunks"
        assert f_map[f_c].chunk_count == 7, "Keepalive must preserve Folder C chunks"
        assert status.total_chunks == 32

        # 6. Remove Folder B -> Folder A and Folder C must remain
        local_service.remove_folder(t_id, u_id, f_b)
        status = local_service.get_status(t_id, u_id)
        assert len(status.connected_folders) == 2, f"Iteration {iteration}: expected 2 folders after removing B"
        f_map = {f.folder_id: f for f in status.connected_folders}
        assert f_a in f_map and f_c in f_map and f_b not in f_map
        assert f_map[f_a].chunk_count == 10
        assert f_map[f_c].chunk_count == 7
        assert status.total_chunks == 17
        assert status.total_files == 9

        # 7. Add Folder D (6 files, 12 chunks) -> stacks to 3 folders (A, C, D)
        chunks_d = [
            LocalChunkRecord(
                chunk_id=f"d_{iteration}_{c}",
                relative_path=f"file_d_{c % 6}.txt",
                filename=f"file_d_{c % 6}.txt",
                folder_name=f"Folder_D_{iteration}",
                chunk_index=c,
                text=f"Folder D content chunk {c} iteration {iteration}",
                char_count=35,
                modified_at="2026-11-18T10:00:00Z",
            )
            for c in range(12)
        ]
        files_d = [
            LocalFileRecord(
                relative_path=f"file_d_{f}.txt",
                filename=f"file_d_{f}.txt",
                folder_name=f"Folder_D_{iteration}",
                file_type="txt",
                size_bytes=1024,
                chunk_count=2,
                modified_at="2026-11-18T10:00:00Z",
            )
            for f in range(6)
        ]
        local_service.sync_folder(
            t_id, u_id,
            FolderSyncPayload(
                folder_id=f_d,
                folder_path=f"Folder_D_{iteration}",
                display_name=f"Folder_D_{iteration}",
                files=files_d,
                chunks=chunks_d,
                replace_all=True,
            )
        )
        status = local_service.get_status(t_id, u_id)
        assert len(status.connected_folders) == 3
        f_map = {f.folder_id: f for f in status.connected_folders}
        assert f_map[f_a].chunk_count == 10
        assert f_map[f_c].chunk_count == 7
        assert f_map[f_d].chunk_count == 12
        assert status.total_chunks == 29
        assert status.total_files == 15

        # 8. Remove Folder A -> C and D remain
        local_service.remove_folder(t_id, u_id, f_a)
        status = local_service.get_status(t_id, u_id)
        assert len(status.connected_folders) == 2
        f_map = {f.folder_id: f for f in status.connected_folders}
        assert f_c in f_map and f_d in f_map and f_a not in f_map

        # 9. Clean up C and D
        local_service.remove_folder(t_id, u_id, f_c)
        local_service.remove_folder(t_id, u_id, f_d)
        status = local_service.get_status(t_id, u_id)
        assert len(status.connected_folders) == 0
        assert status.total_chunks == 0
        assert status.total_files == 0


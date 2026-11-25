from pathlib import Path
from unittest.mock import MagicMock
import pytest

from backend.agents.interfaces import AgentRequest
from backend.agents.knowledge_agent import KnowledgeAgent
from backend.local_agent.service import LocalAgentService, get_local_agent_service
from backend.local_agent.models import FolderSyncPayload, LocalChunkRecord, LocalAgentHeartbeat, LocalFolderInfo
from backend.local_agent.store import LocalAgentStore
from backend.security.authorization import UserAttributes


def test_knowledge_agent_answers_from_local_folder_files(tmp_path):
    store = LocalAgentStore(persistence_file=tmp_path / "store.json")
    service = LocalAgentService(store=store)

    import backend.local_agent.service as svc_mod
    orig_svc = svc_mod._service_instance
    svc_mod._service_instance = service

    try:
        tenant_id = "tenant-test"
        user_id = "usr-456"
        user = UserAttributes(user_id=user_id, tenant_id=tenant_id, department="Projects", roles=frozenset({"Employee"}))

        # 1. Sync chunks from a local folder
        payload = FolderSyncPayload(
            folder_id="C:/Users/haris/Documents",
            folder_path="C:/Users/haris/Documents",
            display_name="Documents",
            chunks=[
                LocalChunkRecord(
                    chunk_id="chunk-roadmap-1",
                    relative_path="project_roadmap.pdf",
                    filename="project_roadmap.pdf",
                    folder_name="Documents",
                    text="Project Roadmap 2026: Launching Nanvi AI Assistant across all enterprise divisions by Q3.",
                ),
                LocalChunkRecord(
                    chunk_id="chunk-budget-1",
                    relative_path="q4_budget.xlsx",
                    filename="q4_budget.xlsx",
                    folder_name="Documents",
                    text="Q4 Budget Summary: Total allocated marketing budget is $150,000.",
                ),
            ],
        )
        service.sync_folder(tenant_id, user_id, payload)

        # Setup KnowledgeAgent
        knowledge_agent = KnowledgeAgent(
            company_data_service=None,  # Emulate Vercel cloud environment where CompanyData is remote/empty
        )

        # Query 1: "what files are in my folder?"
        req_listing = AgentRequest(request_id="req-1", user=user, query="what files are in my folder?")
        resp_listing = knowledge_agent.run(req_listing)

        assert resp_listing is not None
        assert "project_roadmap.pdf" in resp_listing.content
        assert "q4_budget.xlsx" in resp_listing.content
        assert len(resp_listing.sources) >= 1

        # Query 2: "summarize the documents in my folder"
        req_summary = AgentRequest(request_id="req-2", user=user, query="summarize the documents in my folder")
        resp_summary = knowledge_agent.run(req_summary)

        assert resp_summary is not None
        assert ("Project Roadmap" in resp_summary.content) or ("Q4 Budget" in resp_summary.content)
        assert len(resp_summary.sources) >= 1

        # Query 3: Specific content inquiry: "what is the marketing budget?"
        req_specific = AgentRequest(request_id="req-3", user=user, query="what is the marketing budget in my files?")
        resp_specific = knowledge_agent.run(req_specific)

        assert resp_specific is not None
        assert "150,000" in resp_specific.content or "budget" in resp_summary.content.lower()
    finally:
        svc_mod._service_instance = orig_svc


def test_folder_disconnect_queues_command_and_prevents_resurrection(tmp_path):
    store = LocalAgentStore(persistence_file=tmp_path / "store2.json")
    service = LocalAgentService(store=store)

    tenant_id = "tenant-test"
    user_id = "usr-456"

    # 1. Sync folder
    folder_path = "C:/Users/haris/Documents"
    payload = FolderSyncPayload(
        folder_id=folder_path,
        folder_path=folder_path,
        display_name="Documents",
        chunks=[
            LocalChunkRecord(
                chunk_id="chunk-1",
                relative_path="file.txt",
                filename="file.txt",
                folder_name="Documents",
                text="Important notes.",
            )
        ],
    )
    service.sync_folder(tenant_id, user_id, payload)

    # Verify online status and folder present
    status_before = service.get_status(tenant_id, user_id)
    assert len(status_before.connected_folders) == 1
    assert status_before.connected_folders[0].folder_id == folder_path

    # 2. Disconnect/remove folder via service
    removed = service.remove_folder(tenant_id, user_id, folder_path)
    assert removed is True

    # Verify folder and chunks removed from store
    status_after = service.get_status(tenant_id, user_id)
    assert len(status_after.connected_folders) == 0
    assert len(service.search_local_chunks(tenant_id, user_id, "Important")) == 0

    # 3. Simulate heartbeat from agent
    # Heartbeat still includes old folder before it receives the remove command
    hb = LocalAgentHeartbeat(
        agent_version="1.0.0",
        folders=[
            LocalFolderInfo(
                folder_id=folder_path,
                folder_path=folder_path,
                display_name="Documents",
                file_count=1,
                chunk_count=1,
                status="connected",
            )
        ],
    )
    hb_resp = service.record_heartbeat(tenant_id, user_id, hb)
    cmds = hb_resp.get("commands", [])

    # Heartbeat popped the queued remove_folder command!
    remove_cmds = [c for c in cmds if c.get("command") == "remove_folder"]
    assert len(remove_cmds) >= 1
    assert remove_cmds[0]["payload"]["folder_path"] == folder_path

    # Crucial: The heartbeat must NOT have resurrected the disconnected folder!
    status_after_hb = service.get_status(tenant_id, user_id)
    assert len(status_after_hb.connected_folders) == 0


def test_disconnect_then_browser_resync_and_full_chat_pipeline(monkeypatch, tmp_path):
    """Disconnecting a folder and explicitly re-syncing via browser must succeed and power Chat Q&A across domain queries."""
    from starlette.testclient import TestClient
    from backend.main import app
    from backend.agents.knowledge_agent import KnowledgeAgent
    from backend.agents.models import Capability
    from backend.chat.service import ChatService, DeterministicTestAnswerer, InMemoryConversationStore
    from backend.chat.models import ChatRequest
    from backend.integrations.files.company_data_service import CompanyDataService
    from backend.retrieval.intent import classify_retrieval_intent, QueryIntent
    import backend.local_agent.service as local_agent_svc

    monkeypatch.setenv("VERCEL", "1")
    isolated_store = LocalAgentStore(dsn="", persistence_file=tmp_path / "resync_store.json")
    isolated_service = LocalAgentService(store=isolated_store)
    monkeypatch.setattr(local_agent_svc, "_store", isolated_store)
    monkeypatch.setattr(local_agent_svc, "_service_instance", isolated_service)
    CompanyDataService.clear_registry()

    client = TestClient(app)
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "admin@company"})
    assert login_resp.status_code == 200, login_resp.text
    headers = {"Authorization": f"Bearer {login_resp.json()['access_token']}"}
    pair_data = client.post("/api/local-agent/token", headers=headers).json()
    pair_tok = pair_data["token"]
    admin_uid = pair_data["user_id"]
    agent_headers = {"Authorization": f"Bearer {pair_tok}"}

    # 1. Connect via desktop path, then disconnect it (populates disconnected_folders with basename too)
    first_sync = client.post(
        "/api/local-agent/sync",
        headers=agent_headers,
        json={
            "folder_id": "C:/Docs/companydata_bridge_construction",
            "folder_path": "C:/Docs/companydata_bridge_construction",
            "display_name": "companydata_bridge_construction",
            "files": [],
            "chunks": [
                {
                    "chunk_id": "old-1",
                    "relative_path": "old.txt",
                    "filename": "old.txt",
                    "folder_name": "companydata_bridge_construction",
                    "text": "Old file content",
                }
            ],
            "replace_all": True,
        },
    )
    assert first_sync.status_code == 200
    del_resp = client.delete(
        "/api/local-agent/folders?folder_path=C%3A%2FDocs%2Fcompanydata_bridge_construction",
        headers=headers,
    )
    assert del_resp.status_code == 200
    assert client.get("/api/local-agent/status", headers=headers).json()["connected_folders"] == []

    # Prime this user's CompanyDataService while disconnected (holds empty cached chunks; must auto-refresh after resync)
    cds = CompanyDataService.for_user("enterprise-tenant", admin_uid)
    cds.ensure_indexed()
    assert cds.chunks == []

    # 2. Explicitly reconnect SAME folder name via Method 1 (Browser Folder Access)
    resync_resp = client.post(
        "/api/local-agent/sync",
        headers=agent_headers,
        json={
            "folder_id": "browser://companydata_bridge_construction",
            "folder_path": "BrowserFolder/companydata_bridge_construction",
            "display_name": "companydata_bridge_construction",
            "files": [
                {
                    "relative_path": "03_Engineering/bridge_specs.txt",
                    "filename": "bridge_specs.txt",
                    "folder_name": "companydata_bridge_construction",
                    "file_type": "txt",
                    "size_bytes": 120,
                    "chunk_count": 1,
                },
                {
                    "relative_path": "05_Safety/safety_summary.pdf",
                    "filename": "safety_summary.pdf",
                    "folder_name": "companydata_bridge_construction",
                    "file_type": "pdf",
                    "size_bytes": 150,
                    "chunk_count": 1,
                },
            ],
            "chunks": [
                {
                    "chunk_id": "br-1",
                    "relative_path": "03_Engineering/bridge_specs.txt",
                    "filename": "bridge_specs.txt",
                    "folder_name": "companydata_bridge_construction",
                    "chunk_index": 0,
                    "text": "Main river pier uses M45 high-strength concrete and E350 structural steel girders.",
                },
                {
                    "chunk_id": "br-2",
                    "relative_path": "05_Safety/safety_summary.pdf",
                    "filename": "safety_summary.pdf",
                    "folder_name": "companydata_bridge_construction",
                    "chunk_index": 0,
                    "text": "All pier deck workers must wear full-body fall arrest harnesses during girder erection.",
                },
            ],
            "replace_all": True,
        },
    )
    assert resync_resp.status_code == 200, resync_resp.text

    # Backend status & settings MUST show folder connected (not blocked by prior disconnect)
    status_after_resync = client.get("/api/local-agent/status", headers=headers).json()
    assert len(status_after_resync["connected_folders"]) == 1
    assert status_after_resync["connected_folders"][0]["display_name"] == "companydata_bridge_construction"
    assert status_after_resync["total_chunks"] == 2
    assert client.get("/api/settings/company-folder", headers=headers).json()["exists"] is True

    # Simulate a stale/other worker CompanyDataService refreshing on search
    cds._last_indexed = 0.0
    cds._chunks = []

    # 3. Verify Chat routing & KnowledgeAgent use the synced folder for domain Q&A and summaries
    assert classify_retrieval_intent("What concrete mix is used in bridge_specs.txt?") == QueryIntent.KNOWLEDGE_QA
    assert ChatService._is_file_search_query("What concrete mix is used in bridge_specs.txt?") is False
    assert ChatService._is_file_search_query("What safety harness is required in safety_summary.pdf?") is False

    ka = KnowledgeAgent(company_data_service=cds)

    class _SimpleOrchestrator:
        agents = {Capability.KNOWLEDGE: ka}

        def invoke(self, req, forced_capability=None):
            from dataclasses import dataclass

            @dataclass
            class _St:
                response: object
                trace: tuple
                error: str | None = None

            return _St(response=ka.run(req), trace=("knowledge",))

    chat_svc = ChatService(_SimpleOrchestrator(), DeterministicTestAnswerer(), InMemoryConversationStore())
    enterprise_user = UserAttributes(
        user_id=admin_uid,
        tenant_id="enterprise-tenant",
        department="Executive",
        roles=frozenset({"Superior"}),
    )

    assert chat_svc._has_local_knowledge_hit(enterprise_user, "What mix is used for main river pier?") is True

    r_specs = chat_svc.ask(enterprise_user, ChatRequest("What concrete mix and steel girders are specified for the pier?"))
    assert "M45" in r_specs.answer
    assert "E350" in r_specs.answer
    assert r_specs.file_results
    spec_paths = [f["path"] for f in r_specs.file_results]
    assert len(spec_paths) == len(set(spec_paths))
    assert not any("BrowserFolder" in p for p in spec_paths)

    r_pdf_qa = chat_svc.ask(enterprise_user, ChatRequest("What fall arrest gear is required in safety_summary.pdf?"))
    assert "fall arrest harnesses" in r_pdf_qa.answer

    r_summary = chat_svc.ask(enterprise_user, ChatRequest("summarize my folder"))
    assert ("M45" in r_summary.answer) or ("fall arrest" in r_summary.answer)

    # Same-tenant user isolation preserved (another user in the same tenant has NO access to admin's folder)
    same_tenant_other = UserAttributes(
        user_id="usr-arjun",
        tenant_id="enterprise-tenant",
        department="Executive",
        roles=frozenset({"Superior"}),
    )
    assert chat_svc._has_local_knowledge_hit(same_tenant_other, "What mix is used for main river pier?") is False

    # Cross-tenant isolation preserved
    other_user = UserAttributes(
        user_id="usr-other",
        tenant_id="other-tenant",
        department="Executive",
        roles=frozenset({"Superior"}),
    )
    assert chat_svc._has_local_knowledge_hit(other_user, "What concrete mix is used for piers?") is False
    CompanyDataService.clear_registry()


def test_preview_isolates_same_named_files_and_open_checks_desktop_agent(monkeypatch, tmp_path):
    """Preview must isolate exact relative_path when multiple folders have identically named files,
    and open-file must not claim desktop execution when only a browser session is active."""
    from starlette.testclient import TestClient
    from backend.main import app
    from backend.integrations.files.company_data_service import CompanyDataService
    import backend.local_agent.service as local_agent_svc

    monkeypatch.setenv("VERCEL", "1")
    isolated_store = LocalAgentStore(dsn="", persistence_file=tmp_path / "preview_store.json")
    isolated_service = LocalAgentService(store=isolated_store)
    monkeypatch.setattr(local_agent_svc, "_store", isolated_store)
    monkeypatch.setattr(local_agent_svc, "_service_instance", isolated_service)
    CompanyDataService.clear_registry()

    client = TestClient(app)
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "admin@company"})
    assert login_resp.status_code == 200
    headers = {"Authorization": f"Bearer {login_resp.json()['access_token']}"}
    pair_data = client.post("/api/local-agent/token", headers=headers).json()
    pair_tok = pair_data["token"]
    admin_uid = pair_data["user_id"]
    agent_headers = {"Authorization": f"Bearer {pair_tok}"}

    client.post(
        "/api/local-agent/sync",
        headers=agent_headers,
        json={
            "folder_id": "browser://companydata_bridge_construction",
            "folder_path": "companydata_bridge_construction",
            "display_name": "companydata_bridge_construction",
            "files": [
                {
                    "relative_path": "02_Projects/PRJ-CVB-003/weekly_progress.csv",
                    "filename": "weekly_progress.csv",
                    "folder_name": "companydata_bridge_construction",
                    "file_type": "csv",
                    "size_bytes": 60,
                    "chunk_count": 1,
                },
                {
                    "relative_path": "02_Projects/PRJ-CHB-001/weekly_progress.csv",
                    "filename": "weekly_progress.csv",
                    "folder_name": "companydata_bridge_construction",
                    "file_type": "csv",
                    "size_bytes": 60,
                    "chunk_count": 1,
                },
            ],
            "chunks": [
                {
                    "chunk_id": "wp-cvb-1",
                    "relative_path": "02_Projects/PRJ-CVB-003/weekly_progress.csv",
                    "filename": "weekly_progress.csv",
                    "folder_name": "companydata_bridge_construction",
                    "chunk_index": 0,
                    "text": "Week,Project,Planned\nW35,PRJ-CVB-003,38",
                },
                {
                    "chunk_id": "wp-chb-1",
                    "relative_path": "02_Projects/PRJ-CHB-001/weekly_progress.csv",
                    "filename": "weekly_progress.csv",
                    "folder_name": "companydata_bridge_construction",
                    "chunk_index": 0,
                    "text": "Week,Project,Planned\nW35,PRJ-CHB-001,65",
                },
            ],
            "replace_all": True,
        },
    )
    client.post(
        "/api/local-agent/heartbeat",
        headers=agent_headers,
        json={"agent_version": "browser-fs-1.0.0", "folders": []},
    )

    # Preview for PRJ-CHB-001 must ONLY contain PRJ-CHB-001, never mix PRJ-CVB-003!
    prev = client.get(
        "/api/local-agent/document-content?path=companydata_bridge_construction/02_Projects/PRJ-CHB-001/weekly_progress.csv",
        headers=headers,
    )
    assert prev.status_code == 200
    assert "PRJ-CHB-001" in prev.text
    assert "PRJ-CVB-003" not in prev.text

    # open-file must report desktop_agent_online=False (browser session cannot start OS apps directly)
    op = client.post(
        "/api/local-agent/open-file",
        headers=headers,
        json={"file_path": "companydata_bridge_construction/02_Projects/PRJ-CHB-001/weekly_progress.csv"},
    )
    assert op.status_code == 200
    assert op.json()["desktop_agent_online"] is False
    assert op.json()["queued"] is False
    CompanyDataService.clear_registry()


def test_training_matrix_discovery_and_proportional_chunk_retention(monkeypatch, tmp_path):
    """Ensure queries like 'Training Matrix' and 'Training Matrix find this in the file'
    find matching underscore-named & 0-chunk files instead of falling back to unrelated documents."""
    from starlette.testclient import TestClient
    from backend.main import app
    from backend.agents.knowledge_agent import KnowledgeAgent
    from backend.agents.models import Capability
    from backend.chat.service import ChatService, DeterministicTestAnswerer, InMemoryConversationStore
    from backend.chat.models import ChatRequest
    from backend.integrations.files.company_data_service import CompanyDataService
    import backend.local_agent.service as local_agent_svc

    monkeypatch.setenv("VERCEL", "1")
    isolated_store = LocalAgentStore(dsn="", persistence_file=tmp_path / "matrix_store.json")
    isolated_service = LocalAgentService(store=isolated_store)
    monkeypatch.setattr(local_agent_svc, "_store", isolated_store)
    monkeypatch.setattr(local_agent_svc, "_service_instance", isolated_service)
    CompanyDataService.clear_registry()

    client = TestClient(app)
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "admin@company"})
    assert login_resp.status_code == 200
    headers = {"Authorization": f"Bearer {login_resp.json()['access_token']}"}
    pair_data = client.post("/api/local-agent/token", headers=headers).json()
    pair_tok = pair_data["token"]
    admin_uid = pair_data["user_id"]
    agent_headers = {"Authorization": f"Bearer {pair_tok}"}

    # Sync: 05_Safety/Training_Matrix.xlsx (with underscore filename), an unextracted 0-chunk binary PDF
    # named Site_Training_Matrix.pdf, and a tail document containing only the word "training"
    sync_resp = client.post(
        "/api/local-agent/sync",
        headers=agent_headers,
        json={
            "folder_id": "browser://companydata_bridge_construction",
            "folder_path": "companydata_bridge_construction",
            "display_name": "companydata_bridge_construction",
            "files": [
                {
                    "relative_path": "05_Safety/Training_Matrix.xlsx",
                    "filename": "Training_Matrix.xlsx",
                    "folder_name": "companydata_bridge_construction",
                    "file_type": "xlsx",
                    "size_bytes": 1024,
                    "chunk_count": 1,
                },
                {
                    "relative_path": "05_Safety/Site_Training_Matrix.pdf",
                    "filename": "Site_Training_Matrix.pdf",
                    "folder_name": "companydata_bridge_construction",
                    "file_type": "pdf",
                    "size_bytes": 2048,
                    "chunk_count": 0,
                },
                {
                    "relative_path": "CompanyData/Customers/client_onboarding_process.docx",
                    "filename": "client_onboarding_process.docx",
                    "folder_name": "companydata_bridge_construction",
                    "file_type": "docx",
                    "size_bytes": 512,
                    "chunk_count": 1,
                },
            ],
            "chunks": [
                {
                    "chunk_id": "tm-1",
                    "relative_path": "05_Safety/Training_Matrix.xlsx",
                    "filename": "Training_Matrix.xlsx",
                    "folder_name": "companydata_bridge_construction",
                    "chunk_index": 0,
                    "text": "Employee | Course | Expiry Date\nArjun | Work at Height | 2027-01-10",
                },
                {
                    "chunk_id": "cli-1",
                    "relative_path": "CompanyData/Customers/client_onboarding_process.docx",
                    "filename": "client_onboarding_process.docx",
                    "folder_name": "companydata_bridge_construction",
                    "chunk_index": 0,
                    "text": "Customer onboarding includes portal walkthrough and training session.",
                },
            ],
            "replace_all": True,
        },
    )
    assert sync_resp.status_code == 200

    cds = CompanyDataService.for_user("enterprise-tenant", admin_uid)
    cds._last_indexed = 0.0
    cds._chunks = []
    ka = KnowledgeAgent(company_data_service=cds)

    class _SimpleOrchestrator:
        agents = {Capability.KNOWLEDGE: ka}

        def invoke(self, req, forced_capability=None):
            from dataclasses import dataclass

            @dataclass
            class _St:
                response: object
                trace: tuple
                error: str | None = None

            return _St(response=ka.run(req), trace=("knowledge",))

    chat_svc = ChatService(_SimpleOrchestrator(), DeterministicTestAnswerer(), InMemoryConversationStore())
    enterprise_user = UserAttributes(
        user_id=admin_uid,
        tenant_id="enterprise-tenant",
        department="Executive",
        roles=frozenset({"Superior"}),
    )

    # Query 1: Bare capitalized entity query "Training Matrix"
    r1 = chat_svc.ask(enterprise_user, ChatRequest("Training Matrix"))
    assert "Work at Height" in r1.answer
    assert r1.file_results
    assert any(f["name"] == "Training_Matrix.xlsx" for f in r1.file_results)

    # Query 2: "Training Matrix find this in the file" must prioritize Training Matrix files & preserve subpath!
    r2 = chat_svc.ask(enterprise_user, ChatRequest("Training Matrix find this in the file"))
    assert r2.file_results
    names = [f["name"] for f in r2.file_results]
    assert "Training_Matrix.xlsx" in names
    assert "Site_Training_Matrix.pdf" in names
    assert "client_onboarding_process.docx" not in names
    tm_entry = next(f for f in r2.file_results if f["name"] == "Training_Matrix.xlsx")
    assert tm_entry["path"] == "companydata_bridge_construction/05_Safety/Training_Matrix.xlsx"
    CompanyDataService.clear_registry()


def test_status_self_heals_zero_file_count_from_chunks_and_catalog(tmp_path):
    """Status and sync must never report 0 files when chunks or catalog entries exist."""
    import json

    persist_file = tmp_path / "heal_store.json"
    store = LocalAgentStore(dsn="", persistence_file=persist_file)
    svc = LocalAgentService(store=store)

    # 1. Simulate split/chunk-only upload with files=[]
    payload = FolderSyncPayload(
        folder_id="companydata_bridge_construction",
        folder_path="companydata_bridge_construction",
        display_name="companydata_bridge_construction",
        files=[],
        chunks=[
            LocalChunkRecord(
                chunk_id="c-1",
                relative_path="CompanyData/Projects/weekly_progress.csv",
                filename="weekly_progress.csv",
                folder_name="companydata_bridge_construction",
                text="W35,PRJ-CFL-002,49,51,-2",
            ),
            LocalChunkRecord(
                chunk_id="c-2",
                relative_path="CompanyData/HR/attendance_002.csv",
                filename="attendance_002.csv",
                folder_name="companydata_bridge_construction",
                text="Emp,Status\nE1,Present",
            ),
        ],
        replace_all=True,
    )
    svc.sync_folder("t1", "u1", payload)
    st = svc.get_status("t1", "u1")
    assert st.total_files == 2
    assert st.total_chunks == 2
    assert st.connected_folders[0].file_count == 2

    # 2. Simulate legacy persisted state where file_count was stored as 0 alongside chunks
    raw = json.loads(persist_file.read_text(encoding="utf-8"))
    for entry in raw:
        for folder_meta in entry.get("folders", {}).values():
            folder_meta["file_count"] = 0
    persist_file.write_text(json.dumps(raw), encoding="utf-8")

    reloaded_store = LocalAgentStore(dsn="", persistence_file=persist_file)
    reloaded_st = LocalAgentService(store=reloaded_store).get_status("t1", "u1")
    assert reloaded_st.total_files == 2
    assert reloaded_st.connected_folders[0].file_count == 2


def test_search_chunks_ranks_exact_code_over_partial_numeric_filename_noise(tmp_path):
    """Querying compound ID like PRJ-CFL-002 must not return *_002.csv files lacking PRJ/CFL."""
    store = LocalAgentStore(dsn="", persistence_file=tmp_path / "code_store.json")
    store.sync_folder(
        "t1",
        "u1",
        FolderSyncPayload(
            folder_id="companydata_bridge_construction",
            folder_path="companydata_bridge_construction",
            display_name="companydata_bridge_construction",
            files=[
                {
                    "relative_path": "CompanyData/HR/05_Attendance_CSV/attendance_002.csv",
                    "filename": "attendance_002.csv",
                    "folder_name": "companydata_bridge_construction",
                    "file_type": "csv",
                },
                {
                    "relative_path": "CompanyData/HR/04_Employee_CSV/employee_data_002.csv",
                    "filename": "employee_data_002.csv",
                    "folder_name": "companydata_bridge_construction",
                    "file_type": "csv",
                },
                {
                    "relative_path": "CompanyData/Projects/05_Tasks_CSV/tasks_002.csv",
                    "filename": "tasks_002.csv",
                    "folder_name": "companydata_bridge_construction",
                    "file_type": "csv",
                },
                {
                    "relative_path": "CompanyData/Projects/weekly_progress.csv",
                    "filename": "weekly_progress.csv",
                    "folder_name": "companydata_bridge_construction",
                    "file_type": "csv",
                },
            ],
            chunks=[
                LocalChunkRecord(
                    chunk_id="att-002",
                    relative_path="CompanyData/HR/05_Attendance_CSV/attendance_002.csv",
                    filename="attendance_002.csv",
                    folder_name="companydata_bridge_construction",
                    text="Date,Emp_ID,Status\n" + "\n".join(f"2026-01-{i:02d},EMP-002,Present" for i in range(1, 25)),
                ),
                LocalChunkRecord(
                    chunk_id="wp-1",
                    relative_path="CompanyData/Projects/weekly_progress.csv",
                    filename="weekly_progress.csv",
                    folder_name="companydata_bridge_construction",
                    text="Week,Project,Physical %,Planned %,Variance\nW35,PRJ-CFL-002,49,51,-2\nW36,PRJ-CFL-002,52,53,-1",
                ),
            ],
            replace_all=True,
        ),
    )

    hits = store.search_chunks("t1", "u1", "PRJ-CFL-002", top_k=5)
    hit_names = [h.filename for h in hits]
    assert hit_names == ["weekly_progress.csv"]


def test_chat_service_recovers_refusal_on_exact_match_and_hides_files_on_genuine_refusal(monkeypatch, tmp_path):
    """Never show matching files beneath a refusal, and recover grounded rows if LLM over-refuses."""
    from dataclasses import dataclass
    from backend.agents.models import Capability
    from backend.chat.service import ChatService, InMemoryConversationStore
    from backend.chat.models import ChatRequest
    from backend.integrations.files.company_data_service import CompanyDataService
    import backend.local_agent.service as local_agent_svc

    monkeypatch.setenv("VERCEL", "1")
    isolated_store = LocalAgentStore(dsn="", persistence_file=tmp_path / "chat_refusal_store.json")
    isolated_service = LocalAgentService(store=isolated_store)
    monkeypatch.setattr(local_agent_svc, "_store", isolated_store)
    monkeypatch.setattr(local_agent_svc, "_service_instance", isolated_service)
    CompanyDataService.clear_registry()

    isolated_service.sync_folder(
        "enterprise-tenant",
        "usr-arjun",
        FolderSyncPayload(
            folder_id="companydata_bridge_construction",
            folder_path="companydata_bridge_construction",
            display_name="companydata_bridge_construction",
            chunks=[
                LocalChunkRecord(
                    chunk_id="wp-cfl",
                    relative_path="CompanyData/Projects/weekly_progress.csv",
                    filename="weekly_progress.csv",
                    folder_name="companydata_bridge_construction",
                    text="Week,Project,Physical %,Planned %,Variance\nW35,PRJ-CFL-002,49,51,-2",
                ),
            ],
            replace_all=True,
        ),
    )

    cds = CompanyDataService.for_tenant("enterprise-tenant")
    cds._last_indexed = 0.0
    cds._chunks = []
    ka = KnowledgeAgent(company_data_service=cds)

    class _SimpleOrchestrator:
        agents = {Capability.KNOWLEDGE: ka}

        def invoke(self, req, forced_capability=None):
            @dataclass
            class _St:
                response: object
                trace: tuple
                error: str | None = None

            return _St(response=ka.run(req), trace=("knowledge",))

    class _OverRefusingAnswerer:
        def answer(self, context):
            return "I couldn't find sufficiently relevant information in the authorized documents to answer this question."

    chat_svc = ChatService(_SimpleOrchestrator(), _OverRefusingAnswerer(), InMemoryConversationStore())
    enterprise_user = UserAttributes(
        user_id="usr-arjun",
        tenant_id="enterprise-tenant",
        department="Executive",
        roles=frozenset({"Superior"}),
    )

    # 1. Exact code match exists -> recovers grounded rows instead of returning refusal!
    res_hit = chat_svc.ask(enterprise_user, ChatRequest("PRJ-CFL-002"))
    assert "couldn't find" not in res_hit.answer.lower()
    assert "PRJ-CFL-002" in res_hit.answer
    assert "49,51,-2" in res_hit.answer
    assert res_hit.file_results
    assert any(f["name"] == "weekly_progress.csv" for f in res_hit.file_results)

    # 2. Genuine missing entity -> refusal answer MUST NOT attach contradictory file_results!
    res_miss = chat_svc.ask(enterprise_user, ChatRequest("PRJ-NONEXISTENT-999"))
    assert "couldn't find" in res_miss.answer.lower()
    assert res_miss.file_results is None
    CompanyDataService.clear_registry()


def test_rate_limit_isolates_authenticated_users_behind_shared_office_ip(monkeypatch):
    """100+ users behind a shared corporate IP must not exhaust each other's rate-limit quota."""
    from starlette.testclient import TestClient
    import backend.main as main_mod
    from backend.security.rate_limiting import InMemoryFixedWindowRateLimiter

    limiter = InMemoryFixedWindowRateLimiter(max_requests=2, window_seconds=60)
    monkeypatch.setattr(main_mod, "_rate_limiter", limiter)

    client = TestClient(main_mod.app)
    shared_headers = {"x-real-ip": "203.0.113.50"}

    # User A makes 2 calls (hits user:A limit on 3rd)
    assert client.get("/api/local-agent/status", headers={**shared_headers, "Authorization": "Bearer tok-user-a"}).status_code != 429
    assert client.get("/api/local-agent/status", headers={**shared_headers, "Authorization": "Bearer tok-user-a"}).status_code != 429
    assert client.get("/api/local-agent/status", headers={**shared_headers, "Authorization": "Bearer tok-user-a"}).status_code == 429

    # User B from the SAME IP is isolated and succeeds
    assert client.get("/api/local-agent/status", headers={**shared_headers, "Authorization": "Bearer tok-user-b"}).status_code != 429

    # Background sync bucket for User A is isolated from User A's interactive chat/status bucket
    assert client.post(
        "/api/local-agent/sync",
        headers={**shared_headers, "Authorization": "Bearer tok-user-a"},
        json={},
    ).status_code != 429

    # Unauthenticated auth endpoint stays IP-limited
    client.post("/api/auth/login", headers=shared_headers, json={"username": "x", "password": "y"})
    client.post("/api/auth/login", headers=shared_headers, json={"username": "x", "password": "y"})
    assert client.post("/api/auth/login", headers=shared_headers, json={"username": "x", "password": "y"}).status_code == 429


def test_desktop_zero_upload_transient_local_context_answers_without_db_storage(monkeypatch, tmp_path):
    """Desktop EXE/MSIX zero-upload mode must answer grounded queries cleanly while saving 0 folder chunks to DB."""
    from starlette.testclient import TestClient
    from backend.main import app
    from backend.api import chat_routes
    from backend.chat.service import DeterministicTestAnswerer
    from backend.integrations.files.company_data_service import CompanyDataService
    import backend.local_agent.service as local_agent_svc

    monkeypatch.setenv("VERCEL", "1")
    isolated_store = LocalAgentStore(dsn="", persistence_file=tmp_path / "empty_desktop_store.json")
    isolated_service = LocalAgentService(store=isolated_store)
    monkeypatch.setattr(local_agent_svc, "_store", isolated_store)
    monkeypatch.setattr(local_agent_svc, "_service_instance", isolated_service)
    CompanyDataService.clear_registry()
    svc = chat_routes.get_chat_service()
    monkeypatch.setattr(svc, "_answerer", DeterministicTestAnswerer())

    client = TestClient(app)
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "admin@company"})
    assert login_resp.status_code == 200
    headers = {"Authorization": f"Bearer {login_resp.json()['access_token']}"}

    local_ctx_payload = {
        "local_context": {
            "folder_path": "C:\\Users\\Arjun\\CompanyData",
            "files": [
                {
                    "name": "weekly_progress.csv",
                    "path": "C:\\Users\\Arjun\\CompanyData\\Projects\\weekly_progress.csv",
                    "full_path": "C:\\Users\\Arjun\\CompanyData\\Projects\\weekly_progress.csv",
                    "type": "csv",
                    "content_snippet": "W35,PRJ-CFL-002,49,51,-2",
                }
            ],
            "chunks": [
                {
                    "chunk_id": "desk-cfl-1",
                    "folder_path": "C:\\Users\\Arjun\\CompanyData",
                    "relative_path": "Projects/weekly_progress.csv",
                    "filename": "weekly_progress.csv",
                    "citation": "C:\\Users\\Arjun\\CompanyData\\Projects\\weekly_progress.csv",
                    "text": "Week,Project,Physical %,Planned %,Variance\nW35,PRJ-CFL-002,49,51,-2",
                }
            ],
        }
    }

    # 1. Knowledge Q&A uses transient local chunks cleanly without saving into LocalAgentStore
    chat_resp = client.post(
        "/api/chat",
        headers=headers,
        json={"query": "PRJ-CFL-002", "rag_enabled": True, "context_override": local_ctx_payload},
    )
    assert chat_resp.status_code == 200
    data = chat_resp.json()
    assert "PRJ-CFL-002" in data["answer"]
    assert data["file_results"]
    assert any(
        f["path"] == "C:\\Users\\Arjun\\CompanyData\\Projects\\weekly_progress.csv"
        for f in data["file_results"]
    )

    # 2. Targeted local file search uses transient local files cleanly
    fs_resp = client.post(
        "/api/chat/file-search",
        headers=headers,
        json={
            "query": "weekly_progress",
            "source": "local",
            "local_files": local_ctx_payload["local_context"]["files"],
        },
    )
    assert fs_resp.status_code == 200
    assert fs_resp.json()["files"][0]["path"] == "C:\\Users\\Arjun\\CompanyData\\Projects\\weekly_progress.csv"

    # 3. Verify 0 folder files or chunks were stored in backend/DB store
    st = isolated_service.get_status("enterprise-tenant", "admin")
    assert st.total_files == 0
    assert st.total_chunks == 0
    CompanyDataService.clear_registry()


def test_two_created_web_accounts_have_strictly_isolated_folder_spaces(monkeypatch, tmp_path):
    """Two created accounts within the same enterprise tenant must never see, search,
    preview, overwrite, or disconnect each other's connected web folders."""
    from starlette.testclient import TestClient
    from backend.main import app
    from backend.integrations.files.company_data_service import CompanyDataService
    from backend.security.local_accounts import LocalAccountStore
    import backend.api.local_auth_routes as local_auth_routes
    import backend.local_agent.service as local_agent_svc

    monkeypatch.setenv("VERCEL", "1")
    isolated_store = LocalAgentStore(dsn="", persistence_file=tmp_path / "multi_user_agent_store.json")
    isolated_service = LocalAgentService(store=isolated_store)
    monkeypatch.setattr(local_agent_svc, "_store", isolated_store)
    monkeypatch.setattr(local_agent_svc, "_service_instance", isolated_service)

    account_store = LocalAccountStore(dsn="", sqlite_path=tmp_path / "accounts.sqlite3")
    account_store.create_account(
        tenant_id="enterprise-tenant",
        username="user_alpha",
        password="AlphaPassword123!",
        role="Supervisor",
        display_name="Alice Alpha",
        email="alice@company.local",
        department="Finance",
    )
    account_store.create_account(
        tenant_id="enterprise-tenant",
        username="user_beta",
        password="BetaPassword123!",
        role="Supervisor",
        display_name="Bob Beta",
        email="bob@company.local",
        department="Engineering",
    )
    monkeypatch.setattr(local_auth_routes, "_check_uecp_status", lambda **_kwargs: None)
    app.dependency_overrides[local_auth_routes.get_local_account_store] = lambda: account_store
    CompanyDataService.clear_registry()

    try:
        client = TestClient(app)

        tok_a = client.post(
            "/api/auth/login",
            json={"username": "user_alpha", "password": "AlphaPassword123!"},
        )
        assert tok_a.status_code == 200, tok_a.text
        headers_a = {"Authorization": f"Bearer {tok_a.json()['access_token']}"}

        tok_b = client.post(
            "/api/auth/login",
            json={"username": "user_beta", "password": "BetaPassword123!"},
        )
        assert tok_b.status_code == 200, tok_b.text
        headers_b = {"Authorization": f"Bearer {tok_b.json()['access_token']}"}

        # 1. Account A connects AliceDocs via Web sync (replace_all=True)
        pair_a = client.post("/api/local-agent/token", headers=headers_a).json()["token"]
        sync_a = client.post(
            "/api/local-agent/sync",
            headers={"Authorization": f"Bearer {pair_a}"},
            json={
                "folder_id": "browser://AliceDocs",
                "folder_path": "BrowserFolder/AliceDocs",
                "display_name": "AliceDocs",
                "files": [
                    {
                        "relative_path": "alice_budget.txt",
                        "filename": "alice_budget.txt",
                        "folder_name": "AliceDocs",
                        "file_type": "txt",
                        "size_bytes": 80,
                        "chunk_count": 1,
                    }
                ],
                "chunks": [
                    {
                        "chunk_id": "alice-1",
                        "relative_path": "alice_budget.txt",
                        "filename": "alice_budget.txt",
                        "folder_name": "AliceDocs",
                        "chunk_index": 0,
                        "text": "ALICE_PRIVATE_SECRET_CODE_9981 Q4 treasury allocation.",
                    }
                ],
                "replace_all": True,
            },
        )
        assert sync_a.status_code == 200, sync_a.text

        # Account A sees AliceDocs cleanly
        st_a = client.get("/api/local-agent/status", headers=headers_a).json()
        assert len(st_a["connected_folders"]) == 1
        assert st_a["connected_folders"][0]["display_name"] == "AliceDocs"
        assert client.get("/api/settings/company-folder", headers=headers_a).json()["exists"] is True

        # 2. Account B (same enterprise-tenant) MUST have a completely empty folder space
        st_b = client.get("/api/local-agent/status", headers=headers_b).json()
        assert st_b["connected_folders"] == []
        assert st_b["total_files"] == 0
        assert st_b["total_chunks"] == 0

        cf_b = client.get("/api/settings/company-folder", headers=headers_b).json()
        assert cf_b["exists"] is False
        assert cf_b["path"] == ""
        assert cf_b["file_count"] == 0

        search_b = client.post(
            "/api/local-agent/search",
            headers=headers_b,
            json={"query": "ALICE_PRIVATE_SECRET_CODE_9981", "top_k": 5},
        ).json()
        assert search_b["total_hits"] == 0
        assert search_b["chunks"] == []

        fs_b = client.post(
            "/api/chat/file-search",
            headers=headers_b,
            json={"query": "alice_budget", "source": "local"},
        ).json()
        assert all("alice_budget" not in str(f.get("name", "")).lower() for f in fs_b.get("files", []))

        prev_b = client.get(
            "/api/local-agent/document-content?path=AliceDocs/alice_budget.txt",
            headers=headers_b,
        )
        assert prev_b.status_code == 200
        assert "ALICE_PRIVATE_SECRET_CODE_9981" not in prev_b.text

        # 3. Account B connects its own BobDocs (replace_all=True) -> MUST NOT overwrite AliceDocs!
        pair_b = client.post("/api/local-agent/token", headers=headers_b).json()["token"]
        sync_b = client.post(
            "/api/local-agent/sync",
            headers={"Authorization": f"Bearer {pair_b}"},
            json={
                "folder_id": "browser://BobDocs",
                "folder_path": "BrowserFolder/BobDocs",
                "display_name": "BobDocs",
                "files": [
                    {
                        "relative_path": "bob_specs.txt",
                        "filename": "bob_specs.txt",
                        "folder_name": "BobDocs",
                        "file_type": "txt",
                        "size_bytes": 60,
                        "chunk_count": 1,
                    }
                ],
                "chunks": [
                    {
                        "chunk_id": "bob-1",
                        "relative_path": "bob_specs.txt",
                        "filename": "bob_specs.txt",
                        "folder_name": "BobDocs",
                        "chunk_index": 0,
                        "text": "BOB_ONLY_SPEC_7742 structural girder calculations.",
                    }
                ],
                "replace_all": True,
            },
        )
        assert sync_b.status_code == 200, sync_b.text

        # Account B sees ONLY BobDocs
        st_b2 = client.get("/api/local-agent/status", headers=headers_b).json()
        assert [f["display_name"] for f in st_b2["connected_folders"]] == ["BobDocs"]
        assert client.post(
            "/api/local-agent/search",
            headers=headers_b,
            json={"query": "ALICE_PRIVATE_SECRET_CODE_9981", "top_k": 5},
        ).json()["total_hits"] == 0

        # Account A STILL sees ONLY AliceDocs (not wiped by Account B's replace_all!)
        st_a2 = client.get("/api/local-agent/status", headers=headers_a).json()
        assert [f["display_name"] for f in st_a2["connected_folders"]] == ["AliceDocs"]
        assert client.post(
            "/api/local-agent/search",
            headers=headers_a,
            json={"query": "BOB_ONLY_SPEC_7742", "top_k": 5},
        ).json()["total_hits"] == 0

        # 4. Disconnecting BobDocs MUST NOT disconnect AliceDocs
        del_b = client.delete(
            "/api/local-agent/folders?folder_path=browser%3A%2F%2FBobDocs",
            headers=headers_b,
        )
        assert del_b.status_code == 200
        assert client.get("/api/local-agent/status", headers=headers_b).json()["connected_folders"] == []
        assert client.get("/api/settings/company-folder", headers=headers_b).json()["exists"] is False

        st_a3 = client.get("/api/local-agent/status", headers=headers_a).json()
        assert [f["display_name"] for f in st_a3["connected_folders"]] == ["AliceDocs"]
        assert client.get("/api/settings/company-folder", headers=headers_a).json()["exists"] is True
    finally:
        app.dependency_overrides.pop(local_auth_routes.get_local_account_store, None)
        CompanyDataService.clear_registry()

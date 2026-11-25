import os
import pytest
from starlette.testclient import TestClient

from backend.main import app
from backend.security.local_accounts import get_local_account_store
from backend.support.ticket_store import get_support_ticket_store
from backend.integrations.email.user_account_service import get_user_email_account_service


def test_ticket_store_serverless_resilience(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    store = get_support_ticket_store()
    ticket = store.create_ticket(
        reporter_id="admin",
        reporter_name="System Admin",
        reporter_email="admin@company.com",
        reporter_role="Admin",
        category="General",
        severity="Low",
        subject="Resilience check",
        description="Verify ticket persistence on serverless",
    )
    assert ticket["id"].startswith("TICK-")
    assert isinstance(ticket["created_at"], str)

    tickets = store.list_tickets()
    assert len(tickets) >= 1
    assert any(t["id"] == ticket["id"] for t in tickets)


def test_email_disconnect_serverless_resilience(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    service = get_user_email_account_service()
    # Disconnect should not raise OSError on read-only file system
    res = service.disconnect_account("admin")
    assert res is True


def test_api_endpoints_resilience(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    client = TestClient(app)

    # 1. Login as admin
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "admin@company"})
    assert login_resp.status_code == 200, login_resp.text
    token = login_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # 2. GET /api/admin/overview -> must be 200
    overview_resp = client.get("/api/admin/overview", headers=headers)
    assert overview_resp.status_code == 200, overview_resp.text
    data = overview_resp.json()
    assert "total_users" in data
    assert "total_tickets" in data

    # 3. GET /api/admin/tickets -> must be 200
    tickets_resp = client.get("/api/admin/tickets", headers=headers)
    assert tickets_resp.status_code == 200, tickets_resp.text
    assert isinstance(tickets_resp.json(), list)

    # 4. POST /api/support/tickets with short description -> must be 201 (not 422)
    short_ticket_resp = client.post(
        "/api/support/tickets",
        headers=headers,
        json={
            "category": "Bug",
            "severity": "Low",
            "subject": "Hi",
            "description": "Short",
        },
    )
    assert short_ticket_resp.status_code == 201, short_ticket_resp.text
    assert short_ticket_resp.json()["id"].startswith("TICK-")

    # 5. POST /api/email/disconnect -> must be 200 (not 500)
    disconnect_resp = client.post("/api/email/disconnect", headers=headers, json={})
    assert disconnect_resp.status_code == 200, disconnect_resp.text
    assert disconnect_resp.json() == {"status": "disconnected"}


def test_chat_upload_vercel_resilience(monkeypatch, tmp_path):
    import base64
    import tempfile
    from pathlib import Path
    from backend.api.chat_routes import _resolve_upload_fallback_dir
    from backend.integrations.files.company_data_service import CompanyDataService
    from backend.local_agent.store import LocalAgentStore
    import backend.local_agent.service as local_agent_svc

    monkeypatch.setenv("VERCEL", "1")
    assert _resolve_upload_fallback_dir() == Path(tempfile.gettempdir()) / "nanvi_uploads"

    # Isolate LocalAgentStore to a temp JSON file (no external DB needed)
    isolated_store = LocalAgentStore(dsn="", persistence_file=tmp_path / "local_agent_store.json")
    monkeypatch.setattr(local_agent_svc, "_store", isolated_store)
    CompanyDataService.clear_registry()

    client = TestClient(app)
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "admin@company"})
    assert login_resp.status_code == 200, login_resp.text
    token = login_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    sample_text = "Quarterly revenue reached $4.2M with 18% YoY growth in enterprise renewals."
    payload = {
        "filename": "vercel_q4_notes.txt",
        "content_base64": base64.b64encode(sample_text.encode("utf-8")).decode("ascii"),
    }
    resp = client.post("/api/chat/upload", headers=headers, json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert body["filename"] == "vercel_q4_notes.txt"
    assert body["path"] == "Uploads/vercel_q4_notes.txt"

    # Re-uploading the same file should replace chunks rather than duplicating them
    resp2 = client.post("/api/chat/upload", headers=headers, json=payload)
    assert resp2.status_code == 200, resp2.text

    # Verify chunks were persisted in LocalAgentStore and loaded strictly into the uploader's CompanyDataService
    import jwt as _jwt
    admin_uid = str(_jwt.decode(token, options={"verify_signature": False})["sub"])
    cds = CompanyDataService.for_user("enterprise-tenant", admin_uid)
    matching = [c for c in cds.chunks if c.filename == "vercel_q4_notes.txt"]
    assert len(matching) == 1
    assert "4.2M" in matching[0].content
    other_user_cds = CompanyDataService.for_user("enterprise-tenant", "usr-other")
    assert not any(c.filename == "vercel_q4_notes.txt" for c in other_user_cds.chunks)

    # Preview endpoint must return 200 (not 500 from MutableHeaders.pop) and serve the uploaded file
    preview_resp = client.get("/api/local-agent/document-content?path=Uploads/vercel_q4_notes.txt", headers=headers)
    assert preview_resp.status_code == 200, preview_resp.text
    assert "X-Frame-Options" not in preview_resp.headers

    # Summarization / analysis prompt mentioning a filename must route to Knowledge Q&A, not File Search
    from backend.retrieval.intent import classify_retrieval_intent, QueryIntent
    from backend.chat.service import ChatService
    from backend.agents.knowledge_agent import KnowledgeAgent
    from backend.agents.models import AgentRequest
    from backend.security.authorization import UserAttributes
    from backend.security.authorization.rbac import Role

    summarize_prompt = "Please analyze the attached document (vercel_q4_notes.txt) and summarize its key findings."
    assert classify_retrieval_intent(summarize_prompt) == QueryIntent.KNOWLEDGE_QA
    assert ChatService._is_file_search_query(summarize_prompt) is False

    user_attrs = UserAttributes(
        user_id=admin_uid,
        tenant_id="enterprise-tenant",
        roles=frozenset({Role.ADMIN}),
        department="Executive",
    )
    ka = KnowledgeAgent(company_data_service=cds)
    ka_resp = ka.run(AgentRequest("req-1", user_attrs, summarize_prompt, active_document_id="vercel_q4_notes.txt"))
    assert ka_resp.deterministic is False
    assert "4.2M" in ka_resp.content
    assert "Found **1** matching document" not in ka_resp.content

    CompanyDataService.clear_registry()


def test_vercel_security_and_isolation_hardening(monkeypatch, tmp_path):
    from backend.integrations.files.company_data_service import CompanyDataService
    from backend.local_agent.models import FolderSyncPayload, LocalChunkRecord
    from backend.local_agent.store import LocalAgentStore
    import backend.local_agent.service as local_agent_svc
    from backend.api.routes import _probe_storage

    monkeypatch.setenv("VERCEL", "1")
    isolated_store = LocalAgentStore(dsn="", persistence_file=tmp_path / "local_agent_store.json")
    monkeypatch.setattr(local_agent_svc, "_store", isolated_store)
    CompanyDataService.clear_registry()

    client = TestClient(app)

    # 1. Unauthenticated access to local-agent document/control routes must be rejected
    assert client.get("/api/local-agent/document-content?path=/proc/self/environ").status_code == 401
    assert client.get("/api/local-agent/document-download?path=.env").status_code == 401
    assert client.post("/api/local-agent/open-file", json={"file_path": "C:\\Windows\\notepad.exe"}).status_code == 401
    assert client.post("/api/local-agent/browse-folder").status_code == 401

    # 2. Hardcoded dev agent tokens must be rejected on Vercel
    assert client.post(
        "/api/local-agent/heartbeat",
        headers={"Authorization": "Bearer nanvi-local-token"},
        json={"agent_version": "1.0.0", "folders": []},
    ).status_code == 401

    # 3. Authenticated traversal or .env read must be blocked
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "admin@company"})
    assert login_resp.status_code == 200, login_resp.text
    headers = {"Authorization": f"Bearer {login_resp.json()['access_token']}"}
    assert client.get("/api/local-agent/document-content?path=../../.env", headers=headers).status_code == 400
    env_probe = client.get("/api/local-agent/document-content?path=.env", headers=headers)
    assert env_probe.status_code == 200
    assert "GROQ_API_KEY" not in env_probe.text

    # 4. Settings company-folder must never return '.' or repo file count when unconfigured
    folder_resp = client.get("/api/settings/company-folder", headers=headers)
    assert folder_resp.status_code == 200, folder_resp.text
    assert folder_resp.json()["path"] != "."
    assert folder_resp.json()["exists"] is False

    # 5. Storage probe on Vercel must use /tmp and report 'up'
    assert _probe_storage()["status"] == "up"

    # 6. Cross-tenant isolation in LocalAgentStore
    isolated_store.sync_folder(
        "tenant-alpha",
        "user-a",
        FolderSyncPayload(
            folder_id="alpha-docs",
            folder_path="/tmp/alpha",
            display_name="Alpha Docs",
            chunks=[
                LocalChunkRecord(
                    chunk_id="alpha-1",
                    relative_path="secret.txt",
                    filename="secret.txt",
                    folder_name="Alpha Docs",
                    text="Alpha confidential merger valuation $99M",
                )
            ],
        ),
    )
    assert isolated_store.get_all_files("tenant-beta", "user-b") == []
    assert isolated_store.search_chunks("tenant-beta", "user-b", "Alpha confidential") == []
    assert len(isolated_store.search_chunks("tenant-alpha", "user-a", "Alpha confidential")) == 1

    CompanyDataService.clear_registry()


def test_local_account_store_contextmanager_does_not_double_yield_on_query_error():
    """Exceptions raised inside `with store._connect()` must propagate cleanly,
    never triggering `RuntimeError: generator didn't stop after throw()`."""
    from contextlib import contextmanager
    from backend.security.local_accounts import LocalAccountStore

    exited_with_exc: list[type | None] = []

    class FakePgConn:
        pass

    class FakePool:
        @contextmanager
        def connection(self, timeout=4):
            try:
                yield FakePgConn()
            except BaseException as exc:
                exited_with_exc.append(type(exc))
                raise
            else:
                exited_with_exc.append(None)

    store = LocalAccountStore(dsn="", sqlite_path=":memory:")
    store._dsn = "postgresql://user:pass@localhost:5432/db"
    store._pool = FakePool()

    with pytest.raises(ValueError, match="simulated query error"):
        with store._connect() as conn:
            assert isinstance(conn, FakePgConn)
            raise ValueError("simulated query error")

    assert exited_with_exc == [ValueError]


def test_user_log_store_contextmanager_does_not_double_yield_on_query_error():
    """UserLogStore._connect() must not swallow caller exceptions or double-yield."""
    from contextlib import contextmanager
    from backend.logs.store import UserLogStore

    exited_with_exc: list[type | None] = []

    class FakePgConn:
        pass

    class FakePool:
        @contextmanager
        def connection(self, timeout=4):
            try:
                yield FakePgConn()
            except BaseException as exc:
                exited_with_exc.append(type(exc))
                raise
            else:
                exited_with_exc.append(None)

    store = UserLogStore(dsn="", sqlite_path=":memory:")
    store._dsn = "postgresql://user:pass@localhost:5432/db"
    store._pool = FakePool()

    with pytest.raises(ValueError, match="simulated log query error"):
        with store._connect() as conn:
            assert isinstance(conn, FakePgConn)
            raise ValueError("simulated log query error")

    assert exited_with_exc == [ValueError]

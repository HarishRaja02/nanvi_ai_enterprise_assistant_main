from __future__ import annotations

from starlette.testclient import TestClient

from backend.chat.models import ChatRequest
from backend.chat.query_refiner import refine_query
from backend.chat.vocabulary_biasing import WHISPER_BIASING_PROMPT
from backend.main import app


def test_query_refiner_fixes_nanvi_phonetic_mishearings_in_assistant_context():
    cases = [
        ("hi nandi", "hi Nanvi"),
        ("Hey Nandi, show me overdue invoices", "Hey Nanvi, show me overdue invoices"),
        ("nandi find proposal documents", "Nanvi find proposal documents"),
        ("ok nandi check emails", "ok Nanvi check emails"),
        ("what is nandi assistant", "what is Nanvi assistant"),
        ("nanbi search proposl files", "Nanvi search proposal files"),
        ("show all invoics and documnts", "show all invoices and documents"),
    ]
    for raw, expected in cases:
        res = refine_query(raw, mode="chat")
        assert res.refined_query == expected
        assert res.is_corrected is True


def test_query_refiner_protects_legitimate_entities_files_and_ordinary_words():
    # Legitimate Nandi entities/places/people/files must NOT be overwritten to Nanvi
    unchanged_cases = [
        "find invoice for Nandi Traders",
        "show directions to Nandi Hills",
        "open Nandi_Invoice.pdf",
        "Mr. Nandi submitted an expense report",
        "search emails from Nandi Logistics",
        "check `nandi` config value and INV-001",
        "Find invoice for Ganesh",
        "Check landing page and handy summary",
    ]
    for raw in unchanged_cases:
        res = refine_query(raw, mode="chat")
        assert res.refined_query == raw
        assert res.is_corrected is False

    # If the user's connected workspace actually has a file named Nandi, protect it even in ambiguous phrasing
    local_ctx = {"files": [{"name": "Nandi_Summary.pdf", "path": "Finance/Nandi_Summary.pdf"}]}
    protected_res = refine_query("hi nandi", mode="chat", local_context=local_ctx)
    assert protected_res.refined_query == "hi nandi"
    assert protected_res.is_corrected is False


def test_whisper_biasing_prompt_includes_nanvi():
    assert "Nanvi" in WHISPER_BIASING_PROMPT


def test_chat_refine_endpoint_and_voice_refine_mode():
    client = TestClient(app)
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "admin@company"})
    assert login_resp.status_code == 200
    token = login_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    refine_resp = client.post(
        "/api/chat/refine",
        headers=headers,
        json={"query": "hey nandi list proposl documnts"},
    )
    assert refine_resp.status_code == 200
    data = refine_resp.json()
    assert data["refined_query"] == "hey Nanvi list proposal documents"
    assert data["is_corrected"] is True

    # Real entity stays unchanged
    safe_resp = client.post(
        "/api/chat/refine",
        headers=headers,
        json={"query": "show invoices from Nandi Traders"},
    )
    assert safe_resp.status_code == 200
    assert safe_resp.json()["refined_query"] == "show invoices from Nandi Traders"
    assert safe_resp.json()["is_corrected"] is False


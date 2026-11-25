from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from backend.main import app
from backend.security.authorization import UserAttributes
from backend.security.authorization.rbac import Role
from backend.chat.models import ChatMessage, ChatRequest
from backend.chat.stores import InMemoryConversationStore
from backend.api.chat_routes import get_chat_service, current_attributes
from backend.chat.service import ChatService, DeterministicTestAnswerer
from backend.agents.orchestrator import EnterpriseOrchestrator


@pytest.fixture
def auth_user():
    return UserAttributes("test-user-api", "tenant-test", "Engineering", frozenset({Role.EMPLOYEE}))


@pytest.fixture
def other_user():
    return UserAttributes("other-user-api", "tenant-test", "Engineering", frozenset({Role.EMPLOYEE}))


def test_api_chat_history_delete_endpoint(auth_user: UserAttributes, other_user: UserAttributes):
    store = InMemoryConversationStore()
    orchestrator = EnterpriseOrchestrator()
    answerer = DeterministicTestAnswerer()
    service = ChatService(orchestrator, answerer, store)

    app.dependency_overrides[get_chat_service] = lambda: service
    app.dependency_overrides[current_attributes] = lambda: auth_user

    try:
        client = TestClient(app)

        # 1. Ask a question to create a conversation
        res = service.ask(auth_user, ChatRequest("API test question"))
        cid = res.conversation_id
        assert cid

        # Verify it appears in /chat/history
        resp = client.get("/chat/history")
        assert resp.status_code == 200
        history_cids = [c["conversation_id"] for c in resp.json()["conversations"]]
        assert cid in history_cids

        # 2. Try deleting other user's conversation (create one first)
        other_cid = "other-conv-123"
        store.bind_owner(other_cid, other_user.user_id, other_user.tenant_id)
        from datetime import datetime, timezone
        store.append(other_cid, ChatMessage("user", "other msg", datetime.now(timezone.utc)))

        # Deleting another user's conversation should return 404
        del_other = client.delete(f"/chat/history/{other_cid}")
        assert del_other.status_code == 404

        # 3. Delete user's own conversation
        del_resp = client.delete(f"/chat/history/{cid}")
        assert del_resp.status_code == 200
        assert del_resp.json() == {"deleted": True, "conversation_id": cid}

        # Verify it no longer appears in /chat/history
        resp2 = client.get("/chat/history")
        assert resp2.status_code == 200
        history_cids2 = [c["conversation_id"] for c in resp2.json()["conversations"]]
        assert cid not in history_cids2

        # 4. Clear all history endpoint
        res2 = service.ask(auth_user, ChatRequest("Second question"))
        assert len(service.history(auth_user)) >= 1

        clear_resp = client.delete("/chat/history")
        assert clear_resp.status_code == 200
        assert clear_resp.json()["deleted"] is True
        assert len(service.history(auth_user)) == 0
    finally:
        app.dependency_overrides.clear()


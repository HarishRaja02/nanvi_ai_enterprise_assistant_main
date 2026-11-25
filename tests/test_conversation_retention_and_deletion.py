from __future__ import annotations

from datetime import datetime, timezone, timedelta
import pytest

from backend.agents.orchestrator import EnterpriseOrchestrator
from backend.chat.models import ChatMessage, ChatRequest
from backend.chat.service import ChatService, DeterministicTestAnswerer
from backend.chat.stores import InMemoryConversationStore
from backend.security.authorization import UserAttributes
from backend.security.authorization.rbac import Role


@pytest.fixture
def test_user() -> UserAttributes:
    return UserAttributes("user-1", "tenant-alpha", "Engineering", frozenset({Role.EMPLOYEE}))


@pytest.fixture
def other_user() -> UserAttributes:
    return UserAttributes("user-2", "tenant-alpha", "Engineering", frozenset({Role.EMPLOYEE}))


def test_30_day_rolling_memory_retention(test_user: UserAttributes):
    """Verify that conversations within 30 days are retained and loaded,
    while conversations older than 30 days expire one by one based on their dates.
    """
    store = InMemoryConversationStore()
    now = datetime.now(timezone.utc)

    # 1. Active conversation within 30 days (e.g. 5 days ago)
    c_recent = "conv-recent-5d"
    store.bind_owner(c_recent, test_user.user_id, test_user.tenant_id)
    store.append(c_recent, ChatMessage("user", "Recent question", now - timedelta(days=5)))
    store.append(c_recent, ChatMessage("assistant", "Recent answer", now - timedelta(days=5)))

    # 2. Conversation near cutoff (29 days ago - should still be retained)
    c_boundary = "conv-boundary-29d"
    store.bind_owner(c_boundary, test_user.user_id, test_user.tenant_id)
    store.append(c_boundary, ChatMessage("user", "Boundary question", now - timedelta(days=29)))
    store.append(c_boundary, ChatMessage("assistant", "Boundary answer", now - timedelta(days=29)))

    # 3. Expired conversation (31 days ago - older than 1 month, should naturally expire)
    c_expired = "conv-expired-31d"
    store.bind_owner(c_expired, test_user.user_id, test_user.tenant_id)
    store.append(c_expired, ChatMessage("user", "Old expired question", now - timedelta(days=31)))
    store.append(c_expired, ChatMessage("assistant", "Old expired answer", now - timedelta(days=31)))

    # Check listing: only the 2 recent conversations should be returned
    summaries = store.list_for_user(test_user.user_id, test_user.tenant_id)
    returned_cids = [s.conversation_id for s in summaries]

    assert c_recent in returned_cids
    assert c_boundary in returned_cids
    assert c_expired not in returned_cids

    # Check direct get: expired conversation returns empty tuple
    assert len(store.get(c_recent)) == 2
    assert len(store.get(c_boundary)) == 2
    assert len(store.get(c_expired)) == 0


def test_user_chat_deletion_and_isolation(test_user: UserAttributes, other_user: UserAttributes):
    """Verify that a user can delete their own conversation, but cannot delete another user's chat."""
    orchestrator = EnterpriseOrchestrator()
    answerer = DeterministicTestAnswerer()
    store = InMemoryConversationStore()
    service = ChatService(orchestrator, answerer, store)

    # User 1 asks a question
    res1 = service.ask(test_user, ChatRequest("Hello, how are you?"))
    cid1 = res1.conversation_id
    assert cid1

    # User 2 asks a question
    res2 = service.ask(other_user, ChatRequest("Another question from user 2"))
    cid2 = res2.conversation_id
    assert cid2

    # User 2 cannot delete User 1's conversation
    with pytest.raises(PermissionError):
        service.delete_conversation(other_user, cid1)

    # User 1 successfully deletes their own conversation
    deleted = service.delete_conversation(test_user, cid1)
    assert deleted is True

    # User 1's history no longer contains cid1
    summaries = service.history(test_user)
    assert not any(s.conversation_id == cid1 for s in summaries)
    assert store.get(cid1) == ()

    # User 2's conversation is still intact
    assert len(store.get(cid2)) > 0


def test_user_deletion_preserves_tier1_audit_log(test_user: UserAttributes, tmp_path):
    """Verify that deleting a user's conversation strictly preserves the
    Tier 1 audit / turn inspection logs in UserLogStore, allowing Tier 1 accounts
    to inspect the turn history even after user deletion.
    """
    from backend.logs.store import UserLogStore
    import backend.logs.store as log_module

    # Configure a fresh local SQLite store for testing audit preservation
    test_db_path = tmp_path / "test_user_logs.sqlite3"
    custom_log_store = UserLogStore(dsn="", sqlite_path=test_db_path)
    original_store = log_module._user_log_store
    log_module._user_log_store = custom_log_store

    try:
        orchestrator = EnterpriseOrchestrator()
        answerer = DeterministicTestAnswerer()
        store = InMemoryConversationStore()
        service = ChatService(orchestrator, answerer, store)

        # 1. Ask a query (which triggers background recording to UserLogStore)
        prompt_text = "What is the company policy?"
        res = service.ask(test_user, ChatRequest(prompt_text))
        cid = res.conversation_id
        assert cid

        # Wait briefly for background logging thread to persist the entry
        import time
        time.sleep(0.5)

        # Confirm the log entry exists in Tier 1 UserLogStore
        logs, total = custom_log_store.get_logs()
        matching_logs = [l for l in logs if l.query == prompt_text]
        assert len(matching_logs) >= 1
        recorded_entry = matching_logs[0]
        assert recorded_entry.user_id == test_user.user_id
        assert recorded_entry.query == prompt_text
        assert recorded_entry.answer == res.answer

        # 2. User deletes their chat session from their personal view
        deleted = service.delete_conversation(test_user, cid)
        assert deleted is True

        # Verify the conversation is gone from user conversation store
        assert store.get(cid) == ()
        assert not any(s.conversation_id == cid for s in service.history(test_user))

        # 3. CRITICAL: Verify that the Tier 1 audit log STILL exists and was NOT deleted!
        logs_after, total_after = custom_log_store.get_logs()
        matching_logs_after = [l for l in logs_after if l.query == prompt_text]
        assert len(matching_logs_after) >= 1
        assert matching_logs_after[0].id == recorded_entry.id
        assert matching_logs_after[0].answer == res.answer

    finally:
        log_module._user_log_store = original_store
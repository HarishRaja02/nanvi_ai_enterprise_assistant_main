from fastapi.testclient import TestClient
from backend.main import app

def test_chat_searches_gmail_and_files():
    client = TestClient(app)
    t_resp = client.post(
        "/api/dev/token",
        json={"role": "CEO", "department": "Executive"},
    )
    assert t_resp.status_code == 200
    token = t_resp.json()["access_token"]

    chat_resp = client.post(
        "/api/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={"query": "What is the status of Project Phoenix and what did Rahul send in email?"},
    )
    assert chat_resp.status_code == 200
    data = chat_resp.json()
    print("\nCAPABILITY:", data.get("capability"))
    print("\nANSWER:\n", data.get("answer"))
    print("\nSOURCES:\n", data.get("sources"))
    assert "Sprint 24" in data["answer"] or "Rahul Patel" in data["answer"] or "Phoenix" in data["answer"]
    assert any(s.get("source_type") == "email" or "email" in str(s) for s in data["sources"])


def test_check_recent_email_and_update_me_routes_to_email_not_local_files():
    client = TestClient(app)
    t_resp = client.post(
        "/api/dev/token",
        json={"role": "CEO", "department": "Executive"},
    )
    assert t_resp.status_code == 200
    token = t_resp.json()["access_token"]

    # Even if context_override has local_context with files/chunks,
    # the query "check my recent email and update me" must retrieve emails, not local files!
    chat_resp = client.post(
        "/api/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "query": "check my recent email and update me",
            "context_override": {
                "local_context": {
                    "chunks": [
                        {
                            "citation": "H:\\PDF\\STUDY PDF\\EXP_1 updated (1).docx",
                            "text": "if (input.value.match(validRegex)) { alert('Valid email address!'); }",
                        }
                    ],
                    "files": [
                        {
                            "name": "EXP_1 updated (1).docx",
                            "path": "H:\\PDF\\STUDY PDF\\EXP_1 updated (1).docx",
                        }
                    ],
                }
            },
        },
    )
    assert chat_resp.status_code == 200
    data = chat_resp.json()
    # It must NOT return "Found matching records in your local folder" or JavaScript regex snippets
    assert "Valid email address" not in data["answer"]
    assert "Found matching records in your local folder" not in data["answer"]
    # It must return email information (recent emails table or mailbox briefing)
    assert "email" in data["answer"].casefold()
    assert any("email" in s.get("source_type", "").casefold() or "email" in str(s).casefold() for s in data.get("sources", [])) or "recent email" in data["answer"].casefold()


def test_find_recent_maile_from_the_outlook_targets_provider_not_sender():
    client = TestClient(app)
    t_resp = client.post(
        "/api/dev/token",
        json={"role": "CEO", "department": "Executive"},
    )
    assert t_resp.status_code == 200
    token = t_resp.json()["access_token"]

    chat_resp = client.post(
        "/api/chat",
        headers={"Authorization": f"Bearer {token}"},
        json={"query": "find my recent maile from the outlook"},
    )
    assert chat_resp.status_code == 200
    data = chat_resp.json()
    # It must NOT say "No emails from the outlook were found" (which treats outlook as sender)
    assert "from **the outlook**" not in data["answer"]
    assert "from **outlook**" not in data["answer"]
    # Capability should be email_search
    assert data.get("capability") == "email_search"


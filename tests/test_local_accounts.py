from __future__ import annotations

import pytest
import jwt
from fastapi import HTTPException

from types import SimpleNamespace

from backend.api import local_auth_routes
from backend.api.local_auth_routes import AccountCreateRequest, LocalLoginRequest, create_local_account, list_local_accounts, local_login
from backend.security.authorization.rbac import Role
from backend.security.local_accounts import LocalAccountStore
from backend.security.models import UserIdentity


@pytest.fixture
def account_store(tmp_path) -> LocalAccountStore:
    return LocalAccountStore(sqlite_path=tmp_path / "accounts.sqlite3")


def test_local_account_password_is_hashed_and_role_must_match(account_store: LocalAccountStore) -> None:
    account = account_store.create_account(
        tenant_id="tenant-a",
        username="project.user",
        password="a-long-and-unique-password",
        role=Role.PROJECT_ENGINEER.value,
        display_name="Project User",
        department="Engineering",
    )

    assert "password_hash" not in account
    assert "password_salt" not in account
    assert account_store.authenticate("PROJECT.USER", "a-long-and-unique-password", Role.PROJECT_ENGINEER.value, "tenant-a")
    assert account_store.authenticate("project.user", "wrong-password", Role.PROJECT_ENGINEER.value, "tenant-a") is None
    assert account_store.authenticate("project.user", "a-long-and-unique-password", Role.EMPLOYEE.value, "tenant-a") is None


def test_supervisor_can_manage_lower_roles_but_cannot_create_supervisor(
    account_store: LocalAccountStore,
) -> None:
    supervisor = UserIdentity(
        subject="supervisor-id",
        issuer="nanvi-local",
        tenant_id="tenant-a",
        roles=frozenset({Role.SUPERVISOR}),
    )
    created = create_local_account(
        AccountCreateRequest(
            username="engineer",
            password="a-unique-engineer-password",
            role=Role.PROJECT_ENGINEER.value,
            display_name="Engineer One",
            email="engineer.one@company.com",
        ),
        user=supervisor,
        store=account_store,
    )
    assert created.role == Role.PROJECT_ENGINEER.value

    with pytest.raises(HTTPException) as exc:
        create_local_account(
            AccountCreateRequest(
                username="new-supervisor",
                password="a-unique-supervisor-password",
                role=Role.SUPERVISOR.value,
                display_name="New Supervisor",
                email="supervisor@company.com",
            ),
            user=supervisor,
            store=account_store,
        )
    assert exc.value.status_code == 403


def test_superior_can_list_accounts_without_secret_fields(account_store: LocalAccountStore) -> None:
    account_store.create_account(
        tenant_id="tenant-a",
        username="employee",
        password="an-employee-account-password",
        role=Role.EMPLOYEE.value,
        display_name="Employee One",
    )
    superior = UserIdentity(
        subject="superior-id",
        issuer="nanvi-local",
        tenant_id="tenant-a",
        roles=frozenset({Role.SUPERIOR}),
    )

    accounts = list_local_accounts(user=superior, store=account_store)

    assert [account.username for account in accounts] == ["employee"]
    assert not hasattr(accounts[0], "password_hash")


def test_local_login_signs_the_stored_role_and_rejects_a_mismatched_role(
    account_store: LocalAccountStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account_store.create_account(
        tenant_id="enterprise-tenant",
        username="engineer",
        password="a-unique-engineer-password",
        role=Role.PROJECT_ENGINEER.value,
        display_name="Engineer One",
    )
    monkeypatch.setattr(
        local_auth_routes,
        "settings",
        SimpleNamespace(local_auth_enabled=True, jwt_secret="unit-test-secret-at-least-32-bytes-long", local_auth_tenant_id="enterprise-tenant"),
    )

    response = local_login(
        LocalLoginRequest(username="engineer", password="a-unique-engineer-password", role=Role.PROJECT_ENGINEER.value),
        store=account_store,
    )
    claims = jwt.decode(response["access_token"], "unit-test-secret-at-least-32-bytes-long", algorithms=["HS256"], audience="nanvi-local", issuer="nanvi-local")
    assert claims["roles"] == [Role.PROJECT_ENGINEER.value]
    assert claims["sub"]

    with pytest.raises(HTTPException) as exc:
        local_login(
            LocalLoginRequest(username="engineer", password="a-unique-engineer-password", role=Role.SUPERVISOR.value),
            store=account_store,
        )
    assert exc.value.status_code == 401


def test_local_login_role_mismatch_hint_only_on_valid_password(
    account_store: LocalAccountStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account_store.create_account(
        tenant_id="enterprise-tenant",
        username="harishraja02",
        password="ValidPassword123!",
        role=Role.SUPERVISOR.value,
        display_name="Harish Raja",
        allow_short_password=True,
    )
    monkeypatch.setattr(
        local_auth_routes,
        "settings",
        SimpleNamespace(
            local_auth_enabled=True,
            jwt_secret="unit-test-secret-at-least-32-bytes-long",
            local_auth_tenant_id="enterprise-tenant",
            is_production=False,
        ),
    )

    # Correct password with wrong selected role -> 401 with clear role guidance
    with pytest.raises(HTTPException) as exc_mismatch:
        local_login(
            LocalLoginRequest(username="harishraja02", password="ValidPassword123!", role=Role.SUPERIOR.value),
            store=account_store,
        )
    assert exc_mismatch.value.status_code == 401
    assert "Supervisor" in str(exc_mismatch.value.detail)

    # Wrong password with wrong role -> generic 401 (no role enumeration)
    with pytest.raises(HTTPException) as exc_wrong_pw:
        local_login(
            LocalLoginRequest(username="harishraja02", password="WrongPassword", role=Role.SUPERIOR.value),
            store=account_store,
        )
    assert exc_wrong_pw.value.status_code == 401
    assert "Supervisor" not in str(exc_wrong_pw.value.detail)


def test_postgres_dsn_never_silently_wiped_on_vercel_failure(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """In production with a configured Postgres DSN, failures must not erase self._dsn to /tmp SQLite."""
    import backend.security.local_accounts as local_accounts_mod

    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setattr(
        local_accounts_mod,
        "settings",
        SimpleNamespace(
            is_production=True,
            is_development=False,
            is_demo=False,
            database_pool_min_size=1,
            database_pool_max_size=2,
            local_auth_tenant_id="enterprise-tenant",
        ),
    )
    store = LocalAccountStore(
        dsn="postgresql://user:pass@127.0.0.1:1/nonexistent_db",
        sqlite_path=tmp_path / "fallback.sqlite3",
    )
    # Pool failed in __init__, _dsn must remain intact and raise RuntimeError on connect
    assert store._dsn.startswith("postgresql://")


def test_user_id_and_name_validation(account_store: LocalAccountStore) -> None:
    # Username with spaces must fail
    with pytest.raises(ValueError, match="spaces"):
        account_store.create_account(
            tenant_id="tenant-a",
            username="john doe",
            password="a-valid-secure-password",
            role=Role.EMPLOYEE.value,
            display_name="John Doe",
        )

    # Username with invalid special characters must fail
    with pytest.raises(ValueError, match="User ID can only contain"):
        account_store.create_account(
            tenant_id="tenant-a",
            username="john@doe!",
            password="a-valid-secure-password",
            role=Role.EMPLOYEE.value,
            display_name="John Doe",
        )

    # Invalid display name with symbols/numbers must fail
    with pytest.raises(ValueError, match="Name can only contain alphabetic"):
        account_store.create_account(
            tenant_id="tenant-a",
            username="johndoe",
            password="a-valid-secure-password",
            role=Role.EMPLOYEE.value,
            display_name="John123 Doe$$",
        )

    # Valid account creation
    acc = account_store.create_account(
        tenant_id="tenant-a",
        username="john.doe-99",
        password="a-valid-secure-password",
        role=Role.EMPLOYEE.value,
        display_name="John O'Connor-Smith",
    )
    assert acc["username"] == "john.doe-99"
    assert acc["display_name"] == "John O'Connor-Smith"


def test_department_customization_and_persistence(account_store: LocalAccountStore) -> None:
    # Adding a department explicitly
    depts = account_store.add_department("tenant-a", "Quantum Computing")
    assert "Quantum Computing" in depts

    # Creating an account with a new department automatically records it
    account_store.create_account(
        tenant_id="tenant-a",
        username="alice.researcher",
        password="a-valid-secure-password",
        role=Role.PROJECT_ENGINEER.value,
        display_name="Alice Researcher",
        department="Robotics & AI",
    )
    all_depts = account_store.list_departments("tenant-a")
    assert "Robotics & AI" in all_depts
    assert "Quantum Computing" in all_depts


def test_account_creation_sends_email_with_credentials_and_reset(
    account_store: LocalAccountStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.api.local_auth_routes import AccountCreateRequest, create_local_account
    import backend.security.mailer as mailer_mod

    sent_emails = []
    def mock_send(to_email, recipient_name, username, password, reset_link):
        sent_emails.append({
            "to_email": to_email,
            "recipient_name": recipient_name,
            "username": username,
            "password": password,
            "reset_link": reset_link,
        })
        return True

    monkeypatch.setattr(mailer_mod, "send_account_creation_email", mock_send)

    superior = UserIdentity(
        subject="superior-id",
        issuer="nanvi-local",
        tenant_id="tenant-a",
        roles=frozenset({Role.SUPERIOR}),
    )

    created = create_local_account(
        AccountCreateRequest(
            username="charlie.brown",
            password="temporary-password-123",
            role=Role.EMPLOYEE.value,
            display_name="Charlie Brown",
            email="charlie@company.com",
            department="Operations",
        ),
        user=superior,
        store=account_store,
    )
    assert created.username == "charlie.brown"
    assert len(sent_emails) == 1
    assert sent_emails[0]["to_email"] == "charlie@company.com"
    assert sent_emails[0]["username"] == "charlie.brown"
    assert sent_emails[0]["password"] == "temporary-password-123"
    assert "token=" in sent_emails[0]["reset_link"]


def test_account_creation_requires_email(
    account_store: LocalAccountStore,
) -> None:
    from backend.api.local_auth_routes import AccountCreateRequest, create_local_account

    superior = UserIdentity(
        subject="superior-id",
        issuer="nanvi-local",
        tenant_id="tenant-a",
        roles=frozenset({Role.SUPERIOR}),
    )

    with pytest.raises(HTTPException) as exc:
        create_local_account(
            AccountCreateRequest(
                username="no.email.user",
                password="a-valid-secure-password",
                role=Role.EMPLOYEE.value,
                display_name="No Email User",
                email="   ",
            ),
            user=superior,
            store=account_store,
        )
    assert exc.value.status_code == 400
    assert "email" in str(exc.value.detail).lower()


def test_update_and_revoke_account(
    account_store: LocalAccountStore,
) -> None:
    from backend.api.local_auth_routes import AccountUpdateRequest, update_local_account

    superior = UserIdentity(
        subject="superior-id",
        issuer="nanvi-local",
        tenant_id="tenant-a",
        roles=frozenset({Role.SUPERIOR}),
    )

    acc = account_store.create_account(
        tenant_id="tenant-a",
        username="dave.wilson",
        password="a-valid-secure-password",
        role=Role.EMPLOYEE.value,
        display_name="Dave Wilson",
        department="Finance",
    )
    assert acc["active"] in (True, 1)

    # Revoke account
    revoked = update_local_account(
        account_id=acc["id"],
        body=AccountUpdateRequest(active=False),
        user=superior,
        store=account_store,
    )
    assert revoked.active is False
    # Revoked account cannot log in
    assert account_store.authenticate("dave.wilson", "a-valid-secure-password", None, "tenant-a") is None

    # Update details and un-revoke
    updated = update_local_account(
        account_id=acc["id"],
        body=AccountUpdateRequest(
            display_name="David Wilson",
            department="Global Finance",
            active=True,
        ),
        user=superior,
        store=account_store,
    )
    assert updated.display_name == "David Wilson"
    assert updated.department == "Global Finance"
    assert updated.active is True
    # Can log in again
    assert account_store.authenticate("dave.wilson", "a-valid-secure-password", None, "tenant-a") is not None


def test_supervisor_can_create_and_normalize_tier5_intern_account(
    account_store: LocalAccountStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.api.local_auth_routes import AccountUpdateRequest, update_local_account

    monkeypatch.setattr("backend.security.mailer.send_account_creation_email", lambda **_: True)
    supervisor = UserIdentity(
        subject="supervisor-id",
        issuer="nanvi-local",
        tenant_id="tenant-a",
        roles=frozenset({Role.SUPERVISOR}),
    )

    created = create_local_account(
        AccountCreateRequest(
            username="intern.one",
            password="a-unique-intern-password",
            role="Tier 5",
            display_name="Intern One",
            email="intern.one@company.com",
        ),
        user=supervisor,
        store=account_store,
    )
    assert created.role == Role.INTERN.value

    assert account_store.authenticate("intern.one", "a-unique-intern-password", Role.INTERN.value, "tenant-a") is not None
    assert local_auth_routes.normalize_role("Intern / Trainee") == Role.INTERN.value

    updated = update_local_account(
        account_id=created.id,
        body=AccountUpdateRequest(role="Tier 4"),
        user=supervisor,
        store=account_store,
    )
    assert updated.role == Role.EMPLOYEE.value




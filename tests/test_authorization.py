import pytest

from backend.security.authorization import (
    AuthorizationService,
    Permission,
    Resource,
    Role,
    UserAttributes,
)


TENANT_A = "tenant-a"
TENANT_B = "tenant-b"


def user(
    user_id: str,
    department: str,
    role: Role,
    tenant_id: str = TENANT_A,
) -> UserAttributes:
    return UserAttributes(
        user_id=user_id,
        tenant_id=tenant_id,
        department=department,
        roles=frozenset({role}),
    )


def resource(
    resource_id: str,
    resource_type: str = "document",
    department: str | None = None,
    tenant_id: str = TENANT_A,
    owner_id: str | None = None,
) -> Resource:
    return Resource(
        resource_id=resource_id,
        resource_type=resource_type,
        tenant_id=tenant_id,
        department=department,
        owner_id=owner_id,
    )


@pytest.fixture
def service() -> AuthorizationService:
    return AuthorizationService()


def test_employee_denied_hr_salary_information(service: AuthorizationService) -> None:
    decision = service.authorize(
        user("emp-1", "Engineering", Role.EMPLOYEE),
        Permission.HR_READ,
        resource("salary-1", department="HR"),
    )

    assert decision.allowed is False


def test_finance_allowed_financial_information(service: AuthorizationService) -> None:
    decision = service.authorize(
        user("fin-1", "Finance", Role.FINANCE),
        Permission.FINANCE_READ,
        resource("financial-1", department="Finance"),
    )

    assert decision.allowed is True


def test_finance_denied_hr_information(service: AuthorizationService) -> None:
    decision = service.authorize(
        user("fin-1", "Finance", Role.FINANCE),
        Permission.HR_READ,
        resource("employee-salary-1", department="HR"),
    )

    assert decision.allowed is False


def test_read_and_write_are_separate(service: AuthorizationService) -> None:
    employee = user("emp-1", "Engineering", Role.EMPLOYEE)

    read_decision = service.authorize(
        employee,
        Permission.FILE_READ,
        resource("shared-file"),
    )
    write_decision = service.authorize(
        employee,
        Permission.FILE_WRITE,
        resource("shared-file"),
    )

    assert read_decision.allowed is True
    assert write_decision.allowed is False


def test_resource_level_ownership(service: AuthorizationService) -> None:
    employee = user("emp-1", "Engineering", Role.EMPLOYEE)

    own = service.authorize(
        employee,
        Permission.FILE_READ,
        resource(
            "private-file",
            resource_type="user_file",
            owner_id="emp-1",
        ),
    )
    other = service.authorize(
        employee,
        Permission.FILE_READ,
        resource(
            "private-file-2",
            resource_type="user_file",
            owner_id="emp-2",
        ),
    )

    assert own.allowed is True
    assert other.allowed is False


def test_tenant_isolation(service: AuthorizationService) -> None:
    decision = service.authorize(
        user("emp-1", "Engineering", Role.EMPLOYEE, tenant_id=TENANT_A),
        Permission.FILE_READ,
        resource("tenant-b-file", tenant_id=TENANT_B),
    )

    assert decision.allowed is False
    assert "Tenant" in decision.reason


def test_missing_role_is_denied(service: AuthorizationService) -> None:
    decision = service.authorize(
        UserAttributes(
            user_id="u-1",
            tenant_id=TENANT_A,
            department="Finance",
            roles=frozenset(),
        ),
        Permission.FINANCE_READ,
        resource("financial-1", department="Finance"),
    )

    assert decision.allowed is False


def test_unknown_permission_is_rejected(service: AuthorizationService) -> None:
    with pytest.raises(ValueError):
        service.authorize(
            user("fin-1", "Finance", Role.FINANCE),
            "NOT_A_PERMISSION",
            resource("financial-1", department="Finance"),
        )


def test_tier3_tier4_and_tier5_intern_permissions(service: AuthorizationService) -> None:
    from backend.security.authorization.abac import Resource
    from backend.security.authorization.rbac import LEGACY_ROLE_ALIASES, has_permission

    tier3 = user("pm-1", "Engineering", Role.PROJECT_ENGINEER, tenant_id=TENANT_A)
    tier4 = user("emp-1", "Operations", Role.EMPLOYEE, tenant_id=TENANT_A)
    tier5 = user("intern-1", "Engineering", Role.INTERN, tenant_id=TENANT_A)

    # Aliases map cleanly across Tiers 1-5
    assert LEGACY_ROLE_ALIASES["Intern / Trainee"] == Role.INTERN
    assert LEGACY_ROLE_ALIASES["Project Manager / Team Lead"] == Role.PROJECT_ENGINEER

    # Tier 3 & Tier 4 gain Email, DB read, Web search, and personal Connection permissions
    for role in (Role.PROJECT_ENGINEER, Role.EMPLOYEE):
        assert has_permission(role, Permission.EMAIL_READ) is True
        assert has_permission(role, Permission.DATABASE_READ) is True
        assert has_permission(role, Permission.CONNECTION_WRITE) is True
        assert has_permission(role, Permission.CONNECTION_OWN_MANAGE) is True
        assert has_permission(role, Permission.CONNECTION_ORG_MANAGE) is False
        assert has_permission(role, Permission.FINANCE_READ) is False

    # Tier 5 (Intern) receives only the basic Tier 4 file + report permissions
    assert has_permission(Role.INTERN, Permission.FILE_READ) is True
    assert has_permission(Role.INTERN, Permission.REPORT_CREATE) is True
    assert has_permission(Role.INTERN, Permission.REPORT_DOWNLOAD) is True
    for denied in (
        Permission.EMAIL_READ,
        Permission.DATABASE_READ,
        Permission.WEB_SEARCH,
        Permission.CONNECTION_READ,
        Permission.CONNECTION_WRITE,
        Permission.FINANCE_READ,
        Permission.HR_READ,
    ):
        assert has_permission(Role.INTERN, denied) is False

    # ABAC resource boundaries: Tier 3 gets Contracts & Customers, blocked from Finance
    contracts_doc = Resource(
        resource_id="c-1",
        resource_type="company_file",
        tenant_id=TENANT_A,
        department="Contracts",
        attributes={"restricted_department": "Contracts", "relative_path": "Contracts/msa.pdf"},
    )
    customers_doc = Resource(
        resource_id="cust-1",
        resource_type="company_file",
        tenant_id=TENANT_A,
        department="Customers",
        attributes={"restricted_department": "Customers", "relative_path": "Customers/acme.csv"},
    )
    finance_doc = Resource(
        resource_id="fin-1",
        resource_type="company_file",
        tenant_id=TENANT_A,
        department="Finance",
        attributes={"restricted_department": "Finance", "relative_path": "Finance/inv.pdf"},
    )
    hr_handbook = Resource(
        resource_id="hr-pub",
        resource_type="company_file",
        tenant_id=TENANT_A,
        department="HR",
        attributes={"restricted_department": "HR", "relative_path": "HR/employee_handbook.pdf"},
    )
    hr_salary = Resource(
        resource_id="hr-sal",
        resource_type="company_file",
        tenant_id=TENANT_A,
        department="HR",
        attributes={"restricted_department": "HR", "relative_path": "HR/salary_sheet.xlsx"},
    )
    project_doc = Resource(
        resource_id="proj-1",
        resource_type="company_file",
        tenant_id=TENANT_A,
        department="Projects",
        attributes={"restricted_department": "Projects", "relative_path": "Projects/roadmap.md"},
    )

    assert service.authorize(tier3, Permission.FILE_READ, contracts_doc).allowed is True
    assert service.authorize(tier3, Permission.FILE_READ, customers_doc).allowed is True
    assert service.authorize(tier3, Permission.FILE_READ, finance_doc).allowed is False

    assert service.authorize(tier4, Permission.FILE_READ, contracts_doc).allowed is False
    assert service.authorize(tier4, Permission.FILE_READ, customers_doc).allowed is False

    # Tier 5 Intern gets non-sensitive HR handbook and Projects, denied Contracts/Customers/Salary
    assert service.authorize(tier5, Permission.FILE_READ, project_doc).allowed is True
    assert service.authorize(tier5, Permission.FILE_READ, hr_handbook).allowed is True
    assert service.authorize(tier5, Permission.FILE_READ, hr_salary).allowed is False
    assert service.authorize(tier5, Permission.FILE_READ, contracts_doc).allowed is False
    assert service.authorize(tier5, Permission.FILE_READ, customers_doc).allowed is False
    assert service.authorize(tier5, Permission.EMAIL_READ, resource("mail-1", tenant_id=TENANT_A)).allowed is False

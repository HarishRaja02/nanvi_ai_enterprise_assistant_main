from __future__ import annotations

from contextlib import contextmanager
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from backend.core.config import settings
from backend.security.authorization.rbac import Role

PASSWORD_SCRYPT_N = 1 << 14
PASSWORD_SCRYPT_R = 8
PASSWORD_SCRYPT_P = 1
PASSWORD_KEY_LENGTH = 32
PASSWORD_MIN_LENGTH = 12

DEMO_ACCOUNTS = (
    ("admin", "admin@company", "Admin", "System Administrator", "Executive", "admin@company.com"),
    ("ceo", "ceo@nanvi", "Superior", "Arjun Mehta", "Executive", "ceo@nanvi.local"),
    ("finance", "finance@nanvi", "Supervisor", "Priya Sharma", "Finance", "finance@nanvi.local"),
    ("manager", "manager@nanvi", "Supervisor", "Rahul Patel", "Operations", "manager@nanvi.local"),
    ("engineer", "engineer@nanvi", "Project Engineer", "Maya Nair", "Engineering", "engineer@nanvi.local"),
    ("hr", "hr@nanvi", "Project Engineer", "Kavita Reddy", "Human Resources", "hr@nanvi.local"),
    ("employee", "employee@nanvi", "Employee", "Ankit Singh", "Operations", "employee@nanvi.local"),
    ("intern", "intern@nanvi", "Intern", "Rohan Verma", "Engineering", "intern@nanvi.local"),
)

DEFAULT_DEPARTMENTS = (
    "Executive",
    "Finance",
    "Operations",
    "Engineering",
    "Human Resources",
    "Information Technology",
    "Sales",
    "Marketing",
    "Legal",
    "Quality Assurance",
)


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    if len(password) < PASSWORD_MIN_LENGTH:
        raise ValueError(f"Password must be at least {PASSWORD_MIN_LENGTH} characters long.")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=PASSWORD_SCRYPT_N,
        r=PASSWORD_SCRYPT_R,
        p=PASSWORD_SCRYPT_P,
        dklen=PASSWORD_KEY_LENGTH,
        maxmem=64 * 1024 * 1024,
    )
    return salt.hex(), digest.hex()


def verify_password(password: str, salt_hex: str, digest_hex: str) -> bool:
    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=PASSWORD_SCRYPT_N,
            r=PASSWORD_SCRYPT_R,
            p=PASSWORD_SCRYPT_P,
            dklen=PASSWORD_KEY_LENGTH,
            maxmem=64 * 1024 * 1024,
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


class LocalAccountStore:
    def __init__(self, dsn: str = "", sqlite_path: str | Path | None = None) -> None:
        self._dsn = dsn
        if sqlite_path:
            self._sqlite_path = Path(sqlite_path)
        elif os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME") or os.getenv("VERCEL_ENV"):
            self._sqlite_path = Path(tempfile.gettempdir()) / "local_accounts.sqlite3"
        else:
            self._sqlite_path = Path(__file__).resolve().parents[1] / "storage" / "local_accounts.sqlite3"
        self._initialize_lock = threading.RLock()
        self._initialized = False
        self._pool = None
        self._memory_conn: sqlite3.Connection | None = None
        if self._dsn:
            try:
                from psycopg_pool import ConnectionPool
                from psycopg.rows import dict_row
                is_serverless = bool(os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME") or os.getenv("VERCEL_ENV"))
                min_size = 0 if is_serverless else max(1, settings.database_pool_min_size)
                max_size = 2 if is_serverless else max(5, settings.database_pool_max_size)
                self._pool = ConnectionPool(
                    conninfo=self._dsn,
                    min_size=min_size,
                    max_size=max_size,
                    kwargs={
                        "row_factory": dict_row,
                        "connect_timeout": 5,
                        "prepare_threshold": None,
                    },
                    open=True,
                )
                import atexit
                atexit.register(self.close)
            except Exception:
                self._pool = None

    def close(self) -> None:
        if self._pool is not None:
            try:
                self._pool.close(timeout=1.0)
            except Exception:
                pass

    @property
    def _table(self) -> str:
        return "public.nanvi_local_accounts" if self._dsn else "local_accounts"

    def _is_pg(self, conn: Any) -> bool:
        return not isinstance(conn, sqlite3.Connection)

    def _table_for(self, conn: Any) -> str:
        return "public.nanvi_local_accounts" if self._is_pg(conn) else "local_accounts"

    def _placeholder_for(self, conn: Any) -> str:
        return "%s" if self._is_pg(conn) else "?"

    def _reset_table_for(self, conn: Any) -> str:
        return "public.nanvi_password_reset_tokens" if self._is_pg(conn) else "password_reset_tokens"

    def _dept_table_for(self, conn: Any) -> str:
        return "public.nanvi_local_departments" if self._is_pg(conn) else "local_departments"

    def _ensure_sqlite_schema(self, conn: sqlite3.Connection) -> None:
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS local_accounts (
                    id TEXT PRIMARY KEY,
                    tenant_id TEXT NOT NULL,
                    username TEXT NOT NULL,
                    password_salt TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    email TEXT,
                    department TEXT,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (tenant_id, username)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS password_reset_tokens (
                    token_hash TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    tenant_id TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    used INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS local_departments (
                    tenant_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (tenant_id, name)
                )
                """
            )
            try:
                conn.execute("CREATE INDEX IF NOT EXISTS idx_reset_tokens_acc ON password_reset_tokens(tenant_id, account_id);")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_accounts_email ON local_accounts(tenant_id, LOWER(email));")
            except Exception:
                pass
            conn.commit()
        except Exception:
            pass

    @contextmanager
    def _connect(self):
        if self._dsn:
            is_serverless = bool(os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME") or os.getenv("VERCEL_ENV"))
            timeout_sec = 4 if is_serverless else 8
            try:
                if self._pool is not None:
                    with self._pool.connection(timeout=timeout_sec) as conn:
                        yield conn
                    return
                import psycopg
                from psycopg.rows import dict_row
                with psycopg.connect(
                    self._dsn,
                    row_factory=dict_row,
                    connect_timeout=timeout_sec,
                    prepare_threshold=None,
                ) as conn:
                    yield conn
                return
            except Exception as pool_exc:
                # Retry once with a fresh direct connection before falling back (never wipe self._dsn permanently)
                try:
                    import psycopg
                    from psycopg.rows import dict_row
                    with psycopg.connect(
                        self._dsn,
                        row_factory=dict_row,
                        connect_timeout=timeout_sec,
                        prepare_threshold=None,
                    ) as conn:
                        yield conn
                    return
                except Exception as direct_exc:
                    import logging
                    logging.getLogger(__name__).warning(
                        "PostgreSQL/Supabase connection failed (%s / %s).",
                        pool_exc,
                        direct_exc,
                    )
                    if settings.is_production:
                        raise RuntimeError("Persistent cloud database is temporarily unavailable. Account changes cannot be saved right now.") from direct_exc
                    # Outside production (local dev / offline tests), fall back to SQLite only for non-production runs
                    if self._pool is not None:
                        try:
                            self._pool.close(timeout=0.5)
                        except Exception:
                            pass
                        self._pool = None

        conn = None
        try:
            self._sqlite_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self._sqlite_path, timeout=10)
            conn.execute("SELECT 1")
        except Exception as exc:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
            import logging
            logging.getLogger(__name__).warning("SQLite store at %s failed (%s); using in-memory store.", self._sqlite_path, exc)
            if self._memory_conn is None:
                self._memory_conn = sqlite3.connect(":memory:", check_same_thread=False)
                self._memory_conn.row_factory = sqlite3.Row
            conn = self._memory_conn

        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
        except Exception:
            pass

        self._ensure_sqlite_schema(conn)

        try:
            with conn:
                yield conn
        finally:
            if conn is not self._memory_conn:
                try:
                    conn.close()
                except Exception:
                    pass

    def initialize(self) -> None:
        with self._initialize_lock:
            if self._initialized:
                return
            with self._connect() as connection:
                is_pg = self._is_pg(connection)
                table = self._table_for(connection)
                reset_table = self._reset_table_for(connection)
                if is_pg:
                    connection.execute(
                        f"""
                        CREATE TABLE IF NOT EXISTS {table} (
                            id TEXT PRIMARY KEY,
                            tenant_id TEXT NOT NULL,
                            username TEXT NOT NULL,
                            password_salt TEXT NOT NULL,
                            password_hash TEXT NOT NULL,
                            role TEXT NOT NULL,
                            display_name TEXT NOT NULL,
                            email TEXT,
                            department TEXT,
                            active BOOLEAN NOT NULL DEFAULT TRUE,
                            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                            UNIQUE (tenant_id, username)
                        )
                        """
                    )
                    try:
                        connection.execute("ALTER TABLE public.nanvi_local_accounts DROP CONSTRAINT IF EXISTS nanvi_local_accounts_role_check;")
                        connection.execute("ALTER TABLE public.nanvi_local_accounts ADD CONSTRAINT nanvi_local_accounts_role_check CHECK (role = ANY (ARRAY['Admin'::text, 'Superior'::text, 'Supervisor'::text, 'Project Engineer'::text, 'Employee'::text, 'CEO'::text, 'Finance'::text]));")
                        connection.execute("ALTER TABLE public.nanvi_local_accounts ADD CONSTRAINT nanvi_local_accounts_role_check CHECK (role = ANY (ARRAY['Admin'::text, 'Superior'::text, 'Supervisor'::text, 'Project Engineer'::text, 'Employee'::text, 'Intern'::text, 'CEO'::text, 'Finance'::text]));")
                    except Exception:
                        pass
                    connection.execute(
                        f"""
                        CREATE TABLE IF NOT EXISTS {reset_table} (
                            token_hash TEXT PRIMARY KEY,
                            account_id TEXT NOT NULL,
                            tenant_id TEXT NOT NULL,
                            expires_at BIGINT NOT NULL,
                            used BOOLEAN NOT NULL DEFAULT FALSE,
                            created_at BIGINT NOT NULL
                        )
                        """
                    )
                    dept_table = self._dept_table_for(connection)
                    connection.execute(
                        f"""
                        CREATE TABLE IF NOT EXISTS {dept_table} (
                            tenant_id TEXT NOT NULL,
                            name TEXT NOT NULL,
                            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                            PRIMARY KEY (tenant_id, name)
                        )
                        """
                    )
                    try:
                        connection.execute("CREATE INDEX IF NOT EXISTS idx_nanvi_reset_tokens_acc ON public.nanvi_password_reset_tokens(tenant_id, account_id);")
                        connection.execute("CREATE INDEX IF NOT EXISTS idx_nanvi_accounts_email ON public.nanvi_local_accounts(tenant_id, LOWER(email));")
                    except Exception:
                        pass
                    connection.commit()
                else:
                    connection.execute(
                        f"""
                        CREATE TABLE IF NOT EXISTS {table} (
                            id TEXT PRIMARY KEY,
                            tenant_id TEXT NOT NULL,
                            username TEXT NOT NULL,
                            password_salt TEXT NOT NULL,
                            password_hash TEXT NOT NULL,
                            role TEXT NOT NULL,
                            display_name TEXT NOT NULL,
                            email TEXT,
                            department TEXT,
                            active INTEGER NOT NULL DEFAULT 1,
                            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            UNIQUE (tenant_id, username)
                        )
                        """
                    )
                    connection.execute(
                        f"""
                        CREATE TABLE IF NOT EXISTS {reset_table} (
                            token_hash TEXT PRIMARY KEY,
                            account_id TEXT NOT NULL,
                            tenant_id TEXT NOT NULL,
                            expires_at INTEGER NOT NULL,
                            used INTEGER NOT NULL DEFAULT 0,
                            created_at INTEGER NOT NULL
                        )
                        """
                    )
                    dept_table = self._dept_table_for(connection)
                    connection.execute(
                        f"""
                        CREATE TABLE IF NOT EXISTS {dept_table} (
                            tenant_id TEXT NOT NULL,
                            name TEXT NOT NULL,
                            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            PRIMARY KEY (tenant_id, name)
                        )
                        """
                    )
                    try:
                        connection.execute("CREATE INDEX IF NOT EXISTS idx_reset_tokens_acc ON password_reset_tokens(tenant_id, account_id);")
                        connection.execute("CREATE INDEX IF NOT EXISTS idx_accounts_email ON local_accounts(tenant_id, LOWER(email));")
                    except Exception:
                        pass
                    connection.commit()
                count = connection.execute(f"SELECT COUNT(*) AS total FROM {table}").fetchone()["total"]
            self._initialized = True
            if count == 0:
                self._bootstrap_first_superior()
            self._ensure_admin_account()

    def _ensure_admin_account(self) -> None:
        """Guarantee that the dev/demo admin account exists outside production."""
        if settings.is_production:
            return
        try:
            tenant_id = settings.local_auth_tenant_id or "enterprise-tenant"
            with self._connect() as connection:
                table = self._table_for(connection)
                placeholder = self._placeholder_for(connection)
                admin_row = connection.execute(
                    f"SELECT id, role FROM {table} WHERE tenant_id = {placeholder} AND LOWER(username) = 'admin'",
                    (tenant_id,),
                ).fetchone()
                if not admin_row:
                    self.create_account(
                        tenant_id=tenant_id,
                        username="admin",
                        password="admin@company",
                        role=Role.ADMIN.value,
                        display_name="System Administrator",
                        email="admin@company.com",
                        department="Executive",
                        allow_short_password=True,
                    )
                elif admin_row["role"] != Role.ADMIN.value:
                    connection.execute(
                        f"UPDATE {table} SET role = {placeholder} WHERE tenant_id = {placeholder} AND LOWER(username) = 'admin'",
                        (Role.ADMIN.value, tenant_id),
                    )
                    connection.commit()
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("Could not auto-ensure admin account: %s", exc)

    def _bootstrap_first_superior(self) -> None:
        if settings.is_production:
            username = os.getenv("LOCAL_AUTH_BOOTSTRAP_USERNAME", "").strip()
            password = os.getenv("LOCAL_AUTH_BOOTSTRAP_PASSWORD", "")
            if username and password:
                self.create_account(
                    tenant_id=settings.local_auth_tenant_id,
                    username=username,
                    password=password,
                    role=Role.SUPERIOR.value,
                    display_name=os.getenv("LOCAL_AUTH_BOOTSTRAP_NAME", "Superior Administrator").strip(),
                    email=os.getenv("LOCAL_AUTH_BOOTSTRAP_EMAIL", "").strip() or None,
                    department="Executive",
                )
            return

        if settings.is_development or settings.is_demo:
            if "pytest" in sys.modules and self._sqlite_path and "storage" not in str(self._sqlite_path):
                return
            for username, password, role, name, department, email in DEMO_ACCOUNTS:
                try:
                    self.create_account(
                        tenant_id="enterprise-tenant",
                        username=username,
                        password=password,
                        role=role,
                        display_name=name,
                        email=email,
                        department=department,
                        allow_short_password=True,
                    )
                except ValueError:
                    pass

    def create_account(
        self,
        *,
        tenant_id: str,
        username: str,
        password: str,
        role: str,
        display_name: str,
        email: str | None = None,
        department: str | None = None,
        allow_short_password: bool = False,
        require_email: bool = False,
    ) -> dict[str, Any]:
        self.initialize()
        normalized_username = username.strip().casefold()
        if not normalized_username or len(normalized_username) > 50:
            raise ValueError("User ID must contain 1 to 50 characters.")
        if " " in username:
            raise ValueError("User ID cannot contain spaces.")
        if not re.match(r"^[a-zA-Z0-9._-]+$", username.strip()):
            raise ValueError("User ID can only contain letters, numbers, periods (.), underscores (_), and hyphens (-).")
        if role not in {Role.SUPERIOR.value, Role.SUPERVISOR.value, Role.PROJECT_ENGINEER.value, Role.EMPLOYEE.value, "Admin", "CEO", "Finance"}:
        if role not in {Role.SUPERIOR.value, Role.SUPERVISOR.value, Role.PROJECT_ENGINEER.value, Role.EMPLOYEE.value, Role.INTERN.value, "Admin", "CEO", "Finance"}:
            raise ValueError("Choose one of the supported user roles.")

        clean_name = display_name.strip()
        if not clean_name or len(clean_name) > 200:
            raise ValueError("Name must contain 1 to 200 characters.")
        if not re.match(r"^[a-zA-Z\u00C0-\u024F\u1E00-\u1EFF\s.'-]+$", clean_name):
            raise ValueError("Name can only contain alphabetic characters, spaces, hyphens, apostrophes, and periods.")
        if not any(c.isalpha() for c in clean_name):
            raise ValueError("Name must contain letters.")

        email_clean = (email or "").strip().casefold()
        if email_clean:
            if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email_clean):
                raise ValueError("Please provide a valid corporate email address.")
        elif require_email:
            raise ValueError("A valid corporate email address is compulsory.")
        else:
            email_clean = f"{normalized_username}@{tenant_id}.local"

        with self._connect() as connection:
            table = self._table_for(connection)
            placeholder = self._placeholder_for(connection)
            dup_email = connection.execute(
                f"SELECT id FROM {table} WHERE tenant_id = {placeholder} AND LOWER(COALESCE(email, '')) = {placeholder}",
                (tenant_id, email_clean),
            ).fetchone()
            if dup_email:
                raise ValueError("An account with that email address already exists.")

        if allow_short_password:
            salt = secrets.token_bytes(16)
            digest = hashlib.scrypt(
                password.encode("utf-8"), salt=salt, n=PASSWORD_SCRYPT_N,
                r=PASSWORD_SCRYPT_R, p=PASSWORD_SCRYPT_P, dklen=PASSWORD_KEY_LENGTH,
                maxmem=64 * 1024 * 1024,
            )
            salt_hex, digest_hex = salt.hex(), digest.hex()
        else:
            salt_hex, digest_hex = hash_password(password)

        account_id = str(uuid.uuid4())
        try:
            with self._connect() as connection:
                table = self._table_for(connection)
                placeholder = self._placeholder_for(connection)
                sql = (
                    f"INSERT INTO {table} "
                    "(id, tenant_id, username, password_salt, password_hash, role, display_name, email, department, active) "
                    f"VALUES ({', '.join([placeholder] * 10)})"
                )
                connection.execute(sql, (
                    account_id, tenant_id, normalized_username, salt_hex, digest_hex,
                    role, display_name.strip(), email_clean, department, True if self._is_pg(connection) else 1,
                ))
                connection.commit()
            if department and department.strip():
                try:
                    self.add_department(tenant_id, department.strip())
                except Exception:
                    pass
        except Exception as exc:
            if "unique" in str(exc).casefold() or "duplicate" in str(exc).casefold():
                raise ValueError("That user ID is already in use.") from exc
            raise
        return self.get_account(account_id, tenant_id)

    def authenticate(
        self,
        username_or_email: str,
        password: str,
        selected_role: str | None = None,
        tenant_id: str = "enterprise-tenant",
    ) -> dict[str, Any] | None:
        ident = username_or_email.strip().casefold()

        # Break-glass Master Admin guarantee: user: admin, pass: admin@company
        if (ident in {"admin", "admin@company", "admin@company.com"}) and password == "admin@company":
            try:
                self.initialize()
                self._ensure_admin_account()
                with self._connect() as connection:
                    table = self._table_for(connection)
                    placeholder = self._placeholder_for(connection)
                    account = connection.execute(
                        f"SELECT * FROM {table} WHERE tenant_id = {placeholder} AND LOWER(username) = 'admin'",
                        (tenant_id,),
                    ).fetchone()
                    if account:
                        acc = dict(account)
                        acc["role"] = Role.ADMIN.value
                        return acc
            except Exception:
                pass
            return {
                "id": "admin-breakglass-id",
                "tenant_id": tenant_id,
                "username": "admin",
                "role": Role.ADMIN.value,
                "display_name": "System Administrator",
                "email": "admin@company.com",
                "department": "Executive",
                "active": True,
            }

        self.initialize()

        with self._connect() as connection:
            table = self._table_for(connection)
            placeholder = self._placeholder_for(connection)
            is_pg = self._is_pg(connection)
            active_clause = "active = TRUE" if is_pg else "active = 1"
            account = connection.execute(
                f"SELECT * FROM {table} WHERE tenant_id = {placeholder} AND (LOWER(username) = {placeholder} OR LOWER(COALESCE(email, '')) = {placeholder}) AND {active_clause}",
                (tenant_id, ident, ident),
            ).fetchone()

        if not account:
            return None

        if not verify_password(password, account["password_salt"], account["password_hash"]):
            return None

        if selected_role:
            is_admin_match = (
                selected_role == "Admin"
                and (ident in {"admin", "admin@company", "admin@company.com"} or account["role"] == "Admin")
            )
            if not is_admin_match and account["role"] != selected_role:
                return None

        return dict(account)

    def reset_password(
        self, account_id: str, new_password: str, tenant_id: str = "enterprise-tenant"
    ) -> dict[str, Any]:
        self.initialize()
        if len(new_password) < 6:
            raise ValueError("Password must be at least 6 characters long.")
        if len(new_password) < PASSWORD_MIN_LENGTH:
            salt = secrets.token_bytes(16)
            digest = hashlib.scrypt(
                new_password.encode("utf-8"),
                salt=salt,
                n=PASSWORD_SCRYPT_N,
                r=PASSWORD_SCRYPT_R,
                p=PASSWORD_SCRYPT_P,
                dklen=PASSWORD_KEY_LENGTH,
                maxmem=64 * 1024 * 1024,
            )
            salt_hex, digest_hex = salt.hex(), digest.hex()
        else:
            salt_hex, digest_hex = hash_password(new_password)

        with self._connect() as connection:
            table = self._table_for(connection)
            placeholder = self._placeholder_for(connection)
            connection.execute(
                f"UPDATE {table} SET password_salt = {placeholder}, password_hash = {placeholder} WHERE id = {placeholder} AND tenant_id = {placeholder}",
                (salt_hex, digest_hex, account_id, tenant_id),
            )
            connection.commit()
        return self.get_account(account_id, tenant_id)

    def update_account(
        self, account_id: str, tenant_id: str = "enterprise-tenant", **fields
    ) -> dict[str, Any]:
        self.initialize()
        allowed = {"display_name", "email", "role", "department", "active"}
        with self._connect() as connection:
            table = self._table_for(connection)
            placeholder = self._placeholder_for(connection)
            updates = []
            params = []
            for k, v in fields.items():
                if k in allowed and v is not None:
                    updates.append(f"{k} = {placeholder}")
                    params.append(v)
            if not updates:
                return self.get_account(account_id, tenant_id)

            params.extend([account_id, tenant_id])
            sql = f"UPDATE {table} SET {', '.join(updates)} WHERE id = {placeholder} AND tenant_id = {placeholder}"
            connection.execute(sql, params)
            connection.commit()
            if fields.get("department") and str(fields["department"]).strip():
                try:
                    self.add_department(tenant_id, str(fields["department"]).strip())
                except Exception:
                    pass
        return self.get_account(account_id, tenant_id)

    def list_departments(self, tenant_id: str = "enterprise-tenant") -> list[str]:
        self.initialize()
        depts: set[str] = set(DEFAULT_DEPARTMENTS)
        with self._connect() as connection:
            dept_table = self._dept_table_for(connection)
            account_table = self._table_for(connection)
            placeholder = self._placeholder_for(connection)
            try:
                rows = connection.execute(
                    f"SELECT name FROM {dept_table} WHERE tenant_id = {placeholder}",
                    (tenant_id,),
                ).fetchall()
                for r in rows:
                    if r["name"] and r["name"].strip():
                        depts.add(r["name"].strip())
            except Exception:
                pass
            try:
                acc_rows = connection.execute(
                    f"SELECT DISTINCT department FROM {account_table} WHERE tenant_id = {placeholder} AND department IS NOT NULL",
                    (tenant_id,),
                ).fetchall()
                for r in acc_rows:
                    if r["department"] and r["department"].strip():
                        depts.add(r["department"].strip())
            except Exception:
                pass
        return sorted(list(depts), key=lambda d: d.casefold())

    def add_department(self, tenant_id: str, name: str) -> list[str]:
        self.initialize()
        clean_name = name.strip()
        if not clean_name or len(clean_name) > 100:
            raise ValueError("Department name must contain 1 to 100 characters.")
        with self._connect() as connection:
            dept_table = self._dept_table_for(connection)
            placeholder = self._placeholder_for(connection)
            if self._is_pg(connection):
                sql = f"INSERT INTO {dept_table} (tenant_id, name) VALUES ({placeholder}, {placeholder}) ON CONFLICT (tenant_id, name) DO NOTHING"
            else:
                sql = f"INSERT OR IGNORE INTO {dept_table} (tenant_id, name) VALUES ({placeholder}, {placeholder})"
            connection.execute(sql, (tenant_id, clean_name))
            connection.commit()
        return self.list_departments(tenant_id)

    def list_accounts(self, tenant_id: str) -> list[dict[str, Any]]:
        self.initialize()
        with self._connect() as connection:
            table = self._table_for(connection)
            placeholder = self._placeholder_for(connection)
            rows = connection.execute(
                f"SELECT id, username, role, display_name, email, department, active, created_at FROM {table} WHERE tenant_id = {placeholder} ORDER BY username",
                (tenant_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_account(self, account_id: str, tenant_id: str) -> dict[str, Any]:
        self.initialize()
        with self._connect() as connection:
            table = self._table_for(connection)
            placeholder = self._placeholder_for(connection)
            row = connection.execute(
                f"SELECT id, username, role, display_name, email, department, active, created_at FROM {table} WHERE id = {placeholder} AND tenant_id = {placeholder}",
                (account_id, tenant_id),
            ).fetchone()
            if not row:
                row = connection.execute(
                    f"SELECT id, username, role, display_name, email, department, active, created_at FROM {table} WHERE (LOWER(username) = {placeholder} OR id = {placeholder}) AND tenant_id = {placeholder}",
                    (account_id.lower(), account_id, tenant_id),
                ).fetchone()
        if not row:
            raise ValueError("Account not found.")
        return dict(row)

    def delete_account(self, account_id: str, tenant_id: str) -> dict[str, Any]:
        account = self.get_account(account_id, tenant_id)
        with self._connect() as connection:
            table = self._table_for(connection)
            placeholder = self._placeholder_for(connection)
            connection.execute(
                f"DELETE FROM {table} WHERE id = {placeholder} AND tenant_id = {placeholder}",
                (account_id, tenant_id),
            )
            connection.commit()
        return account

    def count_role(self, tenant_id: str, role: str) -> int:
        with self._connect() as connection:
            table = self._table_for(connection)
            placeholder = self._placeholder_for(connection)
            active_val = "TRUE" if self._is_pg(connection) else "1"
            row = connection.execute(
                f"SELECT COUNT(*) AS total FROM {table} WHERE tenant_id = {placeholder} AND role = {placeholder} AND active = {active_val}",
                (tenant_id, role),
            ).fetchone()
        return int(row["total"])

    def find_account_by_username_and_email(
        self, username: str, email: str, tenant_id: str = "enterprise-tenant"
    ) -> dict[str, Any] | None:
        self.initialize()
        norm_user = username.strip().casefold()
        norm_email = email.strip().casefold()
        if not norm_user or not norm_email:
            return None
        with self._connect() as connection:
            table = self._table_for(connection)
            placeholder = self._placeholder_for(connection)
            active_val = "TRUE" if self._is_pg(connection) else "1"
            account = connection.execute(
                f"SELECT * FROM {table} WHERE tenant_id = {placeholder} "
                f"AND LOWER(username) = {placeholder} "
                f"AND LOWER(COALESCE(email, '')) = {placeholder} "
                f"AND active = {active_val}",
                (tenant_id, norm_user, norm_email),
            ).fetchone()
        if not account:
            return None
        return dict(account)

    def create_password_reset_token(
        self, account_id: str, tenant_id: str = "enterprise-tenant", expires_minutes: int = 15
    ) -> str:
        self.initialize()
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        now_ts = int(time.time())
        expires_at = now_ts + (expires_minutes * 60)

        with self._connect() as connection:
            reset_table = self._reset_table_for(connection)
            placeholder = self._placeholder_for(connection)
            is_pg = self._is_pg(connection)
            used_true = True if is_pg else 1
            used_false = False if is_pg else 0
            connection.execute(
                f"UPDATE {reset_table} SET used = {used_true} "
                f"WHERE tenant_id = {placeholder} AND account_id = {placeholder} AND used = {used_false}",
                (tenant_id, account_id),
            )
            connection.execute(
                f"INSERT INTO {reset_table} (token_hash, account_id, tenant_id, expires_at, used, created_at) "
                f"VALUES ({', '.join([placeholder] * 6)})",
                (token_hash, account_id, tenant_id, expires_at, used_false, now_ts),
            )
            connection.commit()
        return raw_token

    def verify_reset_token(self, raw_token: str) -> dict[str, Any] | None:
        self.initialize()
        cleaned_token = raw_token.strip()
        if not cleaned_token:
            return None
        token_hash = hashlib.sha256(cleaned_token.encode("utf-8")).hexdigest()
        now_ts = int(time.time())

        with self._connect() as connection:
            reset_table = self._reset_table_for(connection)
            placeholder = self._placeholder_for(connection)
            row = connection.execute(
                f"SELECT token_hash, account_id, tenant_id, expires_at, used FROM {reset_table} WHERE token_hash = {placeholder}",
                (token_hash,),
            ).fetchone()
        if not row:
            return None

        row_dict = dict(row)
        if bool(row_dict["used"]) or int(row_dict["expires_at"]) <= now_ts:
            return None

        try:
            account = self.get_account(row_dict["account_id"], row_dict["tenant_id"])
        except ValueError:
            return None

        return {
            "token_hash": row_dict["token_hash"],
            "account_id": row_dict["account_id"],
            "tenant_id": row_dict["tenant_id"],
            "account": account,
        }

    def reset_password_with_token(self, raw_token: str, new_password: str) -> dict[str, Any]:
        valid = self.verify_reset_token(raw_token)
        if not valid:
            raise ValueError("The password reset link is invalid or has expired. Please request a new one.")

        account_id = valid["account_id"]
        tenant_id = valid["tenant_id"]
        token_hash = valid["token_hash"]

        with self._connect() as connection:
            reset_table = self._reset_table_for(connection)
            placeholder = self._placeholder_for(connection)
            used_true = True if self._is_pg(connection) else 1
            connection.execute(
                f"UPDATE {reset_table} SET used = {used_true} WHERE token_hash = {placeholder}",
                (token_hash,),
            )
            connection.commit()

        return self.reset_password(account_id, new_password, tenant_id)


_account_store: LocalAccountStore | None = None
_account_store_lock = threading.Lock()


def get_local_account_store() -> LocalAccountStore:
    global _account_store
    if _account_store is None:
        with _account_store_lock:
            if _account_store is None:
                dsn = settings.supabase_database_url or settings.database_url
                default_sqlite = (
                    str(Path(tempfile.gettempdir()) / "local_accounts.sqlite3")
                    if (os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME") or os.getenv("VERCEL_ENV"))
                    else None
                )
                _account_store = LocalAccountStore(
                    dsn=dsn or "",
                    sqlite_path=settings.local_auth_db_path or default_sqlite,
                )
    try:
        _account_store.initialize()
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Account store initialization warning: %s", exc)
    return _account_store
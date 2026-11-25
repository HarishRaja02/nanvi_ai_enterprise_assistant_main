import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AtSign,
  Ban,
  Building2,
  Calendar,
  CheckCircle2,
  Edit3,
  Eye,
  EyeOff,
  Lock,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Send,
  Shield,
  Trash2,
  User,
  UserPlus,
  X,
} from "lucide-react";
import type {
  LocalAccount,
  LocalAccountCreate,
  LocalAccountRole,
  LocalAccountUpdate,
  NanviApiClient,
  UserIdentity,
} from "../../api";
import { useToast } from "../../components/ui/Toast";

type Props = { api: NanviApiClient; identity: UserIdentity };

const ALL_ROLES: LocalAccountRole[] = ["Superior", "Supervisor", "Project Engineer", "Employee"];
const SUPERVISOR_ROLES: LocalAccountRole[] = ["Project Engineer", "Employee"];
const ALL_ROLES: LocalAccountRole[] = ["Superior", "Supervisor", "Project Engineer", "Employee", "Intern"];
const SUPERVISOR_ROLES: LocalAccountRole[] = ["Project Engineer", "Employee", "Intern"];

export const ROLE_TIER_LABELS: Record<LocalAccountRole, string> = {
  Superior: "Tier 1 (Superior)",
  Supervisor: "Tier 2 (Supervisor)",
  "Project Engineer": "Tier 3 (Project Manager / Project Engineer)",
  Employee: "Tier 4 (Employee)",
  Superior: "Tier 1 — Super Admin / Management",
  Supervisor: "Tier 2 — Manager / Supervisor",
  "Project Engineer": "Tier 3 — Project Manager / Team Lead",
  Employee: "Tier 4 — Employee",
  Intern: "Tier 5 — Intern / Trainee",
  Admin: "Admin Portal",
};

const DEFAULT_DEPARTMENTS = [
  "Engineering",
  "Executive",
  "Finance",
  "Human Resources",
  "Information Technology",
  "Legal",
  "Marketing",
  "Operations",
  "Quality Assurance",
  "Sales",
];

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return "Pre-configured";
  try {
    const normalized = dateStr.includes(" ") && !dateStr.includes("T")
      ? dateStr.replace(" ", "T") + "Z"
      : dateStr;
    const parsed = new Date(normalized);
    if (isNaN(parsed.getTime())) return dateStr;
    return parsed.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export function AccountManagement({ api, identity }: Props) {
  const notify = useToast();
  const isSuperior = identity.roles.includes("Superior") || identity.roles.includes("Admin") || identity.subject === "admin";
  const allowedRoles = isSuperior ? ALL_ROLES : SUPERVISOR_ROLES;

  const [accounts, setAccounts] = useState<LocalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  // Search filter
  const [searchQuery, setSearchQuery] = useState("");

  // Create form state
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [department, setDepartment] = useState("");
  const [role, setRole] = useState<LocalAccountRole>(isSuperior ? "Supervisor" : "Employee");

  // Real-time validation messages
  const [usernameError, setUsernameError] = useState("");
  const [nameError, setNameError] = useState("");
  const [emailError, setEmailError] = useState("");

  // Department customization
  const [departments, setDepartments] = useState<string[]>(DEFAULT_DEPARTMENTS);
  const [showAddDept, setShowAddDept] = useState(false);
  const [newDeptName, setNewDeptName] = useState("");
  const [addingDept, setAddingDept] = useState(false);

  // Table action states
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  // Edit / Update modal state
  const [editingAccount, setEditingAccount] = useState<LocalAccount | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<LocalAccountRole>("Employee");
  const [editDept, setEditDept] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editError, setEditError] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.listLocalAccounts();
      setAccounts(data);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Couldn't load user accounts.";
      setError(msg);
      notify(msg, "danger");
    } finally {
      setLoading(false);
    }
  }, [api, notify]);

  const loadDepartments = useCallback(async () => {
    try {
      if (typeof api.listDepartments === "function") {
        const fetched = await api.listDepartments();
        if (Array.isArray(fetched) && fetched.length > 0) {
          setDepartments(fetched);
          return;
        }
      }
    } catch {
      // Fallback handled below
    }
  }, [api]);

  useEffect(() => {
    void loadAccounts();
    void loadDepartments();
  }, [loadAccounts, loadDepartments]);

  // Synchronize any newly discovered departments from accounts list
  useEffect(() => {
    if (accounts.length > 0) {
      const accountDepts = accounts
        .map((a) => a.department?.trim())
        .filter((d): d is string => Boolean(d));
      if (accountDepts.length > 0) {
        setDepartments((prev) => Array.from(new Set([...prev, ...accountDepts])).sort());
      }
    }
  }, [accounts]);

  // Input sanitization and validation for User ID (prevent spaces and invalid characters)
  const handleUsernameChange = (val: string) => {
    const noSpaces = val.replace(/\s+/g, "");
    const sanitized = noSpaces.replace(/[^a-zA-Z0-9._-]/g, "");
    setUsername(sanitized);
    if (val !== sanitized) {
      setUsernameError("User ID can only contain letters, numbers, periods (.), underscores (_), and hyphens (-). Spaces are not allowed.");
    } else {
      setUsernameError("");
    }
  };

  const handleUsernameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === " ") {
      e.preventDefault();
      setUsernameError("Spaces are not allowed in User ID.");
    }
  };

  // Input sanitization and validation for Name (letters, spaces, hyphens, apostrophes)
  const handleDisplayNameChange = (val: string) => {
    const sanitized = val.replace(/[^a-zA-Z\u00C0-\u024F\u1E00-\u1EFF\s.'-]/g, "");
    setDisplayName(sanitized);
    if (val !== sanitized) {
      setNameError("Name can only contain alphabetic characters, spaces, hyphens, and apostrophes.");
    } else {
      setNameError("");
    }
  };

  // Email validation
  const handleEmailChange = (val: string) => {
    setEmail(val);
    const trimmed = val.trim();
    if (!trimmed) {
      setEmailError("Email ID is required to deliver account credentials.");
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError("Please provide a valid corporate email address.");
    } else {
      setEmailError("");
    }
  };

  // Add a new custom department
  const handleAddDepartment = async () => {
    const clean = newDeptName.trim();
    if (!clean) return;
    setAddingDept(true);
    try {
      if (typeof api.addDepartment === "function") {
        const updated = await api.addDepartment(clean);
        setDepartments(updated);
      } else {
        setDepartments((prev) => Array.from(new Set([...prev, clean])).sort());
      }
      setDepartment(clean);
      setNewDeptName("");
      setShowAddDept(false);
      notify(`Department "${clean}" added successfully.`, "success");
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Couldn't add department.";
      setError(msg);
      notify(msg, "danger");
    } finally {
      setAddingDept(false);
    }
  };

  // Create account submission
  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSuccessMessage("");

    const trimmedUser = username.trim();
    const trimmedName = displayName.trim();
    const trimmedEmail = email.trim();

    if (!trimmedUser) {
      const msg = "User ID is required.";
      setError(msg);
      notify(msg, "danger");
      setSaving(false);
      return;
    }
    if (/\s/.test(trimmedUser)) {
      const msg = "User ID cannot contain spaces.";
      setError(msg);
      notify(msg, "danger");
      setSaving(false);
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmedUser)) {
      const msg = "User ID can only contain letters, numbers, periods (.), underscores (_), and hyphens (-).";
      setError(msg);
      notify(msg, "danger");
      setSaving(false);
      return;
    }
    if (!trimmedName) {
      const msg = "Name is required.";
      setError(msg);
      notify(msg, "danger");
      setSaving(false);
      return;
    }
    if (!trimmedEmail) {
      const msg = "Email ID is required to deliver account credentials.";
      setError(msg);
      notify(msg, "danger");
      setSaving(false);
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      const msg = "Please provide a valid corporate email address.";
      setError(msg);
      notify(msg, "danger");
      setSaving(false);
      return;
    }

    const account: LocalAccountCreate = {
      username: trimmedUser,
      display_name: trimmedName,
      password,
      role,
      email: trimmedEmail,
      department: department.trim() || null,
    };

    try {
      const created = await api.createLocalAccount(account);
      if (created && created.email_dispatched === false) {
        setSuccessMessage(
          `Account "${trimmedUser}" created. Note: SMTP email could not be delivered to ${trimmedEmail} (${created.email_error || "delivery failed"}).`
        );
        notify(
          `Account "@${trimmedUser}" created, but SMTP email delivery failed (${created.email_error || "delivery failed"}).`,
          "warning"
        );
      } else {
        setSuccessMessage(
          `Account "${trimmedUser}" created successfully! An automated email with User ID, password, and password reset link was dispatched to ${trimmedEmail}.`
        );
        notify(`Account "@${trimmedUser}" (${trimmedName}) created successfully!`, "success");
      }
      setUsername("");
      setDisplayName("");
      setPassword("");
      setEmail("");
      setDepartment("");
      setShowPassword(false);
      setUsernameError("");
      setNameError("");
      setEmailError("");
      await loadAccounts();
      await loadDepartments();
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Couldn't create the account.";
      setError(msg);
      notify(msg, "danger");
    } finally {
      setSaving(false);
    }
  };

  // Delete account action
  const removeAccount = async (account: LocalAccount) => {
    if (confirmingRemoval !== account.id) {
      setConfirmingRemoval(account.id);
      return;
    }
    setError("");
    setActionInProgress(account.id);
    try {
      await api.deleteLocalAccount(account.id);
      setConfirmingRemoval(null);
      const msg = `Account "${account.username}" deleted successfully.`;
      setSuccessMessage(msg);
      notify(`Account "@${account.username}" deleted successfully.`, "success");
      await loadAccounts();
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Couldn't remove the account.";
      setError(msg);
      notify(msg, "danger");
    } finally {
      setActionInProgress(null);
    }
  };

  // Revoke / Restore account access action
  const toggleRevokeAccount = async (account: LocalAccount) => {
    const isCurrentlyActive = account.active !== false;
    if (isCurrentlyActive && confirmingRevoke !== account.id) {
      setConfirmingRevoke(account.id);
      return;
    }
    setError("");
    setActionInProgress(account.id);
    try {
      const newActive = !isCurrentlyActive;
      if (typeof api.updateLocalAccount === "function") {
        await api.updateLocalAccount(account.id, { active: newActive });
      }
      setConfirmingRevoke(null);
      const msg = newActive
        ? `Access restored for "${account.username}".`
        : `Access revoked for "${account.username}". Sign-in is now blocked.`;
      setSuccessMessage(msg);
      notify(
        newActive
          ? `Access restored for "@${account.username}".`
          : `Access revoked for "@${account.username}".`,
        "success"
      );
      await loadAccounts();
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Couldn't update account access.";
      setError(msg);
      notify(msg, "danger");
    } finally {
      setActionInProgress(null);
    }
  };

  // Open Edit Account modal
  const openEditModal = (account: LocalAccount) => {
    setEditingAccount(account);
    setEditName(account.display_name);
    setEditRole(account.role);
    setEditDept(account.department || "");
    setEditEmail(account.email || "");
    setEditError("");
  };

  // Save Edit Account modal changes
  const saveAccountUpdate = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingAccount) return;
    const trimmedEditName = editName.trim();
    const trimmedEditEmail = editEmail.trim();
    if (!trimmedEditName) {
      const msg = "Name is required.";
      setEditError(msg);
      notify(msg, "danger");
      return;
    }
    if (!trimmedEditEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEditEmail)) {
      const msg = "Please provide a valid corporate email address.";
      setEditError(msg);
      notify(msg, "danger");
      return;
    }
    setEditSaving(true);
    setEditError("");
    try {
      const updates: LocalAccountUpdate = {
        display_name: trimmedEditName,
        role: editRole,
        department: editDept.trim() || null,
        email: trimmedEditEmail || null,
      };
      if (typeof api.updateLocalAccount === "function") {
        await api.updateLocalAccount(editingAccount.id, updates);
      }
      const msg = `Account "${editingAccount.username}" updated successfully.`;
      setSuccessMessage(msg);
      notify(`Account "@${editingAccount.username}" updated successfully.`, "success");
      setEditingAccount(null);
      await loadAccounts();
      await loadDepartments();
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Failed to update account.";
      setEditError(msg);
      notify(msg, "danger");
    } finally {
      setEditSaving(false);
    }
  };

  // Filter accounts
  const filteredAccounts = useMemo(() => {
    if (!searchQuery.trim()) return accounts;
    const q = searchQuery.toLowerCase().trim();
    return accounts.filter(
      (a) =>
        a.display_name.toLowerCase().includes(q) ||
        a.username.toLowerCase().includes(q) ||
        (a.email && a.email.toLowerCase().includes(q)) ||
        (a.department && a.department.toLowerCase().includes(q)) ||
        a.role.toLowerCase().includes(q)
    );
  }, [accounts, searchQuery]);

  return (
    <div className="account-management">
      {/* ── CREATE ACCOUNT SECTION ────────────────────────────────── */}
      <section className="account-management-section" aria-labelledby="account-create-title">
        <div className="account-management-heading">
          <div className="account-heading-badge">
            <div className="account-icon-badge">
              <UserPlus size={22} aria-hidden="true" />
            </div>
            <div>
              <h2 id="account-create-title">Create an account</h2>
              <p>
                {isSuperior
                  ? "Provision enterprise credentials and manage role-based permissions."
                  : "Supervisors can create Project Engineer and Employee accounts."}
                  : "Supervisors can create Project Engineer, Employee, and Intern accounts."}
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="account-management-error" role="alert">
            <X size={18} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        {successMessage && (
          <div className="account-management-success" role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>{successMessage}</span>
          </div>
        )}

        <form className="account-create-form" onSubmit={(event) => void createAccount(event)}>
          {/* User ID Field */}
          <div className="account-field">
            <div className="account-field-label">
              <label htmlFor="account-username">User ID</label>
              <span className="account-required" aria-hidden="true">*</span>
            </div>
            <div className="account-input-icon-wrapper">
              <span className="account-input-icon" aria-hidden="true">
                <AtSign size={16} />
              </span>
              <input
                id="account-username"
                required
                maxLength={50}
                autoComplete="off"
                value={username}
                placeholder="e.g. jdoe or emp_1042"
                onKeyDown={handleUsernameKeyDown}
                onChange={(event) => handleUsernameChange(event.target.value)}
              />
            </div>
            {usernameError ? (
              <span className="account-field-error">{usernameError}</span>
            ) : (
              <span className="account-field-hint">Alphanumeric, dots, hyphens, and underscores only. No spaces.</span>
            )}
          </div>

          {/* Name Field */}
          <div className="account-field">
            <div className="account-field-label">
              <label htmlFor="account-display-name">Name</label>
              <span className="account-required" aria-hidden="true">*</span>
            </div>
            <div className="account-input-icon-wrapper">
              <span className="account-input-icon" aria-hidden="true">
                <User size={16} />
              </span>
              <input
                id="account-display-name"
                required
                maxLength={200}
                value={displayName}
                placeholder="e.g. John Doe"
                onChange={(event) => handleDisplayNameChange(event.target.value)}
              />
            </div>
            {nameError ? (
              <span className="account-field-error">{nameError}</span>
            ) : (
              <span className="account-field-hint">Full person name (letters, spaces, hyphens, apostrophes).</span>
            )}
          </div>

          {/* Email ID Field (Required) */}
          <div className="account-field">
            <div className="account-field-label">
              <label htmlFor="account-email">Email ID</label>
              <span className="account-required" aria-hidden="true">*</span>
            </div>
            <div className="account-input-icon-wrapper">
              <span className="account-input-icon" aria-hidden="true">
                <Mail size={16} />
              </span>
              <input
                id="account-email"
                type="email"
                required
                maxLength={255}
                autoComplete="off"
                value={email}
                placeholder="e.g. john.doe@company.com"
                onChange={(event) => handleEmailChange(event.target.value)}
              />
            </div>
            {emailError ? (
              <span className="account-field-error">{emailError}</span>
            ) : (
              <span className="account-field-hint">Required. Credentials & password reset link will be sent automatically.</span>
            )}
          </div>

          {/* Temporary Password Field with Show/Hide Password Icon */}
          <div className="account-field">
            <div className="account-field-label">
              <label htmlFor="account-password">Temporary password</label>
              <span className="account-required" aria-hidden="true">*</span>
            </div>
            <div className="account-input-icon-wrapper">
              <span className="account-input-icon" aria-hidden="true">
                <Lock size={16} />
              </span>
              <input
                id="account-password"
                required
                minLength={12}
                maxLength={200}
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                placeholder="Enter temporary password (min. 12 chars)"
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="account-input-action-btn"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((prev) => !prev)}
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </div>
            <span className="account-field-hint">Minimum 12 characters. User can reset via the emailed link.</span>
          </div>

          {/* Role Field */}
          <div className="account-field">
            <div className="account-field-label">
              <label htmlFor="account-role">Role</label>
              <span className="account-required" aria-hidden="true">*</span>
            </div>
            <div className="account-input-icon-wrapper">
              <span className="account-input-icon" aria-hidden="true">
                <Shield size={16} />
              </span>
              <select
                id="account-role"
                value={role}
                onChange={(event) => setRole(event.target.value as LocalAccountRole)}
              >
                {allowedRoles.map((item) => (
                  <option key={item} value={item}>
                    {ROLE_TIER_LABELS[item] || item}
                  </option>
                ))}
              </select>
            </div>
            <span className="account-field-hint">Determines system permissions and access scope.</span>
          </div>

          {/* Customizable Department Field */}
          <div className="account-field">
            <div className="account-field-label">
              <label htmlFor="account-dept">Department</label>
              <span className="account-optional">(optional)</span>
            </div>
            <div className="account-dept-row">
              <div className="account-input-icon-wrapper">
                <span className="account-input-icon" aria-hidden="true">
                  <Building2 size={16} />
                </span>
                <select
                  id="account-dept"
                  value={department}
                  onChange={(e) => {
                    if (e.target.value === "__add_new__") {
                      setShowAddDept(true);
                    } else {
                      setDepartment(e.target.value);
                    }
                  }}
                >
                  <option value="">Select department (optional)</option>
                  {departments.map((dept) => (
                    <option key={dept} value={dept}>
                      {dept}
                    </option>
                  ))}
                  <option value="__add_new__">+ Add new department…</option>
                </select>
              </div>
              <button
                type="button"
                className="account-add-dept-trigger"
                onClick={() => setShowAddDept((prev) => !prev)}
                title="Add a custom department"
              >
                <Plus size={14} aria-hidden="true" />
                <span>New</span>
              </button>
            </div>

            {showAddDept && (
              <div className="account-dept-add-box">
                <input
                  type="text"
                  maxLength={100}
                  placeholder="Enter new department name"
                  value={newDeptName}
                  onChange={(e) => setNewDeptName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleAddDepartment();
                    }
                  }}
                />
                <button
                  type="button"
                  className="account-primary-action"
                  style={{ minHeight: "36px", padding: "0 12px" }}
                  disabled={addingDept || !newDeptName.trim()}
                  onClick={() => void handleAddDepartment()}
                >
                  {addingDept ? "Adding…" : "Add"}
                </button>
                <button
                  type="button"
                  className="account-secondary-action"
                  style={{ minHeight: "36px", padding: "0 10px" }}
                  onClick={() => {
                    setShowAddDept(false);
                    setNewDeptName("");
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
            <span className="account-field-hint">Choose an existing department or add a new custom one.</span>
          </div>

          {/* Automated Email Notice */}
          <div className="account-banner-info">
            <div className="account-banner-info-icon" aria-hidden="true">
              <Send size={18} />
            </div>
            <div>
              <strong>Automated Credential Dispatch via SMTP:</strong> Upon account creation, Nanvi will immediately
              dispatch an official email to <strong>{email ? email : "the specified address"}</strong> containing the{" "}
              <strong>User ID</strong>, <strong>Temporary Password</strong>, and a secure <strong>Password Reset option</strong>.
            </div>
          </div>

          {/* Form Submit Action */}
          <div className="account-form-actions">
            <button className="account-primary-action" type="submit" disabled={saving}>
              <UserPlus size={16} aria-hidden="true" /> {saving ? "Creating Account…" : "Create account"}
            </button>
          </div>
        </form>
      </section>

      {/* ── USER ACCOUNTS TABLE SECTION ───────────────────────────── */}
      <section className="account-management-section" aria-labelledby="account-list-title">
        <div className="account-management-heading">
          <div className="account-heading-badge">
            <div className="account-icon-badge" style={{ background: "rgba(100, 116, 139, 0.1)", color: "#334155" }}>
              <Shield size={22} aria-hidden="true" />
            </div>
            <div>
              <h2 id="account-list-title">User accounts</h2>
              <p>
                {loading
                  ? "Loading accounts…"
                  : `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"} configured`}
              </p>
            </div>
          </div>
          <button
            className="account-secondary-action"
            type="button"
            onClick={() => void loadAccounts()}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" /> Refresh
          </button>
        </div>

        {/* Toolbar & Search */}
        <div className="account-toolbar">
          <div className="account-search-box">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              placeholder="Search by name, user ID, role, department…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {!loading && accounts.length === 0 ? (
          <p className="account-list-empty">No accounts are available for management.</p>
        ) : !loading && filteredAccounts.length === 0 ? (
          <p className="account-list-empty">No accounts match the search criteria.</p>
        ) : (
          <div className="account-table-wrap">
            <table className="account-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Role</th>
                  <th scope="col">Created Date</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredAccounts.map((account) => {
                  const initials = account.display_name
                    ? account.display_name
                      .split(" ")
                      .filter(Boolean)
                      .map((n) => n[0])
                      .slice(0, 2)
                      .join("")
                      .toUpperCase()
                    : account.username.slice(0, 2).toUpperCase();

                  const roleSlug = account.role.toLowerCase().replace(/\s+/g, "");
                  const isRevoked = account.active === false;

                  return (
                    <tr key={account.id}>
                      {/* Name Column */}
                      <td>
                        <div className="account-user-cell">
                          <div className="account-avatar">{initials}</div>
                          <div className="account-user-info">
                            <span className="account-user-name">{account.display_name}</span>
                            <div className="account-user-meta">
                              <span>@{account.username}</span>
                              {account.email && (
                                <>
                                  <span>·</span>
                                  <span>{account.email}</span>
                                </>
                              )}
                              {account.department && (
                                <span className="account-dept-badge">{account.department}</span>
                              )}
                              <span
                                className={`account-status-pill ${isRevoked ? "status-revoked" : "status-active"
                                  }`}
                              >
                                {isRevoked ? "Revoked" : "Active"}
                              </span>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Role Column */}
                      <td>
                        <span className={`account-role-badge role-${roleSlug}`}>
                          {ROLE_TIER_LABELS[account.role] || account.role}
                        </span>
                      </td>

                      {/* Created Date Column */}
                      <td>
                        <div className="account-date-cell">
                          <Calendar size={13} aria-hidden="true" />
                          <span>{formatDate(account.created_at)}</span>
                        </div>
                      </td>

                      {/* Delete / Update / Revoke Actions Column */}
                      <td style={{ textAlign: "right" }}>
                        <div className="account-actions-group">
                          {/* 1. Update Action */}
                          <button
                            type="button"
                            className="account-action-btn btn-update"
                            onClick={() => openEditModal(account)}
                            title={`Update ${account.username}`}
                          >
                            <Edit3 size={13} aria-hidden="true" />
                            <span>Update</span>
                          </button>

                          {/* 2. Revoke / Restore Action */}
                          {confirmingRevoke === account.id ? (
                            <div className="account-inline-confirm">
                              <span>Revoke access?</span>
                              <button
                                type="button"
                                disabled={actionInProgress === account.id}
                                onClick={() => void toggleRevokeAccount(account)}
                              >
                                Yes
                              </button>
                              <button type="button" onClick={() => setConfirmingRevoke(null)}>
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className={`account-action-btn ${isRevoked ? "btn-restore" : "btn-revoke"}`}
                              onClick={() => void toggleRevokeAccount(account)}
                              disabled={actionInProgress === account.id}
                              title={isRevoked ? "Restore account access" : "Revoke account access"}
                            >
                              {isRevoked ? (
                                <>
                                  <CheckCircle2 size={13} aria-hidden="true" />
                                  <span>Restore</span>
                                </>
                              ) : (
                                <>
                                  <Ban size={13} aria-hidden="true" />
                                  <span>Revoke</span>
                                </>
                              )}
                            </button>
                          )}

                          {/* 3. Delete Action */}
                          {confirmingRemoval === account.id ? (
                            <div className="account-inline-confirm">
                              <span>Confirm delete?</span>
                              <button
                                type="button"
                                disabled={actionInProgress === account.id}
                                onClick={() => void removeAccount(account)}
                              >
                                Confirm
                              </button>
                              <button type="button" onClick={() => setConfirmingRemoval(null)}>
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="account-action-btn btn-delete account-remove-action"
                              aria-label={`Remove ${account.username}`}
                              onClick={() => void removeAccount(account)}
                              disabled={actionInProgress === account.id}
                              title={`Delete ${account.username}`}
                            >
                              <Trash2 size={13} aria-hidden="true" />
                              <span>Delete</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── UPDATE / EDIT ACCOUNT MODAL ───────────────────────────── */}
      {editingAccount && (
        <div className="account-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-edit-title">
          <div className="account-modal">
            <div className="account-modal-header">
              <h3 id="modal-edit-title">Update Account — @{editingAccount.username}</h3>
              <button
                type="button"
                className="account-modal-close"
                onClick={() => setEditingAccount(null)}
                aria-label="Close dialog"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {editError && (
              <div className="account-management-error" style={{ margin: "16px 20px 0" }} role="alert">
                <X size={16} aria-hidden="true" />
                <span>{editError}</span>
              </div>
            )}

            <form onSubmit={(e) => void saveAccountUpdate(e)}>
              <div className="account-modal-body">
                <div className="account-field">
                  <label htmlFor="edit-name">
                    <span>Name</span>
                    <span className="account-required">*</span>
                  </label>
                  <div className="account-input-icon-wrapper">
                    <span className="account-input-icon" aria-hidden="true">
                      <User size={16} />
                    </span>
                    <input
                      id="edit-name"
                      required
                      maxLength={200}
                      value={editName}
                      placeholder="e.g. John Doe"
                      onChange={(e) =>
                        setEditName(e.target.value.replace(/[^a-zA-Z\u00C0-\u024F\u1E00-\u1EFF\s.'-]/g, ""))
                      }
                    />
                  </div>
                </div>

                <div className="account-field">
                  <label htmlFor="edit-role">
                    <span>Role</span>
                    <span className="account-required">*</span>
                  </label>
                  <div className="account-input-icon-wrapper">
                    <span className="account-input-icon" aria-hidden="true">
                      <Shield size={16} />
                    </span>
                    <select
                      id="edit-role"
                      value={editRole}
                      onChange={(e) => setEditRole(e.target.value as LocalAccountRole)}
                    >
                      {allowedRoles.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_TIER_LABELS[r] || r}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="account-field">
                  <label htmlFor="edit-dept">
                    <span>Department</span>
                  </label>
                  <div className="account-dept-row">
                    <div className="account-input-icon-wrapper">
                      <span className="account-input-icon" aria-hidden="true">
                        <Building2 size={16} />
                      </span>
                      <select
                        id="edit-dept"
                        value={editDept}
                        onChange={(e) => {
                          if (e.target.value === "__add_new__") {
                            const custom = prompt("Enter new department name:");
                            if (custom && custom.trim()) {
                              const trimmed = custom.trim();
                              if (typeof api.addDepartment === "function") {
                                void api
                                  .addDepartment(trimmed)
                                  .then((updated) => {
                                    setDepartments(updated);
                                    setEditDept(trimmed);
                                    notify(`Department "${trimmed}" added successfully.`, "success");
                                  })
                                  .catch((cause) => {
                                    notify(cause instanceof Error ? cause.message : "Couldn't add department.", "danger");
                                  });
                              } else {
                                setDepartments((prev) => Array.from(new Set([...prev, trimmed])).sort());
                                setEditDept(trimmed);
                                notify(`Department "${trimmed}" added successfully.`, "success");
                              }
                            }
                          } else {
                            setEditDept(e.target.value);
                          }
                        }}
                      >
                        <option value="">No department</option>
                        {departments.map((dept) => (
                          <option key={dept} value={dept}>
                            {dept}
                          </option>
                        ))}
                        <option value="__add_new__">+ Add new department…</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="account-field">
                  <label htmlFor="edit-email">
                    <span>Email ID</span>
                    <span className="account-required">*</span>
                  </label>
                  <div className="account-input-icon-wrapper">
                    <span className="account-input-icon" aria-hidden="true">
                      <Mail size={16} />
                    </span>
                    <input
                      id="edit-email"
                      type="email"
                      required
                      maxLength={255}
                      value={editEmail}
                      placeholder="e.g. john.doe@company.com"
                      onChange={(e) => setEditEmail(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="account-modal-footer">
                <button
                  type="button"
                  className="account-secondary-action"
                  onClick={() => setEditingAccount(null)}
                  disabled={editSaving}
                >
                  Cancel
                </button>
                <button type="submit" className="account-primary-action" disabled={editSaving}>
                  {editSaving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

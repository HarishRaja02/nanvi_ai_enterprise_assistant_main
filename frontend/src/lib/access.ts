/**
 * UX-only role → capability map used to decide what to *show*. It is NOT authorization:
 * Backend authorization remains authoritative and every backend request is re-checked server-side.
 */
export type Role =
  | "Superior" | "Supervisor" | "Project Engineer" | "Employee"
  | "Superior" | "Supervisor" | "Project Engineer" | "Employee" | "Intern"
  | "CEO" | "Finance" | "HR" | "Manager" | "IT Admin" | "Admin";

export type Permission =
  | "FILE_READ" | "FILE_WRITE" | "EMAIL_READ" | "EMAIL_SEND"
  | "DATABASE_READ" | "DATABASE_WRITE" | "REPORT_CREATE" | "REPORT_DOWNLOAD"
  | "FINANCE_READ" | "HR_READ" | "AUDIT_READ" | "USER_MANAGE" | "ADMIN_ACCESS"
  | "SYSTEM_LOGS_READ";
  | "SYSTEM_LOGS_READ" | "CONNECTION_READ";

export type View = "Chat" | "Knowledge" | "Email" | "Data" | "Reports" | "Finance" | "HR" | "Audit" | "Settings" | "AdminDashboard" | "Logs" | "TextSize";

export type CanonicalRole = "Admin" | "Superior" | "Supervisor" | "Project Engineer" | "Employee";
export type CanonicalRole = "Admin" | "Superior" | "Supervisor" | "Project Engineer" | "Employee" | "Intern";

export const ROLE_PERMISSIONS: Record<CanonicalRole, Permission[]> = {
  Admin: ["FILE_READ", "FILE_WRITE", "EMAIL_READ", "EMAIL_SEND", "DATABASE_READ", "DATABASE_WRITE", "REPORT_CREATE", "REPORT_DOWNLOAD", "FINANCE_READ", "HR_READ", "AUDIT_READ", "USER_MANAGE", "ADMIN_ACCESS", "SYSTEM_LOGS_READ"],
  Superior: ["FILE_READ", "FILE_WRITE", "EMAIL_READ", "EMAIL_SEND", "DATABASE_READ", "DATABASE_WRITE", "REPORT_CREATE", "REPORT_DOWNLOAD", "FINANCE_READ", "HR_READ", "AUDIT_READ", "USER_MANAGE", "SYSTEM_LOGS_READ"],
  Supervisor: ["FILE_READ", "FILE_WRITE", "EMAIL_READ", "EMAIL_SEND", "DATABASE_READ", "DATABASE_WRITE", "REPORT_CREATE", "REPORT_DOWNLOAD", "FINANCE_READ", "HR_READ", "USER_MANAGE"],
  "Project Engineer": ["FILE_READ"],
  Employee: ["FILE_READ"],
  Admin: ["FILE_READ", "FILE_WRITE", "EMAIL_READ", "EMAIL_SEND", "DATABASE_READ", "DATABASE_WRITE", "REPORT_CREATE", "REPORT_DOWNLOAD", "FINANCE_READ", "HR_READ", "AUDIT_READ", "USER_MANAGE", "ADMIN_ACCESS", "SYSTEM_LOGS_READ", "CONNECTION_READ"],
  Superior: ["FILE_READ", "FILE_WRITE", "EMAIL_READ", "EMAIL_SEND", "DATABASE_READ", "DATABASE_WRITE", "REPORT_CREATE", "REPORT_DOWNLOAD", "FINANCE_READ", "HR_READ", "AUDIT_READ", "USER_MANAGE", "SYSTEM_LOGS_READ", "CONNECTION_READ"],
  Supervisor: ["FILE_READ", "FILE_WRITE", "EMAIL_READ", "EMAIL_SEND", "DATABASE_READ", "DATABASE_WRITE", "REPORT_CREATE", "REPORT_DOWNLOAD", "FINANCE_READ", "HR_READ", "USER_MANAGE", "CONNECTION_READ"],
  "Project Engineer": ["FILE_READ", "EMAIL_READ", "EMAIL_SEND", "DATABASE_READ", "REPORT_CREATE", "REPORT_DOWNLOAD", "CONNECTION_READ"],
  Employee: ["FILE_READ", "EMAIL_READ", "EMAIL_SEND", "DATABASE_READ", "REPORT_CREATE", "REPORT_DOWNLOAD", "CONNECTION_READ"],
  Intern: ["FILE_READ", "REPORT_CREATE", "REPORT_DOWNLOAD"],
};

const ROLE_ALIASES: Record<string, CanonicalRole> = {
  admin: "Admin",
  Administrator: "Admin",
  "Admin Portal": "Admin",
  CEO: "Superior",
  "Super Admin": "Superior",
  "Super Admin / Management": "Superior",
  "Tier 1": "Superior",
  "Tier 1 (Superior)": "Superior",
  Finance: "Supervisor",
  Manager: "Supervisor",
  "IT Admin": "Supervisor",
  "Manager / Supervisor": "Supervisor",
  "Tier 2": "Supervisor",
  "Tier 2 (Supervisor)": "Supervisor",
  HR: "Project Engineer",
  "Project Manager": "Project Engineer",
  "Team Lead": "Project Engineer",
  "Project Manager / Team Lead": "Project Engineer",
  "Tier 3": "Project Engineer",
  "Tier 3 (Project Manager)": "Project Engineer",
  "Tier 3 (Project Manager / Project Engineer)": "Project Engineer",
  "Tier 3 (Project Engineer)": "Project Engineer",
  "Tier 4": "Employee",
  "Tier 4 (Employee)": "Employee",
  Trainee: "Intern",
  "Intern / Trainee": "Intern",
  "Tier 5": "Intern",
  "Tier 5 (Intern)": "Intern",
  "Tier 5 (Intern / Trainee)": "Intern",
};

export const ROLE_TIER_DISPLAY: Record<string, string> = {
  Superior: "Tier 1 (Superior)",
  Supervisor: "Tier 2 (Supervisor)",
  "Project Engineer": "Tier 3 (Project Manager / Project Engineer)",
  "Project Manager": "Tier 3 (Project Manager)",
  Employee: "Tier 4 (Employee)",
  Superior: "Tier 1",
  Supervisor: "Tier 2",
  "Project Engineer": "Tier 3",
  "Project Manager": "Tier 3",
  "Project Manager / Team Lead": "Tier 3",
  "Team Lead": "Tier 3",
  Employee: "Tier 4",
  Intern: "Tier 5",
  Trainee: "Tier 5",
  "Intern / Trainee": "Tier 5",
  Admin: "Admin Portal",
  "Admin Portal": "Admin Portal",
  "Tier 1": "Tier 1 (Superior)",
  "Tier 1 (Superior)": "Tier 1 (Superior)",
  "Tier 2": "Tier 2 (Supervisor)",
  "Tier 2 (Supervisor)": "Tier 2 (Supervisor)",
  "Tier 3": "Tier 3 (Project Manager / Project Engineer)",
  "Tier 3 (Project Manager)": "Tier 3 (Project Manager)",
  "Tier 3 (Project Manager / Project Engineer)": "Tier 3 (Project Manager / Project Engineer)",
  "Tier 4": "Tier 4 (Employee)",
  "Tier 4 (Employee)": "Tier 4 (Employee)",
  CEO: "Tier 1",
  Finance: "Tier 2",
  Manager: "Tier 2",
  "IT Admin": "Tier 2",
  HR: "Tier 3",
  "Tier 1": "Tier 1",
  "Tier 1 (Superior)": "Tier 1",
  "Tier 2": "Tier 2",
  "Tier 2 (Supervisor)": "Tier 2",
  "Tier 3": "Tier 3",
  "Tier 3 (Project Manager)": "Tier 3",
  "Tier 3 (Project Manager / Project Engineer)": "Tier 3",
  "Tier 4": "Tier 4",
  "Tier 4 (Employee)": "Tier 4",
  "Tier 5": "Tier 5",
  "Tier 5 (Intern)": "Tier 5",
  "Tier 5 (Intern / Trainee)": "Tier 5",
};

export function formatRoleTier(role?: string | null): string {
  if (!role) return "Authorized user";
  return ROLE_TIER_DISPLAY[role] || role;
}

function canonicalRole(value: string): CanonicalRole | undefined {
  if (Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, value)) return value as CanonicalRole;
  return Object.prototype.hasOwnProperty.call(ROLE_ALIASES, value) ? ROLE_ALIASES[value] : undefined;
}

export function isRole(value: string): value is Role {
  return canonicalRole(value) !== undefined;
}

/** Union across every recognised role the backend reported (a user may hold several). */
export function permissionsFor(roles: readonly string[]): Permission[] {
  const set = new Set<Permission>();
  for (const role of roles) {
    const canonical = canonicalRole(role);
    if (canonical) for (const permission of ROLE_PERMISSIONS[canonical]) set.add(permission);
  }
  return [...set];
}

export type NavEntry = { id: View; label: string; permission?: Permission; hidden?: boolean };
export type NavGroup = { id: string; label?: string; items: NavEntry[] };

/** Modules hidden from the frontend navigation and entrypoints while preserving their implementation. */
export const HIDDEN_VIEWS: readonly View[] = ["Knowledge", "Finance", "HR", "Audit", "Reports"];

/** Only modules that exist in the app. Grouped by the job they do for the user. */
export const NAV_GROUPS: NavGroup[] = [
  { id: "assistant", items: [{ id: "Chat", label: "Assistant" }] },
  {
    id: "sources", label: "Sources",
    items: [
      { id: "Knowledge", label: "Knowledge", permission: "FILE_READ", hidden: true },
      { id: "Email", label: "Email", permission: "EMAIL_READ" },
      { id: "Data", label: "Data", permission: "DATABASE_READ" },
    ],
  },
  {
    id: "departments", label: "Departments",
    items: [
      { id: "Finance", label: "Finance", permission: "FINANCE_READ", hidden: true },
      { id: "HR", label: "HR", permission: "HR_READ", hidden: true },
    ],
  },
  {
    id: "administration", label: "Administration",
    items: [
      { id: "AdminDashboard", label: "Admin Console", permission: "ADMIN_ACCESS" },
    ],
  },
  {
    id: "governance", label: "Governance",
    items: [
      { id: "Audit", label: "Audit", permission: "AUDIT_READ", hidden: true },
      { id: "Settings", label: "Settings", permission: "USER_MANAGE" },
      { id: "Settings", label: "Settings", permission: "CONNECTION_READ" },
      { id: "Logs", label: "Logs", permission: "SYSTEM_LOGS_READ" },
    ],
  },
];


export function visibleNav(
  permissions: readonly Permission[],
  canAccessAdmin: boolean = false,
  includeHidden: boolean = false,
): NavGroup[] {
  return NAV_GROUPS
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => {
        if (!includeHidden && (i.hidden || HIDDEN_VIEWS.includes(i.id))) {
          return false;
        }
        if (i.id === "AdminDashboard") {
          return canAccessAdmin || permissions.includes("ADMIN_ACCESS");
        }
        return !i.permission || permissions.includes(i.permission);
      }),
    }))
    .filter((g) => g.items.length > 0);
}

export function viewLabel(view: View): string {
  if (view === "TextSize") return "Text size";
  for (const g of NAV_GROUPS) for (const i of g.items) if (i.id === view) return i.label;
  return view;
}

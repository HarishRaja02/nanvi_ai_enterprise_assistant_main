import { useEffect, useState, type ReactNode } from "react";
import { ConnectionsHub } from "./ConnectionsHub";
import { AuditLogView } from "./AuditLogView";
import { AccountManagement } from "./AccountManagement";
import { CompanyFolderPicker } from "../../components/ui/CompanyFolderPicker";
import { ErrorBoundary } from "../../components/ui/ErrorBoundary";
import { PlugIcon, FolderIcon, ShieldCheckIcon } from "../../icons";
import type { NanviApiClient, UserIdentity } from "../../api";
import type { FontScale } from "../../hooks/useFontScale";

type Props = {
  api: NanviApiClient;
  identity: UserIdentity | null;
  fontScale?: FontScale;
  onFontScaleChange?: (scale: FontScale) => void;
};

type Tab = "accounts" | "connections" | "folder" | "audit";

export function SettingsPage({ api, identity }: Props) {
  const roles = identity?.roles || [];
  const isAdmin = roles.some((role) => role === "Admin");
  const canManageUsers = roles.some((role) => ["Superior", "Supervisor", "CEO", "Finance", "Admin"].includes(role));
  const canUseIntegrations = roles.some((role) =>
    ["Superior", "Supervisor", "Project Engineer", "Employee", "CEO", "Finance", "HR", "Manager", "IT Admin", "Admin"].includes(role)
  );
  const canManageOrg = isAdmin || roles.some((role) => ["Superior", "Supervisor", "CEO", "IT Admin"].includes(role));
  const canViewAudit = isAdmin || roles.some((role) => ["Superior", "CEO", "IT Admin"].includes(role));

  const availableTabs: Tab[] = [];
  if (canManageUsers) availableTabs.push("accounts");
  if (canUseIntegrations) availableTabs.push("connections", "folder");
  if (canViewAudit) availableTabs.push("audit");

  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const tabParam = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (tabParam && availableTabs.includes(tabParam)) return tabParam;
    return availableTabs[0] || "accounts";
  });

  useEffect(() => {
    const tabParam = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    if (tabParam && availableTabs.includes(tabParam)) {
      setActiveTab(tabParam);
    }
  }, [availableTabs]);

  const tabs: { id: Tab; label: string; icon?: ReactNode }[] = [
    ...(canManageUsers ? [{ id: "accounts" as const, label: "User accounts" }] : []),
    ...(canUseIntegrations ? [
      { id: "connections" as const, label: "Connections Hub", icon: <PlugIcon size={16} /> },
      { id: "folder" as const, label: "Local Folders/Files", icon: <FolderIcon size={16} /> },
    ] : []),
    ...(canViewAudit ? [{ id: "audit" as const, label: "Security & Audit", icon: <ShieldCheckIcon size={16} /> }] : []),
  ];

  return (
    <div className="page" style={{ width: "100%", minWidth: 0, boxSizing: "border-box", maxWidth: "1280px", margin: "0 auto", padding: "1.5rem" }}>
      <div className="workspace-hero-banner" style={{ marginBottom: "1.5rem" }}>
        <h1 className="workspace-hero-title">Settings</h1>
        <p className="page-intro">Access enterprise management tools, data connections, and audit trails available to your role.</p>
      </div>

      <div role="tablist" aria-label="Settings" className="settings-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`settings-tab${activeTab === tab.id ? " is-active" : ""}`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "accounts" && canManageUsers && identity && <AccountManagement api={api} identity={identity} />}
      {activeTab === "connections" && canUseIntegrations && <ConnectionsHub api={api} canManageOrg={canManageOrg} />}
      {activeTab === "folder" && canUseIntegrations && (
        <div style={{ maxWidth: "800px" }}>
          <ErrorBoundary>
            <CompanyFolderPicker key={identity?.subject || "anon"} api={api} />
          </ErrorBoundary>
        </div>
      )}
      {activeTab === "audit" && canViewAudit && <AuditLogView api={api} identity={identity} />}
    </div>
  );
}

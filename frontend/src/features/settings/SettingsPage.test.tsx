import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NanviApiClient, UserIdentity } from "../../api";
import { SettingsPage } from "./SettingsPage";
import { ConnectionsHub } from "./ConnectionsHub";

const makeIdentity = (role: string): UserIdentity => ({
  subject: `${role.toLowerCase()}-1`,
  issuer: "nanvi-local",
  name: `${role} User`,
  email: `${role.toLowerCase()}@nanvi.local`,
  tenant_id: "default",
  department: "Engineering",
  roles: [role],
});

const stubApi = () =>
  ({
    listProviders: vi.fn().mockResolvedValue({ providers: [] }),
    listConnectionCategories: vi.fn().mockResolvedValue([]),
    listConnections: vi.fn().mockResolvedValue({ connections: [] }),
    getCompanyFolder: vi.fn().mockResolvedValue({ folder_path: "", folder_name: "", file_count: 0 }),
    listLocalAccounts: vi.fn().mockResolvedValue([]),
    listDepartments: vi.fn().mockResolvedValue([]),
  }) as unknown as NanviApiClient;

describe("SettingsPage role access (Tiers 1-5)", () => {
  it("shows Connections Hub and Local Folders/Files for Tier 3 and Tier 4 without User accounts or Audit", async () => {
    for (const role of ["Project Engineer", "Employee"]) {
      const { unmount } = render(<SettingsPage api={stubApi()} identity={makeIdentity(role)} />);
      expect(screen.getByRole("tab", { name: /Connections Hub/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /Local Folders\/Files/i })).toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: /User accounts/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: /Security & Audit/i })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByText(/Integrations Catalog/i)).toBeInTheDocument());
      unmount();
    }
  });

  it("hides all management, connection, and folder tabs for Tier 5 (Intern)", () => {
    render(<SettingsPage api={stubApi()} identity={makeIdentity("Intern")} />);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("allows Tier 3/4 to manage personal connections while marking organization connections Org Managed", async () => {
    const api = {
      listProviders: vi.fn().mockResolvedValue({ providers: [] }),
      listConnectionCategories: vi.fn().mockResolvedValue([]),
      listConnections: vi.fn().mockResolvedValue({
        connections: [
          {
            id: "org-1",
            provider: "google_workspace",
            display_name: "Company Drive",
            status: "CONNECTED",
            scope_level: "organization",
            account_type: "Organization",
            services: [],
            created_at: "2026-11-01T00:00:00Z",
          },
          {
            id: "user-1",
            provider: "google_workspace",
            display_name: "Personal Gmail",
            status: "CONNECTED",
            scope_level: "user",
            account_type: "Personal",
            services: [],
            created_at: "2026-11-01T00:00:00Z",
          },
        ],
      }),
    } as unknown as NanviApiClient;

    render(<ConnectionsHub api={api} canManageOrg={false} />);
    await waitFor(() => expect(screen.getByText("Company Drive")).toBeInTheDocument());
    expect(screen.getByText("Personal Gmail")).toBeInTheDocument();
    expect(screen.getByText("Org Managed")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Manage Services" })).toHaveLength(1);
  });
});


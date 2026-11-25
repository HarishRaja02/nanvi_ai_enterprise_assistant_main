import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuditLogView } from "./AuditLogView";
import type { LocalAccount, NanviApiClient, UserIdentity } from "../../api";

const mockAccounts: LocalAccount[] = [
  {
    id: "3be0ecca-ae9e-49ab-9720-4d7510c87675",
    username: "ceo2",
    display_name: "Arjun Mehta (CEO)",
    role: "Superior",
    email: "ceo2@company.com",
    active: 1,
    created_at: "2026-11-18",
  },
  {
    id: "a5985b78-9cde-4166-9d13-567f8e00c094",
    username: "admin",
    display_name: "System Administrator",
    role: "Admin",
    email: "admin@company.com",
    active: 1,
    created_at: "2026-11-18",
  },
];

const mockAuditEvents = [
  {
    id: "evt-001",
    event: "CONNECTION_USED_BY_AGENT",
    provider: "outlook",
    actor_user_id: "3be0ecca-ae9e-49ab-9720-4d7510c87675",
    raw_actor_id: "3be0ecca-ae9e-49ab-9720-4d7510c87675",
    safe_metadata: {},
    created_at: "2026-11-18T10:16:11.000Z",
  },
  {
    id: "evt-002",
    event: "CONNECTION_CREATED",
    provider: "microsoft365",
    actor_user_id: "a5985b78-9cde-4166-9d13-567f8e00c094",
    raw_actor_id: "a5985b78-9cde-4166-9d13-567f8e00c094",
    safe_metadata: { scope: "read_mail" },
    created_at: "2026-11-18T10:14:00.000Z",
  },
  {
    id: "evt-003",
    event: "CONNECTION_TESTED",
    provider: "google",
    actor_user_id: "System",
    safe_metadata: { status: "ok" },
    created_at: "2026-11-18T09:00:00.000Z",
  },
];

const mockIdentity: UserIdentity = {
  subject: "3be0ecca-ae9e-49ab-9720-4d7510c87675",
  issuer: "nanvi",
  name: "Arjun Mehta (CEO)",
  email: "ceo2@company.com",
  roles: ["Superior" as any],
};

function createMockApi(events = mockAuditEvents, accounts = mockAccounts) {
  return {
    listConnectionAuditEvents: vi.fn().mockResolvedValue(events),
    listLocalAccounts: vi.fn().mockResolvedValue(accounts),
  } as unknown as NanviApiClient;
}

describe("AuditLogView Component", () => {
  it("renders the table with User ID in the initial (first) column", async () => {
    const api = createMockApi();
    render(<AuditLogView api={api} identity={mockIdentity} />);

    await waitFor(() => {
      expect(screen.getByText("Security & Connection Audit Log")).toBeInTheDocument();
    });

    // Check table headers
    const thElements = screen.getAllByRole("columnheader");
    expect(thElements.length).toBeGreaterThanOrEqual(5);

    // Initial column MUST be User ID
    expect(thElements[0]).toHaveTextContent("User ID");
    expect(thElements[1]).toHaveTextContent("Action");
    expect(thElements[2]).toHaveTextContent("Service");
    expect(thElements[3]).toHaveTextContent("Details");
    expect(thElements[4]).toHaveTextContent("Timestamp");
  });

  it("resolves the raw actor UUID into the correct User ID and display name", async () => {
    const api = createMockApi();
    render(<AuditLogView api={api} identity={mockIdentity} />);

    // ceo2 should be resolved from UUID 3be0ecca-ae9e-49ab-9720-4d7510c87675
    await waitFor(() => {
      expect(screen.getByText("ceo2")).toBeInTheDocument();
      expect(screen.getByText("Arjun Mehta (CEO)")).toBeInTheDocument();
      expect(screen.getByText("Superior")).toBeInTheDocument();
    });

    // admin should be resolved from UUID a5985b78-9cde-4166-9d13-567f8e00c094
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("System Administrator")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();

    // System should be resolved for system events
    expect(screen.getByText("Nanvi AI System")).toBeInTheDocument();
  });

  it("only displays the User ID once without repeating it when name and user ID match", async () => {
    const customEvents = [
      {
        id: "evt-dup-1",
        event: "CONNECTION_USED_BY_AGENT",
        provider: "outlook",
        actor_user_id: "ceo2",
        actor_username: "ceo2",
        actor_name: "ceo2",
        actor_role: "Superior",
        safe_metadata: {},
        created_at: "2026-11-18T10:16:11.000Z",
      },
    ];
    const api = createMockApi(customEvents, [
      {
        id: "acc-ceo2",
        username: "ceo2",
        display_name: "ceo2",
        role: "Superior",
        email: "ceo2@company.com",
        active: 1,
        created_at: "2026-11-18",
      },
    ]);
    render(<AuditLogView api={api} identity={null} />);

    await waitFor(() => {
      // "ceo2" should appear exactly once in the rendered table cell (not repeated twice)
      const matching = screen.getAllByText("ceo2");
      expect(matching.length).toBe(1);
    });
  });

  it("displays friendly details text when metadata is empty instead of raw {}", async () => {
    const api = createMockApi();
    render(<AuditLogView api={api} identity={mockIdentity} />);

    await waitFor(() => {
      expect(screen.getByText("Standard Agent Access")).toBeInTheDocument();
    });
  });

  it("displays KPI cards with accurate metrics", async () => {
    const api = createMockApi();
    render(<AuditLogView api={api} identity={mockIdentity} />);

    await waitFor(() => {
      expect(screen.getByText("Total Audited Events")).toBeInTheDocument();
      expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Active Users")).toBeInTheDocument();
    });
  });

  it("filters audit events by search term", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<AuditLogView api={api} identity={mockIdentity} />);

    await waitFor(() => {
      expect(screen.getByText("ceo2")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Search by User ID/i);
    await user.type(searchInput, "admin");

    await waitFor(() => {
      expect(screen.getByText("admin")).toBeInTheDocument();
      expect(screen.queryByText("ceo2")).not.toBeInTheDocument();
    });
  });

  it("opens the inspection modal when clicking the inspect button", async () => {
    const user = userEvent.setup();
    const api = createMockApi();
    render(<AuditLogView api={api} identity={mockIdentity} />);

    await waitFor(() => {
      expect(screen.getByText("ceo2")).toBeInTheDocument();
    });

    const inspectButtons = screen.getAllByTitle("Inspect full audit event details");
    await user.click(inspectButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("Audit Event Record")).toBeInTheDocument();
      expect(screen.getByText("Attributed Actor")).toBeInTheDocument();
      expect(screen.getByText("3be0ecca-ae9e-49ab-9720-4d7510c87675")).toBeInTheDocument();
    });
  });
});

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserLogsPage } from "./UserLogsPage";
import type { NanviApiClient, UserLogDatesResponse, UserLogsResponse } from "../../api";

describe("UserLogsPage", () => {
  it("loads available dates, displays daily split dropdown and renders logs table", async () => {
    const mockDatesRes: UserLogDatesResponse = {
      dates: ["02-11-2026", "01-11-2026"],
      today: "02-11-2026",
    };

    const mockLogsRes: UserLogsResponse = {
      logs: [
        {
          id: "log-1",
          user_id: "priya.sharma",
          user_name: "Priya Sharma",
          user_role: "Supervisor",
          tenant_id: "enterprise-tenant",
          query: "What is the status of the CloudNova contract?",
          answer: "The CloudNova contract is active with renewal scheduled for Q3 2026.",
          capability: "knowledge",
          model: "llama-3.3-70b-versatile",
          created_at: "2026-11-02T10:15:30Z",
          log_date: "02-11-2026",
        },
      ],
      total: 1,
      date: "02-11-2026",
    };

    const mockApi = {
      getUserLogDates: vi.fn().mockResolvedValue(mockDatesRes),
      getUserLogs: vi.fn().mockResolvedValue(mockLogsRes),
    } as unknown as NanviApiClient;

    render(<UserLogsPage api={mockApi} />);

    // Check title
    expect(screen.getByText(/User Activity & Query Logs/i)).toBeInTheDocument();

    // Check date selector dropdown
    await waitFor(() => {
      const select = screen.getByTestId("logs-date-select") as HTMLSelectElement;
      expect(select).toBeInTheDocument();
      expect(select.value).toBe("02-11-2026");
    });

    // Check rendered log item
    await waitFor(() => {
      expect(screen.getByText("priya.sharma")).toBeInTheDocument();
      expect(screen.getByText("What is the status of the CloudNova contract?")).toBeInTheDocument();
      expect(screen.getByText(/The CloudNova contract is active/i)).toBeInTheDocument();
      expect(screen.getByText("02-11-2026")).toBeInTheDocument();
    });

    // Verify inspect modal
    const inspectBtn = screen.getByTitle("Inspect Details");
    fireEvent.click(inspectBtn);

    expect(screen.getByText("Turn Inspection Details")).toBeInTheDocument();
    expect(screen.getByText("User Query / Prompt")).toBeInTheDocument();
    expect(screen.getAllByText("System Generated Answer").length).toBeGreaterThanOrEqual(1);
  });

  it("handles date change in dropdown to fetch new partition", async () => {
    const mockDatesRes: UserLogDatesResponse = {
      dates: ["02-11-2026", "01-11-2026"],
      today: "02-11-2026",
    };

    const mockApi = {
      getUserLogDates: vi.fn().mockResolvedValue(mockDatesRes),
      getUserLogs: vi.fn().mockResolvedValue({
        logs: [],
        total: 0,
        date: "01-11-2026",
      }),
    } as unknown as NanviApiClient;

    render(<UserLogsPage api={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId("logs-date-select")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const select = screen.getByTestId("logs-date-select");
    await user.selectOptions(select, "01-11-2026");

    await waitFor(() => {
      expect(mockApi.getUserLogs).toHaveBeenCalledWith(
        expect.objectContaining({ date: "01-11-2026" })
      );
    });
  });

  it("replaces a number user ID with the correct User ID from accounts mapping", async () => {
    const mockDatesRes: UserLogDatesResponse = {
      dates: ["02-11-2026"],
      today: "02-11-2026",
    };

    const mockLogsRes: UserLogsResponse = {
      logs: [
        {
          id: "log-num-1",
          user_id: "42",
          user_name: "Maya Nair",
          user_role: "Project Engineer",
          tenant_id: "enterprise-tenant",
          query: "Find project drawings",
          answer: "Found 3 architectural drawings.",
          capability: "knowledge",
          model: "llama-3.3-70b-versatile",
          created_at: "2026-11-02T11:00:00Z",
          log_date: "02-11-2026",
        },
      ],
      total: 1,
      date: "02-11-2026",
    };

    const mockApi = {
      getUserLogDates: vi.fn().mockResolvedValue(mockDatesRes),
      getUserLogs: vi.fn().mockResolvedValue(mockLogsRes),
      listLocalAccounts: vi.fn().mockResolvedValue([
        {
          id: "42",
          username: "maya.nair",
          display_name: "Maya Nair",
          role: "Project Engineer",
          active: true,
        },
      ]),
    } as unknown as NanviApiClient;

    render(<UserLogsPage api={mockApi} />);

    await waitFor(() => {
      // The number "42" must be replaced with the actual User ID "maya.nair"
      expect(screen.getByText("maya.nair")).toBeInTheDocument();
      expect(screen.queryByText("42")).not.toBeInTheDocument();
    });
  });

  it("only displays User ID once without repetition when name matches user ID", async () => {
    const mockDatesRes: UserLogDatesResponse = {
      dates: ["02-11-2026"],
      today: "02-11-2026",
    };

    const mockLogsRes: UserLogsResponse = {
      logs: [
        {
          id: "log-ceo3",
          user_id: "ceo3",
          user_name: "ceo3",
          user_role: "Superior",
          tenant_id: "enterprise-tenant",
          query: "Show invoices",
          answer: "Found 2 invoices.",
          capability: "knowledge",
          model: "llama-3.3-70b-versatile",
          created_at: "2026-11-02T12:00:00Z",
          log_date: "02-11-2026",
        },
      ],
      total: 1,
      date: "02-11-2026",
    };

    const mockApi = {
      getUserLogDates: vi.fn().mockResolvedValue(mockDatesRes),
      getUserLogs: vi.fn().mockResolvedValue(mockLogsRes),
      listLocalAccounts: vi.fn().mockResolvedValue([
        {
          id: "acc-ceo3",
          username: "ceo3",
          display_name: "ceo3",
          role: "Superior",
          active: true,
        },
      ]),
    } as unknown as NanviApiClient;

    render(<UserLogsPage api={mockApi} />);

    await waitFor(() => {
      // In the user cell, "ceo3" should appear once, not duplicated
      const userCellMatches = screen.getAllByText("ceo3");
      expect(userCellMatches.length).toBe(1);
    });
  });
});

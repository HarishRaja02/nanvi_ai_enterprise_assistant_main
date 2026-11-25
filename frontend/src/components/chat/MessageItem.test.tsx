import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageItem } from "./MessageItem";
import type { Message } from "../../types";

describe("MessageItem", () => {
  it("renders user bubble for user role messages", () => {
    const userMsg: Message = {
      id: "u1",
      role: "user",
      text: "Find all invoice files from November",
      createdAt: Date.now(),
    };
    render(
      <MessageItem
        message={userMsg}
        onOpenSource={vi.fn()}
        onDownload={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText("Find all invoice files from November")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("prioritizes file results first and renders summary below", () => {
    const assistantMsg: Message = {
      id: "a1",
      role: "assistant",
      text: "Here is the summary of invoice files found in local storage.",
      createdAt: Date.now(),
      fileResults: [
        {
          name: "invoice_nov_2026.pdf",
          path: "Finance/Invoices/invoice_nov_2026.pdf",
          match_type: "name",
          source: "local",
        },
      ],
    };

    const { container } = render(
      <MessageItem
        message={assistantMsg}
        userQuery="invoice files"
        onOpenSource={vi.fn()}
        onDownload={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    // Both table and summary exist
    expect(screen.getByText("File Name Matches")).toBeInTheDocument();
    expect(screen.getByText("invoice_nov_2026.pdf")).toBeInTheDocument();
    expect(screen.getByText("Summary & Explanation")).toBeInTheDocument();
    expect(screen.getByText(/Here is the summary of invoice files/i)).toBeInTheDocument();

    // Verify DOM order: file-results-container precedes file-search-summary-block
    const block = container.querySelector(".file-search-result-block");
    expect(block).toBeInTheDocument();
    const tableEl = block?.querySelector(".file-results-container");
    const summaryEl = block?.querySelector(".file-search-summary-block");
    expect(tableEl).toBeInTheDocument();
    expect(summaryEl).toBeInTheDocument();

    // In DOM order, table comes before summary
    expect(tableEl?.compareDocumentPosition(summaryEl!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("renders contextual follow-up suggestions and triggers onFollowup on click", async () => {
    const user = userEvent.setup();
    const handleFollowup = vi.fn();
    const assistantMsg: Message = {
      id: "a2",
      role: "assistant",
      text: "Found 3 invoices totaling $45,000 for vendors Acme and Apex.",
      createdAt: Date.now(),
      capability: "file_search",
      fileResults: [
        {
          name: "invoice_vendor_acme.pdf",
          path: "Finance/invoice_vendor_acme.pdf",
          match_type: "name",
        },
      ],
    };

    render(
      <MessageItem
        message={assistantMsg}
        userQuery="show invoice files"
        onOpenSource={vi.fn()}
        onDownload={vi.fn()}
        onRetry={vi.fn()}
        onFollowup={handleFollowup}
      />
    );

    expect(screen.getByText("Suggested follow-ups")).toBeInTheDocument();
    const suggestionBtn = screen.getByRole("button", {
      name: /Can I find another invoice file like this\?/i,
    });
    expect(suggestionBtn).toBeInTheDocument();

    await user.click(suggestionBtn);
    expect(handleFollowup).toHaveBeenCalledWith("Can I find another invoice file like this?");
  });

  it("preserves Relevant Document Excerpts and pagination notes below stripped markdown file tables", () => {
    const assistantMsg: Message = {
      id: "a-tbl",
      role: "assistant",
      capability: "document_search",
      text: [
        "Found **3** matching documents in **Local Storage**:",
        "",
        "| File Name | File Path | Action |",
        "| --- | --- | --- |",
        "| NDA-0008.pdf | `C:\\CompanyData\\Contracts\\NDA-0008.pdf` | [Open](C:\\CompanyData\\Contracts\\NDA-0008.pdf) |",
        "| invoice_005.pdf | `C:\\CompanyData\\Finance\\invoice_005.pdf` | [Open](C:\\CompanyData\\Finance\\invoice_005.pdf) |",
        "| invoice_008.pdf | `C:\\CompanyData\\Finance\\invoice_008.pdf` | [Open](C:\\CompanyData\\Finance\\invoice_008.pdf) |",
        "",
        "**Relevant Document Excerpts:**",
        "• **NDA-0008.pdf**: *\"Mutual NDA NDA-0008 Party A: Asteron Technologies\"*",
        "• **invoice_005.pdf**: *\"INV-00005 | BluePeak Solutions | INR 130,359.32 | Status: Overdue\"*",
        "• **invoice_008.pdf**: *\"INV-00008 | Vertex Logistics | INR 106,984.70 | Status: Paid\"*",
      ].join("\n"),
      createdAt: Date.now(),
      fileResults: [
        {
          name: "NDA-0008.pdf",
          path: "C:\\CompanyData\\Contracts\\NDA-0008.pdf",
          match_type: "name",
          source: "local",
        },
        {
          name: "invoice_005.pdf",
          path: "C:\\CompanyData\\Finance\\invoice_005.pdf",
          match_type: "name",
          source: "local",
        },
        {
          name: "invoice_008.pdf",
          path: "C:\\CompanyData\\Finance\\invoice_008.pdf",
          match_type: "name",
          source: "local",
        },
      ],
    };

    render(
      <MessageItem
        message={assistantMsg}
        userQuery="NDA-0008"
        onOpenSource={vi.fn()}
        onDownload={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText(/Relevant Document Excerpts/i)).toBeInTheDocument();
    expect(screen.getByText(/Mutual NDA NDA-0008/i)).toBeInTheDocument();
    expect(screen.getByText(/BluePeak Solutions/i)).toBeInTheDocument();
    expect(screen.queryByText(/Data table ·/i)).not.toBeInTheDocument();
  });

  it("renders raw CSV/PDF excerpt strings cleanly without bracket noise, pipe walls, or cut-off words", () => {
    const assistantMsg: Message = {
      id: "a-clean-excerpts",
      role: "assistant",
      capability: "document_search",
      text: [
        "Found **2** matching documents in **Local Storage**:",
        "",
        "**Relevant Document Excerpts:**",
        "• **Nanvi_Mock_Project_Status_Report.pdf**: \"[Page 2] Nanvi Enterprise AI — Mock Project Status Report Page 2 Attribute Value Spent to date I13.9 lakh Target release 30 September 2026 Current s...\"",
        "• **tasks_011.csv**: \"[CSV] task_id | project_id | task | owner | status | priority | due_date T-011-000 | P-011-000 | API development | QA | In Progress | High | 2026-12-07 T-011-001 | P-011-001 | 2027-0...\"",
      ].join("\n"),
      createdAt: Date.now(),
      fileResults: [
        { name: "Nanvi_Mock_Project_Status_Report.pdf", path: "C:\\CompanyData\\Projects\\Nanvi_Mock_Project_Status_Report.pdf", source: "local" },
        { name: "tasks_011.csv", path: "C:\\CompanyData\\Projects\\05_Tasks_CSV\\tasks_011.csv", source: "local" },
      ],
    };

    render(
      <MessageItem
        message={assistantMsg}
        userQuery="project status"
        onOpenSource={vi.fn()}
        onDownload={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText("Page 2")).toBeInTheDocument();
    expect(screen.getByText(/₹13\.9 lakh/i)).toBeInTheDocument();
    expect(screen.getByText(/Task ID: T-011-000 · Project ID: P-011-000/i)).toBeInTheDocument();
    expect(screen.queryByText(/\[CSV\]/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\[Page 2\]/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Attribute Value/i)).not.toBeInTheDocument();
  });

  it("strips duplicate Local Storage headers and keeps structured summaries clean with collapsible table", () => {
    const assistantMsg: Message = {
      id: "a-clean-inv",
      role: "assistant",
      capability: "document_search",
      text: [
        "Found 6 matching documents in Local Storage:",
        "",
        "Structured Invoice Summary:",
        "",
        "Found **6** paid invoices across **3** vendors/customers (2025–2026):",
        "",
        "**Key Highlights**",
        "• **INV-001** — KPMG LLP · **28,000.00** (2026-02-15 · `vendor_payment_schedule.csv`)",
        "",
        "| Invoice | Party | Amount | Date | Source |",
        "| --- | --- | --- | --- | --- |",
        "| INV-001 | KPMG LLP | 28,000.00 | 2026-02-15 | vendor_payment_schedule.csv |",
        "| INV-002 | Acme Corp | 45,000.00 | 2025-09-30 | invoices_q3_summary.csv |",
      ].join("\n"),
      createdAt: Date.now(),
      fileResults: [
        { name: "vendor_payment_schedule.csv", path: "H:\\Finance\\vendor_payment_schedule.csv", match_type: "name", source: "local" },
      ],
    };

    render(
      <MessageItem
        message={assistantMsg}
        userQuery="list the invoices that already paid"
        onOpenSource={vi.fn()}
        onDownload={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.queryByText(/matching documents in Local Storage/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Structured Invoice Summary/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Key Highlights/i)).toBeInTheDocument();
    expect(screen.getByText(/Data table · 2 records/i)).toBeInTheDocument();
  });

  it("triggers onRetry when regenerate button is clicked", async () => {
    const user = userEvent.setup();
    const handleRetry = vi.fn();
    const assistantMsg: Message = {
      id: "a3",
      role: "assistant",
      text: "General assistant answer without files.",
      createdAt: Date.now(),
    };

    render(
      <MessageItem
        message={assistantMsg}
        onOpenSource={vi.fn()}
        onDownload={vi.fn()}
        onRetry={handleRetry}
      />
    );

    const regenBtn = screen.getByRole("button", { name: "Regenerate" });
    await user.click(regenBtn);
    expect(handleRetry).toHaveBeenCalledWith("a3");
  });
});

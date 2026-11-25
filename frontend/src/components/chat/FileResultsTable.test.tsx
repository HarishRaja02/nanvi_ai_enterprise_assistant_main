import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileResultsTable } from "./FileResultsTable";
import type { FileResultItem } from "../../types";

const mockFiles: FileResultItem[] = [
  {
    name: "invoice_2026_q1.pdf",
    path: "Finance/Invoices/invoice_2026_q1.pdf",
    match_type: "name",
    source: "local",
  },
  {
    name: "master_services_agreement.docx",
    path: "Legal/master_services_agreement.docx",
    match_type: "content",
    content_snippet: "The supplier shall issue invoice within 30 days of shipment approval.",
    source: "knowledge",
  },
];

describe("FileResultsTable", () => {
  it("separates file search results into File Name Matches and Document Content Matches", () => {
    render(<FileResultsTable files={mockFiles} userQuery="invoice" />);

    // Section 1: File Name Matches
    expect(screen.getByText("File Name Matches")).toBeInTheDocument();
    expect(screen.getByText("invoice_2026_q1.pdf")).toBeInTheDocument();

    // Section 2: Document Content Matches
    expect(screen.getByText("Document Content Matches")).toBeInTheDocument();
    expect(screen.getByText("master_services_agreement.docx")).toBeInTheDocument();

    // Section 2 renders cleanly with normal row format without snippet box
    expect(screen.queryByText(/Matching content:/i)).not.toBeInTheDocument();
  });

  it("triggers preview modal when preview button is clicked", async () => {
    const user = userEvent.setup();
    render(<FileResultsTable files={mockFiles} userQuery="invoice" />);

    const previewButtons = screen.getAllByRole("button", { name: /preview/i });
    expect(previewButtons.length).toBeGreaterThanOrEqual(1);

    await user.click(previewButtons[0]);
    // Modal opens showing file title, path, and action buttons including Open Original File
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Finance/Invoices/invoice_2026_q1.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open in new tab/i })).toBeInTheDocument();
  });

  it("supports PowerPoint presentations (.pptx) and Excel spreadsheets (.xlsx)", () => {
    const officeFiles: FileResultItem[] = [
      {
        name: "quarterly_earnings_presentation.pptx",
        path: "Presentations/quarterly_earnings_presentation.pptx",
        match_type: "name",
      },
      {
        name: "balance_sheet_2026.xlsx",
        path: "Finance/balance_sheet_2026.xlsx",
        match_type: "name",
      },
    ];

    render(<FileResultsTable files={officeFiles} userQuery="earnings" />);

    expect(screen.getByText("quarterly_earnings_presentation.pptx")).toBeInTheDocument();
    expect(screen.getByText("balance_sheet_2026.xlsx")).toBeInTheDocument();
  });

  it("calls onOpen and triggers exactly ONE browser tab opening without opening in-app modal", async () => {
    const user = userEvent.setup();
    const handleOpen = vi.fn();
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null as any);

    const mockApi = {
      getDocumentBlob: vi.fn().mockResolvedValue({
        blob: new Blob(["dummy content"], { type: "text/plain" }),
        filename: "invoice_2026_q1.pdf",
        mimeType: "text/plain",
      }),
    };

    render(
      <FileResultsTable
        files={mockFiles}
        userQuery="invoice"
        onOpen={handleOpen}
        api={mockApi as any}
      />
    );

    const openButtons = screen.getAllByRole("button", { name: /open/i });
    expect(openButtons.length).toBeGreaterThanOrEqual(1);

    await user.click(openButtons[0]);
    expect(handleOpen).toHaveBeenCalledWith(
      expect.objectContaining({ name: "invoice_2026_q1.pdf" })
    );

    // Verified: window.open is called EXACTLY ONCE (never opens 2 or 3 tabs!)
    expect(windowOpenSpy).toHaveBeenCalledTimes(1);

    // Verified: getDocumentBlob is called with false (preview mode, NOT download mode)
    expect(mockApi.getDocumentBlob).toHaveBeenCalledWith("Finance/Invoices/invoice_2026_q1.pdf", false);

    // Verified: In-app preview modal is NOT opened when Open button is clicked
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    windowOpenSpy.mockRestore();
  });
});


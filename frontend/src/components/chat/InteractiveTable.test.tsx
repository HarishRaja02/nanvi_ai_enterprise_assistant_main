import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InteractiveTable } from "./InteractiveTable";

describe("InteractiveTable", () => {
  it("starts collapsed and keeps filter, sort, and CSV controls available when expanded", async () => {
    const user = userEvent.setup();
    render(
      <InteractiveTable
        headers={["Contract ID", "Account"]}
        rows={[
          ["CTR-01", "Acme"],
          ["CTR-02", "Apex"],
          ["CTR-03", "Globex"],
        ]}
        metadata={{ filename: "contracts.csv", sheet: "Renewals" }}
      />,
    );

    const summary = screen.getByText("Show table").closest("summary");
    const disclosure = summary?.closest("details") as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    expect(screen.getByText("contracts.csv")).toBeInTheDocument();

    await user.click(summary!);
    expect(disclosure.open).toBe(true);
    expect(screen.getByRole("textbox", { name: "Filter table records" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contract ID" })).toHaveAttribute("title", "Sort by Contract ID");
    expect(screen.getByRole("button", { name: "Copy table as CSV" })).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("renders row-level Preview and Open buttons when rows reference files", async () => {
    const user = userEvent.setup();
    const previewEvents: unknown[] = [];
    const listener = (e: Event) => previewEvents.push((e as CustomEvent).detail);
    window.addEventListener("nanvi:preview-file", listener);

    render(
      <InteractiveTable
        headers={["File", "Location"]}
        rows={[
          [
            "Nanvi_Overnight_Customer_Chat_Support_Proposal.pdf",
            "`Office/Proposal/Customer Support/Nanvi_Overnight_Customer_Chat_Support_Proposal.pdf`",
          ],
        ]}
      />,
    );

    await user.click(screen.getByText("Show table"));
    const previewBtn = screen.getByRole("button", { name: "Preview" });
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    await user.click(previewBtn);
    expect(previewEvents).toHaveLength(1);
    window.removeEventListener("nanvi:preview-file", listener);
    vi.restoreAllMocks();
  });
});
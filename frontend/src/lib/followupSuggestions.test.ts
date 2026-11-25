import { describe, expect, it } from "vitest";
import { generateFollowupSuggestions } from "./followupSuggestions";

describe("generateFollowupSuggestions", () => {
  it("provides invoice file finding follow-ups when querying invoice files", () => {
    const suggestions = generateFollowupSuggestions({
      userQuery: "show me recent invoice files",
      responseText: "Found 3 invoices from vendors.",
      hasFiles: true,
    });
    expect(suggestions.length).toBe(3);
    expect(suggestions[0]).toBe("Can I find another invoice file like this?");
    expect(suggestions[1]).toBe("Find payment receipt or purchase order files");
    expect(suggestions[2]).toBe("Find contract files linked to these invoices");
  });

  it("provides contract file finding follow-ups when querying contract documents", () => {
    const suggestions = generateFollowupSuggestions({
      userQuery: "find master services agreement",
      responseText: "Found CloudNova contract.",
      hasFiles: true,
    });
    expect(suggestions.length).toBe(3);
    expect(suggestions[0]).toBe("Can I find another contract or agreement file?");
  });

  it("provides purchase order and vendor follow-ups when querying purchase orders or receipts", () => {
    const suggestions = generateFollowupSuggestions({
      userQuery: "Find payment receipt or purchase order files",
      responseText: "Found PUR-0001.pdf purchase agreement.",
      hasFiles: true,
    });
    expect(suggestions.length).toBe(3);
    expect(suggestions).not.toContain("Find payment receipt or purchase order files");
    expect(suggestions[0]).toContain("purchase");
  });

  it("provides spreadsheet and data file finding follow-ups when tables are present", () => {
    const suggestions = generateFollowupSuggestions({
      userQuery: "show sales data",
      responseText: "| Product | Q1 Sales |\n| Widget | $10,000 |",
      hasTables: true,
    });
    expect(suggestions.length).toBe(3);
    expect(suggestions[0]).toBe("Can I find another spreadsheet or Excel file?");
  });
});

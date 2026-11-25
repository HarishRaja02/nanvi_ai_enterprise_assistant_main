import { describe, expect, it } from "vitest";
import { formatCleanExcerpt, parseSummaryAndExcerpts } from "./formatExcerpt";

describe("formatExcerpt", () => {
  it("strips [CSV], [Page N], Attribute Value, pipe walls, quotes, and broken rupee glyph", () => {
    const pdfRes = formatCleanExcerpt(
      '"[Page 2] Nanvi Enterprise AI — Mock Project Status Report Page 2 Attribute Value Spent to date I13.9 lakh Target release 30 September 2026"',
    );
    expect(pdfRes.locationLabel).toBe("Page 2");
    expect(pdfRes.text).toContain("₹13.9 lakh");
    expect(pdfRes.text).not.toContain("[Page 2]");
    expect(pdfRes.text).not.toContain("Attribute Value");
    expect(pdfRes.text.startsWith('"')).toBe(false);

    const csvRes = formatCleanExcerpt(
      '"[CSV] task_id | project_id | task | owner | status | priority | due_date T-011-000 | P-011-000 | API development | QA | In Progress | High | 2026-12-07 T-011-001 | 2027-0..."',
    );
    expect(csvRes.text).toContain("Task ID: T-011-000");
    expect(csvRes.text).toContain("Due Date: 2026-12-07");
    expect(csvRes.text).not.toContain("[CSV]");
    expect(csvRes.text).not.toContain("|");
    expect(csvRes.text).not.toContain("2027-0");
  });

  it("parses Summary & Explanation prose and document highlight cards cleanly", () => {
    const parsed = parseSummaryAndExcerpts([
      "Found **2** matching documents in **Local Storage**:",
      "",
      "**Relevant Document Excerpts:**",
      "• **tasks_011.csv**: \"[CSV] task_id | status | owner T-011-000 | In Progress | QA\"",
      "• **report.pdf**: \"[Page 1] Summary of Q3 roadmap\"",
      "",
      "💡 **5 more matching files available.**",
    ].join("\n"));

    expect(parsed.proseBefore).toBe("Found **2** matching documents in **Local Storage**");
    expect(parsed.excerpts).toHaveLength(2);
    expect(parsed.excerpts[0].extBadge).toBe("CSV");
    expect(parsed.excerpts[1].locationLabel).toBe("Page 1");
    expect(parsed.proseAfter).toContain("5 more matching files available");
  });

  it("handles unstarred filenames in excerpts list from screenshots without raw noise", () => {
    const parsed = parseSummaryAndExcerpts([
      "Found 10 matching documents in Local Storage:",
      "",
      "Relevant Document Excerpts:",
      '• Nanvi_Mock_Project_Status_Report.pdf: "[Page 2] Nanvi Enterprise AI — Mock Project Status Report Page 2 Attribute Value Spent to date I13.9 lakh Target release 30 September 2026 Primary stack React, TypeScript, FastAPI, Python, LangGraph, PostgreSQL Current s..."',
      '• tasks_011.csv: "[CSV] task_id | project_id | task | owner | status | priority | due_date T-011-000 | P-011-000 | API development | QA | In Progress | High | 2026-12-07 T-011-001 | 2027-0..."',
    ].join("\n"));

    expect(parsed.excerpts).toHaveLength(2);
    expect(parsed.excerpts[0].filename).toBe("Nanvi_Mock_Project_Status_Report.pdf");
    expect(parsed.excerpts[0].locationLabel).toBe("Page 2");
    expect(parsed.excerpts[0].text).toContain("₹13.9 lakh");
    expect(parsed.excerpts[1].filename).toBe("tasks_011.csv");
    expect(parsed.excerpts[1].text).toContain("Task ID: T-011-000");
  });
});


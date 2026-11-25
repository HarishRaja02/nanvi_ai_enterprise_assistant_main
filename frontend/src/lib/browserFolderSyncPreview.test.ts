import { describe, expect, it } from "vitest";
import {
  formatWordDocumentPreviewHtml,
  formatExcelSpreadsheetPreviewHtml,
  formatPowerPointPresentationPreviewHtml,
  formatPdfDocumentPreviewHtml,
  formatCodeDocumentPreviewHtml,
  formatTextDocumentPreviewHtml,
} from "./browserFolderSync";

describe("Document Preview HTML Formatters", () => {
  describe("formatWordDocumentPreviewHtml", () => {
    it("renders authentic Microsoft Word ribbon, page styling, and document headings", () => {
      const sampleText = `Employee Leave and Vacation Policy
Section 1. General PTO Guidelines
- Full-time employees accrue 20 days PTO annually.
- Rollover is capped at 5 days into subsequent year.
Parental Leave Provisions
New parents receive 16 weeks of 100% paid parental leave.`;

      const html = formatWordDocumentPreviewHtml("leave_policy.docx", sampleText);

      expect(html).toContain("Microsoft Word Document (.docx)");
      expect(html).toContain("word-ribbon");
      expect(html).toContain("word-doc-title");
      expect(html).toContain("Employee Leave and Vacation Policy");
      expect(html).toContain("word-section-header");
      expect(html).toContain("Section 1. General PTO Guidelines");
      expect(html).toContain("word-bullet-list");
      expect(html).toContain("Full-time employees accrue 20 days PTO annually.");
      expect(html).toContain("word-page");
      expect(html).toContain("Confidential Enterprise Document");
    });
  });

  describe("formatExcelSpreadsheetPreviewHtml", () => {
    it("renders authentic Microsoft Excel grid with row numbers, column headers, and sheet tab", () => {
      const sampleCsv = `Invoice ID,Client,Amount,Status
INV-001,Acme Corp,$12500,Approved
INV-002,Global Logistics,$4320,Pending`;

      const html = formatExcelSpreadsheetPreviewHtml("quarterly_invoices.xlsx", sampleCsv);

      expect(html).toContain("Microsoft Excel Worksheet (.xlsx)");
      expect(html).toContain("excel-ribbon");
      expect(html).toContain("excel-col-header");
      expect(html).toContain(">A<");
      expect(html).toContain(">B<");
      expect(html).toContain("excel-row-num");
      expect(html).toContain("INV-001");
      expect(html).toContain("Acme Corp");
      expect(html).toContain("is-number");
      expect(html).toContain("excel-sheet-tab");
      expect(html).toContain("Sheet1");
    });

    it("handles pipe-delimited and tab-delimited spreadsheet data", () => {
      const pipeData = `Dept | Budget | Spent
Engineering | 500000 | 320000
Marketing | 200000 | 185000`;

      const html = formatExcelSpreadsheetPreviewHtml("department_budget.xls", pipeData);

      expect(html).toContain("Engineering");
      expect(html).toContain("500000");
      expect(html).toContain("excel-table");
    });

    it("renders CSV and TSV data with proper table grid and file type badge", () => {
      const csvData = `Employee,Department,Location\nAlice,Engineering,Remote\nBob,Design,New York`;
      const htmlCsv = formatExcelSpreadsheetPreviewHtml("team_roster.csv", csvData);

      expect(htmlCsv).toContain("Comma-Separated Values (.csv)");
      expect(htmlCsv).toContain("Alice");
      expect(htmlCsv).toContain("Engineering");
      expect(htmlCsv).toContain("excel-table");

      const tsvData = `Item\tPrice\tQty\nMonitor\t350\t2\nKeyboard\t99\t5`;
      const htmlTsv = formatExcelSpreadsheetPreviewHtml("inventory.tsv", tsvData);

      expect(htmlTsv).toContain("inventory.tsv");
      expect(htmlTsv).toContain("Monitor");
      expect(htmlTsv).toContain("350");
    });
  });

  describe("formatPowerPointPresentationPreviewHtml", () => {
    it("renders authentic Microsoft PowerPoint presentation with 16:9 widescreen slide cards and slide counter", () => {
      const samplePptx = `--- Slide 1 ---
Enterprise AI Roadmap 2026
Executive Strategy Briefing

--- Slide 2 ---
Key Milestones
- Q1: Zero-trust local folder indexing
- Q2: Microsoft Office native document integration
- Q3: Automated enterprise workflows`;

      const html = formatPowerPointPresentationPreviewHtml("enterprise_roadmap.pptx", samplePptx);

      expect(html).toContain("Microsoft PowerPoint Presentation (.pptx)");
      expect(html).toContain("ppt-ribbon");
      expect(html).toContain("2 Slides");
      expect(html).toContain("ppt-slide-card");
      expect(html).toContain("Slide 1 of 2");
      expect(html).toContain("Enterprise AI Roadmap 2026");
      expect(html).toContain("Slide 2 of 2");
      expect(html).toContain("Key Milestones");
      expect(html).toContain("ppt-bullet-list");
      expect(html).toContain("Q1: Zero-trust local folder indexing");
    });

    it("handles presentation text without explicit slide markers by grouping paragraphs", () => {
      const unformattedPpt = `Quarterly Review Summary
Overview of organizational KPIs across all departments.

Financial Performance
Revenue grew 24% year-over-year. Operating margin expanded to 18%.`;

      const html = formatPowerPointPresentationPreviewHtml("review.pptx", unformattedPpt);

      expect(html).toContain("ppt-ribbon");
      expect(html).toContain("ppt-slide-card");
      expect(html).toContain("Quarterly Review Summary");
      expect(html).toContain("Financial Performance");
    });
  });

  describe("formatPdfDocumentPreviewHtml", () => {
    it("renders authentic PDF Reader sheets with page headers, invoice tables, and PDF ribbon", () => {
      const samplePdfText = `[Page 1]
Invoice INV-00006
Synthetic vendor invoice created for document-ingestion and RAG testing.
Field: Value
Invoice ID: INV-00006
Vendor: OfficeHub
Total: $1,450.00
Status: Approved`;

      const html = formatPdfDocumentPreviewHtml("invoice_006.pdf", samplePdfText);

      expect(html).toContain("Portable Document Format");
      expect(html).toContain("pdf-ribbon");
      expect(html).toContain("invoice_006.pdf");
      expect(html).toContain("pdf-page-sheet");
      expect(html).toContain("Page 1 of 1");
      expect(html).toContain("pdf-table");
      expect(html).toContain("Invoice ID");
      expect(html).toContain("INV-00006");
      expect(html).toContain("OfficeHub");
      expect(html).toContain("$1,450.00");
    });
  });

  describe("formatCodeDocumentPreviewHtml", () => {
    it("renders dark developer IDE table with line numbers and syntax styling for JSON, Python, and SQL", () => {
      const jsonContent = `{\n  "service": "billing",\n  "port": 8080\n}`;
      const jsonHtml = formatCodeDocumentPreviewHtml("config.json", jsonContent);

      expect(jsonHtml).toContain("JSON Document");
      expect(jsonHtml).toContain("line-num");
      expect(jsonHtml).toContain("line-code");
      expect(jsonHtml).toContain("config.json");
      expect(jsonHtml).toContain("&quot;service&quot;");

      const pyContent = `def compute_tax(amount):\n    return amount * 0.18`;
      const pyHtml = formatCodeDocumentPreviewHtml("tax_calc.py", pyContent);

      expect(pyHtml).toContain("Python Script");
      expect(pyHtml).toContain("compute_tax");

      const sqlContent = `SELECT id, name FROM invoices WHERE status = 'paid';`;
      const sqlHtml = formatCodeDocumentPreviewHtml("query.sql", sqlContent);

      expect(sqlHtml).toContain("SQL Query / Schema");
      expect(sqlHtml).toContain("SELECT id, name FROM invoices");
    });
  });

  describe("formatTextDocumentPreviewHtml", () => {
    it("renders styled clean document paper for text/code files", () => {
      const text = `{"service": "nanvi-assistant", "version": "2.4.0", "status": "active"}`;
      const html = formatTextDocumentPreviewHtml("config.json", text);

      expect(html).toContain("config.json");
      expect(html).toContain("paper");
      expect(html).toContain("nanvi-assistant");
    });
  });
});


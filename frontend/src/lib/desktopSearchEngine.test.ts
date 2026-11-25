// @vitest-environment node
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);
const { DesktopSearchEngine } = require("../../electron/desktopSearchEngine.cjs");

describe("DesktopSearchEngine Node fallback", () => {
  it("indexes large text and >600 CSV rows without silent truncation", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanvi-dse-"));
    try {
      const finDir = path.join(tmpDir, "Finance");
      fs.mkdirSync(finDir, { recursive: true });

      const csvLines = ["id,vendor,status,notes"];
      for (let i = 1; i <= 750; i += 1) {
        csvLines.push(`${i},Vendor_${i},Overdue,LateRowSentinel_${i}`);
      }
      fs.writeFileSync(path.join(finDir, "large_ledger.csv"), csvLines.join("\n"), "utf8");

      const bigPad = "Operational telemetry baseline line.\n".repeat(2500);
      fs.writeFileSync(
        path.join(finDir, "long_report.txt"),
        `${bigPad}\nTrailingNeedleToken_85000\n`,
        "utf8"
      );

      const engine = new DesktopSearchEngine(path.join(tmpDir, "cache"));
      try {
        const resCsv = engine.search(tmpDir, "LateRowSentinel_745");
        expect(resCsv.total_matches).toBeGreaterThanOrEqual(1);
        expect(resCsv.files[0].name).toBe("large_ledger.csv");

        const resTxt = engine.search(tmpDir, "TrailingNeedleToken_85000");
        expect(resTxt.total_matches).toBeGreaterThanOrEqual(1);
        expect(resTxt.files[0].name).toBe("long_report.txt");
      } finally {
        engine.closeWatchers();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("enforces exact ID isolation, paid/unpaid/year invoice filters, and 30lpa numeric salary zero-match honesty", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanvi-dse-prec-"));
    try {
      const finDir = path.join(tmpDir, "Finance");
      const conDir = path.join(tmpDir, "Contracts");
      const hrDir = path.join(tmpDir, "HR");
      fs.mkdirSync(finDir, { recursive: true });
      fs.mkdirSync(conDir, { recursive: true });
      fs.mkdirSync(hrDir, { recursive: true });

      fs.writeFileSync(path.join(conDir, "NDA-0008.txt"), "Mutual NDA NDA-0008 Party A Asteron", "utf8");
      fs.writeFileSync(path.join(conDir, "EMP-0008.txt"), "Employment Agreement EMP-0008", "utf8");
      fs.writeFileSync(path.join(hrDir, "leave_policy.txt"), "Paid leave policy for employees", "utf8");
      fs.writeFileSync(
        path.join(hrDir, "employees.csv"),
        "employee_id,name,department,role,salary,status\nE-1,Asha Rao,Engineering,Architect,2190000,Active\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(finDir, "invoice_008.txt"),
        "Invoice INV-00008\nVendor: CloudNova\nInvoice Date: 2026-01-03\nCustomer: Vertex Logistics\nTotal: INR 106,984.70\nPayment Status: Paid\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(finDir, "invoice_010.txt"),
        "Invoice INV-00010\nVendor: CloudNova\nInvoice Date: 2025-10-28\nCustomer: Vertex Logistics\nTotal: INR 112,454.00\nPayment Status: Overdue\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(finDir, "invoice_004.txt"),
        "Invoice INV-00004\nVendor: Prime Telecom\nInvoice Date: 2025-01-28\nCustomer: BluePeak Solutions\nTotal: INR 174,199.86\nPayment Status: Overdue\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(conDir, "PUR-0001.txt"),
        "Purchase Agreement PUR-0001\nAgreement ID: PUR-0001\nBuyer: Asteron Technologies\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(finDir, "travel_policy.txt"),
        "Corporate Travel and Expense Payment Policy for employees.",
        "utf8"
      );

      const engine = new DesktopSearchEngine(path.join(tmpDir, "cache"));
      try {
        const resId = engine.search(tmpDir, "NDA-0008");
        expect(resId.files.map((f: any) => f.name)).toEqual(["NDA-0008.txt"]);

        const resPaid = engine.search(tmpDir, "invoice that was already paid");
        expect(resPaid.files.map((f: any) => f.name)).toEqual(["invoice_008.txt"]);

        const resUnpaidCust = engine.search(tmpDir, "list the customres they did'n paid");
        expect(resUnpaidCust.files.map((f: any) => f.name).sort()).toEqual(["invoice_004.txt", "invoice_010.txt"]);
        expect(resUnpaidCust.structured_summary).toContain("BluePeak Solutions");

        const res2026 = engine.search(tmpDir, "2026 invoic");
        expect(res2026.files.map((f: any) => f.name)).toEqual(["invoice_008.txt"]);

        const resVertexOverdue = engine.search(tmpDir, "Vertex Logistics invoice files that was overdue");
        expect(resVertexOverdue.files.map((f: any) => f.name)).toEqual(["invoice_010.txt"]);
        expect(resVertexOverdue.structured_summary).toContain("Vertex Logistics");
        expect(resVertexOverdue.structured_summary).not.toContain("BluePeak");

        const resVertexAll = engine.search(tmpDir, "Vertex Logistics invoice files");
        expect(resVertexAll.files.map((f: any) => f.name).sort()).toEqual(["invoice_008.txt", "invoice_010.txt"]);

        const resVertex2027 = engine.search(tmpDir, "Vertex Logistics 2027 overdue invoices");
        expect(resVertex2027.files).toEqual([]);
        expect(resVertex2027.structured_summary).toContain("No matching");

        const resPo = engine.search(tmpDir, "Find payment receipt or purchase order files");
        expect(resPo.files.map((f: any) => f.name)).toEqual(["PUR-0001.txt"]);
        expect(resPo.structured_summary).toContain("payment receipt");

        const resNoMix = engine.search(tmpDir, "Vertex Logistics NDA");
        expect(resNoMix.files).toEqual([]);
        expect(resNoMix.structured_summary).toContain("No documents matching **all** criteria");

        const resSalary = engine.search(tmpDir, "employee salary more then 30lpa");
        expect(resSalary.files).toEqual([]);
        expect(resSalary.zero_match).toBe(false);
        expect(resSalary.structured_summary).toContain("0 matches");
      } finally {
        engine.closeWatchers();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips partition system directories like $RECYCLE.BIN and System Volume Information safely", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanvi-dse-sys-"));
    try {
      const recycleBin = path.join(tmpDir, "$RECYCLE.BIN");
      const sysVol = path.join(tmpDir, "System Volume Information");
      const winRe = path.join(tmpDir, "$WinREAgent");
      const docsDir = path.join(tmpDir, "CompanyDocs");
      fs.mkdirSync(recycleBin, { recursive: true });
      fs.mkdirSync(sysVol, { recursive: true });
      fs.mkdirSync(winRe, { recursive: true });
      fs.mkdirSync(docsDir, { recursive: true });

      fs.writeFileSync(path.join(recycleBin, "deleted_junk.txt"), "Secret Deleted Document", "utf8");
      fs.writeFileSync(path.join(sysVol, "volume_meta.txt"), "Internal Windows Volume State", "utf8");
      fs.writeFileSync(path.join(winRe, "recovery_log.txt"), "Recovery Log Data", "utf8");
      fs.writeFileSync(path.join(docsDir, "quarterly_results.txt"), "Nanvi Enterprise Q4 Quarterly Results Report", "utf8");

      const engine = new DesktopSearchEngine(path.join(tmpDir, "cache"));
      try {
        const warmedCount = await engine.warmIndexAsync(tmpDir);
        expect(warmedCount).toBe(1);

        const resJunk = engine.search(tmpDir, "Secret Deleted Document");
        expect(resJunk.files).toEqual([]);

        const resVol = engine.search(tmpDir, "Volume State");
        expect(resVol.files).toEqual([]);

        const resValid = engine.search(tmpDir, "Quarterly Results");
        expect(resValid.files.length).toBe(1);
        expect(resValid.files[0].name).toBe("quarterly_results.txt");
      } finally {
        engine.closeWatchers();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("formats >5 paid invoices cleanly with key highlights, short filenames, and collapsible table", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanvi-dse-paid-"));
    try {
      const deepDir = path.join(tmpDir, "Finance", "Archive", "2026_Q1");
      fs.mkdirSync(deepDir, { recursive: true });
      for (let i = 1; i <= 7; i++) {
        fs.writeFileSync(
          path.join(deepDir, `paid_inv_${i}.txt`),
          `Invoice INV-900${i}\nCustomer: Vendor Corp ${i}\nAmount: 15000.00\nInvoice Date: 2026-02-0${i}\nPayment Status: Paid`,
          "utf8"
        );
      }

      const engine = new DesktopSearchEngine(path.join(tmpDir, "cache"));
      try {
        const res = engine.search(tmpDir, "list the invoices that already paid");
        const summary = res.structured_summary || "";
        expect(summary).toContain("**Key Highlights**");
        expect(summary).toContain("| Invoice | Party | Amount | Date | Source |");
        expect(summary).toContain("15,000.00");
        // No long nested subfolder paths in summary bullets/table
        expect(summary).not.toContain("Finance/Archive/2026_Q1");
        const bulletCount = summary.split("\n").filter((l: string) => l.startsWith("• ")).length;
        expect(bulletCount).toBe(5);
      } finally {
        engine.closeWatchers();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});


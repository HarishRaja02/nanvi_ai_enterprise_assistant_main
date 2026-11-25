/**
 * Generates dynamic, context-aware follow-up suggestions for chat responses.
 * All suggestions are strictly focused on finding other files, discovering linked documents,
 * and locating related enterprise files across folders.
 */

export interface FollowupContext {
  userQuery?: string;
  responseText: string;
  capability?: string;
  hasFiles?: boolean;
  hasTables?: boolean;
  fileNames?: string[];
}

export function generateFollowupSuggestions(ctx: FollowupContext): string[] {
  const rawQuery = (ctx.userQuery || "").trim();
  const query = rawQuery.toLowerCase();
  const text = (ctx.responseText || "").toLowerCase();
  const cap = (ctx.capability || "").toLowerCase();
  const suggestions: string[] = [];

  const isPurchaseOrReceipt =
    /\b(?:purchase\s+order|purchase\s+agreement|receipt|pur-\d+|po-\d+)\b/i.test(query);
  const hasContracts =
    !isPurchaseOrReceipt && (
      query.includes("contract") ||
      query.includes("agreement") ||
      query.includes("nda") ||
      text.includes("contract") ||
      text.includes("agreement")
    );
  const hasInvoices =
    !isPurchaseOrReceipt && (
      query.includes("invoice") ||
      query.includes("bill") ||
      query.includes("overdue") ||
      query.includes("unpaid") ||
      (query.includes("payment") && !query.includes("receipt")) ||
      text.includes("invoice")
    );
  const hasHr =
    query.includes("employee") ||
    query.includes("hr") ||
    query.includes("salary") ||
    query.includes("lpa") ||
    query.includes("staff") ||
    text.includes("employee");
  const hasReports =
    query.includes("report") ||
    query.includes("audit") ||
    query.includes("quarter") ||
    query.includes("annual");
  const hasSpreadsheets =
    query.includes("sheet") ||
    query.includes("excel") ||
    query.includes("csv") ||
    ctx.hasTables ||
    text.includes(".xlsx") ||
    text.includes(".csv");
  const hasEmails =
    query.includes("email") ||
    query.includes("mail") ||
    query.includes("outlook") ||
    cap.includes("email");

  const finalize = (candidates: string[]) =>
    candidates.filter((c) => c.trim().toLowerCase() !== query).slice(0, 3);

  // 0. Purchase Order / Purchase Agreement / Receipt Finding
  if (isPurchaseOrReceipt) {
    return finalize([
      "Find vendor invoices matching these purchase agreements",
      "Find contract register or MSA files in Contracts",
      "Can I find another purchase agreement file?",
    ]);
  }

  // 1. Invoice & Financial File Finding
  if (hasInvoices) {
    return finalize([
      "Can I find another invoice file like this?",
      "Find payment receipt or purchase order files",
      "Find contract files linked to these invoices",
    ]);
  }

  // 2. Contract & Legal Document Finding
  if (hasContracts) {
    return finalize([
      "Can I find another contract or agreement file?",
      "Find amendment or addendum documents",
      "Find NDA or compliance files in this folder",
    ]);
  }

  // 3. HR & Employee Document Finding
  if (hasHr) {
    return finalize([
      "Can I find other employee or HR files?",
      "Find company policy and handbook documents",
      "Find training and certification files",
    ]);
  }

  // 4. Spreadsheets & Data Files Finding
  if (hasSpreadsheets) {
    return finalize([
      "Can I find another spreadsheet or Excel file?",
      "Find CSV or financial sheet files in this folder",
      "Find quarterly report or budget files",
    ]);
  }

  // 5. Reports & Audit Documents Finding
  if (hasReports) {
    return finalize([
      "Can I find other report files in CompanyData?",
      "Find audit logs or compliance report files",
      "Find executive presentation or slide files",
    ]);
  }

  // 6. Email & Correspondence Document Finding
  if (hasEmails) {
    return finalize([
      "Can I find other email archive files?",
      "Find attachment files from these emails",
      "Find correspondence files from this sender",
    ]);
  }

  // 7. General File Discovery (Always file finding)
  return finalize([
    "Can I find another file like this?",
    "Find more files in this folder",
    "Find related PDF and document files",
  ]);
}

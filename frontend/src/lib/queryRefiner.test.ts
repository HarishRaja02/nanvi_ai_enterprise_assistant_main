import { describe, expect, it } from "vitest";
import { refineChatQuery } from "./queryRefiner";

describe("refineChatQuery precision refine layer", () => {
  it("corrects 'nandi' and phonetic mishearings to 'Nanvi' in assistant context and fixes clear typos", () => {
    expect(refineChatQuery("hi nandi").refinedQuery).toBe("hi Nanvi");
    expect(refineChatQuery("Hey Nandi, find overdue invoics").refinedQuery).toBe(
      "Hey Nanvi, find overdue invoices",
    );
    expect(refineChatQuery("nandi search proposl documnts").refinedQuery).toBe(
      "Nanvi search proposal documents",
    );
    expect(refineChatQuery("ok nanbi open contrct").refinedQuery).toBe(
      "ok Nanvi open contract",
    );
  });

  it("never alters legitimate Nandi entities, protected paths/filenames, codes, or ordinary English words", () => {
    const unchanged = [
      "find invoice for Nandi Traders",
      "directions to Nandi Hills",
      "open Nandi_Invoice.pdf",
      "check `nandi` config token and INV-001",
      "Mr. Nandi report",
      "Find invoice for Ganesh",
      "Check landing page and handy summary",
    ];
    for (const q of unchanged) {
      const res = refineChatQuery(q);
      expect(res.refinedQuery).toBe(q);
      expect(res.isCorrected).toBe(false);
    }

    // Protects "nandi" when a connected folder/file uses that name
    const workspaceProtected = refineChatQuery("hi nandi", {
      knownTerms: ["C:\\Work\\Nandi_Docs"],
    });
    expect(workspaceProtected.refinedQuery).toBe("hi nandi");
    expect(workspaceProtected.isCorrected).toBe(false);
  });
});


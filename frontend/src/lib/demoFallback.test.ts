import { describe, it, expect } from "vitest";
import { getDemoFallbackResponse } from "./demoFallback";
import type { ChatResponse } from "../api";

describe("getDemoFallbackResponse", () => {
  it("prioritizes email intent over local folder chunks for email queries", () => {
    const streamBody = JSON.stringify({
      query: "check my recent email and update me",
      context_override: {
        local_context: {
          chunks: [
            {
              citation: "H:\\PDF\\STUDY PDF\\EXP_1 updated (1).docx",
              text: "if ( input. value.match ( validRegex )) { alert('Valid email address!'); }",
            },
          ],
          files: [
            {
              name: "EXP_1 updated (1).docx",
              path: "H:\\PDF\\STUDY PDF\\EXP_1 updated (1).docx",
            },
          ],
        },
      },
    });

    const res = getDemoFallbackResponse<ChatResponse>("/chat", {
      method: "POST",
      body: streamBody,
    });

    expect(res).toBeDefined();
    expect(res?.capability).toBe("email");
    expect(res?.answer).toContain("Executive Mailbox Briefing");
    expect(res?.answer).not.toContain("Found matching records in your local folder");
    expect(res?.answer).not.toContain("Valid email address");
    expect(res?.file_results).toBeDefined();
    expect(res?.file_results?.length).toBeGreaterThan(0);
    expect(res?.file_results?.[0].source).toBe("email");
  });

  it("handles greetings directly without dumping local folder files", () => {
    const streamBody = JSON.stringify({
      query: "hello",
      context_override: {
        local_context: {
          chunks: [
            {
              citation: "H:\\PDF\\STUDY PDF\\EXP_1 updated (1).docx",
              text: "hello world sample code",
            },
          ],
          files: [{ name: "EXP_1 updated (1).docx", path: "H:\\PDF\\..." }],
        },
      },
    });

    const res = getDemoFallbackResponse<ChatResponse>("/chat", {
      method: "POST",
      body: streamBody,
    });

    expect(res).toBeDefined();
    expect(res?.capability).toBe("conversation");
    expect(res?.answer).toContain("Nanvi AI Enterprise Assistant");
    expect(res?.answer).not.toContain("Found matching records in your local folder");
  });

  it("returns local folder search results when querying for documents", () => {
    const streamBody = JSON.stringify({
      query: "EXP_1 updated",
      context_override: {
        local_context: {
          chunks: [
            {
              citation: "H:\\PDF\\STUDY PDF\\EXP_1 updated (1).docx",
              text: "Department of Artificial Intelligence lab experiment",
            },
          ],
          files: [
            {
              name: "EXP_1 updated (1).docx",
              path: "H:\\PDF\\STUDY PDF\\EXP_1 updated (1).docx",
            },
          ],
        },
      },
    });

    const res = getDemoFallbackResponse<ChatResponse>("/chat", {
      method: "POST",
      body: streamBody,
    });

    expect(res).toBeDefined();
    expect(res?.capability).toBe("knowledge");
    expect(res?.answer).toContain("Found matching records in your local folder for **EXP_1 updated**");
    expect(res?.answer).toContain("Department of Artificial Intelligence lab experiment");
  });
});


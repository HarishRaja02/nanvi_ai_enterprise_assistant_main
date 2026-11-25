import { describe, it, expect } from "vitest";
import { isEmailQuery } from "./isEmailQuery";

describe("isEmailQuery", () => {
  it("correctly identifies user queries asking for email/inbox", () => {
    expect(isEmailQuery("check my recent email and update me")).toBe(true);
    expect(isEmailQuery("check my recent email")).toBe(true);
    expect(isEmailQuery("check my emails")).toBe(true);
    expect(isEmailQuery("check email")).toBe(true);
    expect(isEmailQuery("recent email")).toBe(true);
    expect(isEmailQuery("recent emails")).toBe(true);
    expect(isEmailQuery("latest emails")).toBe(true);
    expect(isEmailQuery("show my emails")).toBe(true);
    expect(isEmailQuery("show my inbox")).toBe(true);
    expect(isEmailQuery("what's in my inbox")).toBe(true);
    expect(isEmailQuery("what is in my inbox")).toBe(true);
    expect(isEmailQuery("update me on my recent emails")).toBe(true);
    expect(isEmailQuery("any unread emails?")).toBe(true);
    expect(isEmailQuery("emails from Sarah")).toBe(true);
    expect(isEmailQuery("find my recent maile from the outlook")).toBe(true);
    expect(isEmailQuery("find my recent email from outlook")).toBe(true);
    expect(isEmailQuery("check outlook")).toBe(true);
    expect(isEmailQuery("show emails from microsoft")).toBe(true);
    expect(isEmailQuery("get my emails")).toBe(true);
    expect(isEmailQuery("inbox briefing")).toBe(true);
    expect(isEmailQuery("Check my recent emails and summarize the latest messages")).toBe(true);
    expect(isEmailQuery("Check my recent unread emails and highlight pending action items")).toBe(true);
    expect(isEmailQuery("Check my recent emails for urgent updates and important announcements")).toBe(true);
  });

  it("does not classify explicit file/document search as email queries", () => {
    expect(isEmailQuery("find email.html in local folder")).toBe(false);
    expect(isEmailQuery("search files for email validation")).toBe(false);
    expect(isEmailQuery("email policy document")).toBe(false);
    expect(isEmailQuery("EXP_1 updated (1).docx")).toBe(false);
    expect(isEmailQuery("search folder for email scripts")).toBe(false);
    expect(isEmailQuery("show email.pdf")).toBe(false);
    expect(isEmailQuery("find email.docx")).toBe(false);
  });

  it("does not classify other queries as email queries", () => {
    expect(isEmailQuery("hello")).toBe(false);
    expect(isEmailQuery("what is our company revenue for Q3?")).toBe(false);
    expect(isEmailQuery("summarize active enterprise contracts")).toBe(false);
    expect(isEmailQuery("who is the CEO?")).toBe(false);
    expect(isEmailQuery("what files are in my folder?")).toBe(false);
  });
});


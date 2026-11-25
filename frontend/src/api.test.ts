import { describe, expect, it, vi } from "vitest";
import { ApiError, NanviApiClient } from "./api";

describe("NanviApiClient", () => {
  it("attaches bearer authentication without putting credentials in request bodies", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ subject: "u1", roles: ["Employee"] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const api = new NanviApiClient({ getAccessToken: async () => "test-token" });
    await api.me();
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Headers).get("Authorization")).toBe("Bearer test-token");
    expect(init?.body).toBeUndefined();
  });

  it("turns backend errors into safe typed errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } }));
    const api = new NanviApiClient();
    await expect(api.history()).rejects.toMatchObject({ status: 403, message: "Forbidden" });
  });

  it("handles rate limiting and Retry-After", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "Rate limit exceeded" }), { status: 429, headers: { "Retry-After": "12", "Content-Type": "application/json" } }));
    const api = new NanviApiClient();
    await expect(api.history()).rejects.toMatchObject({ status: 429, retryAfter: 12, message: "Too many requests. Please try again in 12s." });
  });

  it("invokes the unauthorized callback on 401", async () => {
    const onUnauthorized = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "Invalid" }), { status: 401, headers: { "Content-Type": "application/json" } }));
    const api = new NanviApiClient({ onUnauthorized });
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("encodes opaque source references", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ reference_id: "x" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const api = new NanviApiClient({ baseUrl: "/api" });
    await api.source("a/b?c");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sources/a%2Fb%3Fc");
  });

  it("fetches and updates conversation context", async () => {
    const ctx = { conversation_id: "c1", active_page: { route: "/finance", page_type: "finance", title: "Finance" } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(ctx), { status: 200, headers: { "Content-Type": "application/json" } }))
    );
    const api = new NanviApiClient({ baseUrl: "/api" });
    const result = await api.getContext("c1");
    expect(result.conversation_id).toBe("c1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/chat/context/c1");

    await api.updateContext("c1", { active_page: { route: "/customers", page_type: "customers", title: "Customers" } });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/chat/context/c1");
    expect(JSON.parse((fetchMock.mock.calls[1][1]?.body as string) || "{}").active_page.route).toBe("/customers");
  });

  it("streamChat reads SSE frames and invokes onEvent", async () => {
    const sseBody = `data: {"event": "task_started", "task_id": "t1", "request_id": "r1", "timestamp": "2026-09-28T00:00:00Z", "payload": {"query": "hi"}}\n\ndata: {"event": "task_complete", "task_id": "t1", "request_id": "r1", "timestamp": "2026-09-28T00:00:00Z", "payload": {"conversation_id": "c1", "answer": "Hello!", "capability": "knowledge", "sources": [], "trace": []}}\n\n`;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const events: string[] = [];
    const api = new NanviApiClient();
    const resp = await api.streamChat({ query: "hi", conversationId: "c1" }, (e) => events.push(e.event));
    expect(events).toEqual(["task_started", "task_complete"]);
    expect(resp.answer).toBe("Hello!");
  });

  it("preserves server file_results and sources when desktop local folder search has zero matches", () => {
    const api = new NanviApiClient({ baseUrl: "/api" }) as unknown as {
      reconcileDesktopChatResponse: (res: any, localCtx: any, query: string) => any;
    };
    const serverRes = {
      conversation_id: "c-proposal",
      answer: "Found matching proposals.",
      capability: "knowledge",
      sources: [
        {
          reference_id: "ref-1",
          source_type: "file",
          display_name: "Nanvi_Overnight_Customer_Chat_Support_Proposal.pdf",
          title: "Nanvi_Overnight_Customer_Chat_Support_Proposal.pdf",
          location: "Office/Proposal/Customer Support/Nanvi_Overnight_Customer_Chat_Support_Proposal.pdf",
        },
      ],
      file_results: [
        {
          name: "Nanvi_Overnight_Customer_Chat_Support_Proposal.pdf",
          path: "Office/Proposal/Customer Support/Nanvi_Overnight_Customer_Chat_Support_Proposal.pdf",
          full_path: "Office/Proposal/Customer Support/Nanvi_Overnight_Customer_Chat_Support_Proposal.pdf",
        },
      ],
      trace: [],
      history: [],
    };
    const localZeroCtx = {
      folder_path: "C:\\Users\\sylvia\\Documents",
      files: [],
      chunks: [],
      zero_match: true,
      folder_stats: { total_files: 5, categories: {} },
    };

    const reconciled = api.reconcileDesktopChatResponse(serverRes, localZeroCtx, "proposal files");
    expect(reconciled.file_results).toHaveLength(1);
    expect(reconciled.sources).toHaveLength(1);
    expect(reconciled.file_results[0].name).toBe("Nanvi_Overnight_Customer_Chat_Support_Proposal.pdf");
  });
});

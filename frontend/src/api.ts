import { getDemoFallbackResponse } from "./lib/demoFallback";
import { isEmailQuery } from "./lib/isEmailQuery";
import {
  clearDesktopLocalFolder,
  getDesktopLocalStatus,
  queryDesktopLocalContext,
} from "./lib/browserFolderSync";



export type ApiClientOptions = {

  baseUrl?: string;

  getAccessToken?: () => Promise<string | null>;

  onUnauthorized?: () => void;

};



export type SafeUECPState = {

  connected: boolean;

  allowed: boolean;

  features?: Record<string, boolean>;

};



export type UserIdentity = {

  subject: string;

  issuer: string;

  email?: string | null;

  name?: string | null;

  tenant_id?: string | null;

  department?: string | null;

  roles: string[];

  uecp?: SafeUECPState | null;

};



export type LocalAccountRole = "Superior" | "Supervisor" | "Project Engineer" | "Employee" | "Intern" | "Admin";

export type LocalAccount = {

  id: string;

  username: string;

  role: LocalAccountRole;

  display_name: string;

  email?: string | null;

  department?: string | null;

  active: boolean;

  created_at?: string | null;

  email_dispatched?: boolean;

  email_error?: string | null;

};

export type LocalAccountCreate = Omit<LocalAccount, "id" | "active" | "created_at" | "email"> & {
  password: string;
  email: string;
};

export type LocalAccountUpdate = Partial<Omit<LocalAccount, "id" | "username" | "created_at">>;



export type ForgotPasswordResponse = {

  status: string;

  message: string;

  dev_reset_link?: string;

};



export type VerifyResetTokenResponse = {

  valid: boolean;

  username: string;

  email: string;

  display_name: string;

};



export type ResetPasswordResponse = {

  status: string;

  message: string;

};



export type ChatSource = {

  reference_id: string;

  source_type: string;

  display_name: string;

  title?: string | null;

  location?: string | null;

  page?: number | null;

  sheet?: string | null;

  timestamp?: string | null;

  mime_type?: string | null;

  href?: string | null;

  snippet?: string | null;

  content?: string | null;

};



export type ChatResponse = {

  conversation_id: string;

  answer: string;

  capability: string;

  sources: ChatSource[];

  trace: string[];

  history: Array<{ role: "user" | "assistant"; content: string; created_at: string }>;

  report_id?: string | null;

  data_source?: "live" | "synthetic" | string;

  source_selection_required?: boolean;

  pending_search_query?: string;

  file_results?: Array<{

    name: string;

    path: string;

    type?: string;

    open_url?: string;

    full_path?: string;

    display_path?: string;

    modified_at?: string;

    source?: string;

    content_snippet?: string;

  }>;

};



export type VoiceResponse = {

  conversation_id: string;

  answer: string;

  spoken_text: string;

  screen_message?: string;

  highlights?: string[];

  suggested_actions?: string[];

  ui_specs?: any[];

  sensitivity?: string;

  confidence_level?: string;

  important_points: string[];

  capability: string;

  sources: ChatSource[];

  trace: string[];

  history: Array<{ role: "user" | "assistant"; content: string; created_at: string }>;

  report_id?: string | null;

  user_preferences?: {

    verbosity?: string;

    privacy_mode?: boolean;

    language?: string;

  };

};



export type RealtimeVoiceStatus = {

  enabled: boolean;

  model: string | null;

};



export type PageContext = {

  route: string;

  page_type: string;

  title: string;

};



export type EntityContext = {

  type: string;

  id: string;

  name: string;

  data?: Record<string, unknown>;

};



export type DocumentContext = {

  document_id: string;

  filename: string;

  page?: number | null;

};



export type UserPreferences = {

  verbosity: "concise" | "detailed" | string;

  privacy_mode: boolean;

  language: string;

};



export type ConversationState = {

  turn_state: "idle" | "listening" | "thinking" | "speaking" | "interrupted" | string;

};



export type ConversationContext = {

  session_id: string;

  conversation_id: string;

  user: {

    id: string;

    role: string;

    department?: string | null;

    tenant_id: string;

    permissions: string[];

  };

  active_page: PageContext;

  active_entity?: EntityContext | null;

  active_document?: DocumentContext | null;

  last_intent?: string | null;

  last_result_ref?: string | null;

  last_ui?: Record<string, unknown> | null;

  last_sources: ChatSource[];

  ui_entity_index: Record<string, unknown>;

  user_preferences: UserPreferences;

  conversation_state: ConversationState;

  updated_at?: string;

};



export type StreamEvent<T = Record<string, unknown>> = {

  event:

  | "task_started"

  | "status"

  | "partial_transcript"

  | "final_transcript"

  | "assistant_text"

  | "audio_start"

  | "audio_chunk"

  | "audio_end"

  | "audio_cancelled"

  | "ui_spec"

  | "action_suggestions"

  | "highlight"

  | "source_found"

  | "source_verified"

  | "task_complete"

  | "task_error";

  task_id: string;

  request_id: string;

  timestamp: string;

  payload: T;

};



export type Conversation = {

  conversation_id: string;

  title?: string | null;

  created_at?: string;

  updated_at?: string;

  message_count?: number;

};



export type UploadDocumentResponse = {

  status: string;

  filename: string;

  path: string;

  size_bytes: number;

  message: string;

};



export type UserLogEntry = {

  id: string;

  user_id: string;

  user_name: string;

  user_role: string;

  tenant_id: string;

  query: string;

  answer: string;

  capability?: string;

  model?: string;

  created_at: string;

  log_date: string;

};



export type UserLogDatesResponse = {

  dates: string[];

  today: string;

};



export type UserLogsResponse = {

  logs: UserLogEntry[];

  total: number;

  date?: string | null;

};



export class ApiError extends Error {

  readonly status: number;

  readonly retryAfter?: number;



  constructor(message: string, status: number, retryAfter?: number) {

    super(message);

    this.name = "ApiError";

    this.status = status;

    this.retryAfter = retryAfter;

  }

}



/**

 * Thin, typed boundary to FastAPI. The UI never treats local role state as authorization.

 * Production identity/permissions always come from the backend.

 */

export class NanviApiClient {

  private readonly baseUrl: string;

  private readonly desktopCloudUrl: string | null;

  private useDesktopCloud = false;

  private readonly getAccessToken?: () => Promise<string | null>;

  private readonly onUnauthorized?: () => void;



  constructor(options: ApiClientOptions = {}) {

    const rawEnvBase = (

      typeof import.meta !== "undefined" && (

        import.meta.env?.VITE_API_BASE_URL ||

        import.meta.env?.VITE_API_URL

      )

    ) || "";

    const envBase = (typeof rawEnvBase === "string" ? rawEnvBase : "").trim();

    const envBaseNormalized = envBase

      ? (envBase.endsWith("/api") ? envBase : `${envBase.replace(/\/$/, "")}/api`)

      : "";

    const isDesktopOrigin = typeof window !== "undefined" && (

      window.location.protocol === "file:" ||

      Boolean((window as any).electronAPI?.isDesktop)

    );

    const CLOUD_API_URL = "https://nanviaienterpriseassistant.vercel.app/api";



    // Desktop mode (EXE, MSIX, Electron):
    // By default, connect directly to the Vercel Cloud API (https://nanviaienterpriseassistant.vercel.app/api).
    // Client installations do not bundle credentials or require local .env / Python environments;
    // all AI models, database connections, and OAuth endpoints live securely on Vercel.
    let defaultBase = isDesktopOrigin ? CLOUD_API_URL : (envBaseNormalized || "/api");
    let cloudFallback: string | null = isDesktopOrigin ? (envBaseNormalized || CLOUD_API_URL) : null;



    if (isDesktopOrigin && typeof localStorage !== "undefined") {

      const customUrl = localStorage.getItem("nanvi_custom_server_url");

      if (customUrl) {

        defaultBase = customUrl.endsWith("/api") ? customUrl : `${customUrl.replace(/\/$/, "")}/api`;

        cloudFallback = null;

      }

    }

    this.baseUrl = (options.baseUrl ?? defaultBase).replace(/\/$/, "");

    this.desktopCloudUrl = this.baseUrl.includes("127.0.0.1:8000") || this.baseUrl.includes("localhost:8000")
      ? CLOUD_API_URL
      : null;

    this.getAccessToken = options.getAccessToken;

    this.onUnauthorized = options.onUnauthorized;

  }



  private activeBase(): string {

    return this.useDesktopCloud && this.desktopCloudUrl ? this.desktopCloudUrl : this.baseUrl;

  }



  private async fetchWithTimeout(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
    if (init?.signal || typeof AbortController === "undefined") {
      return await fetch(url, init);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchWithDesktopFailover(path: string, init?: RequestInit): Promise<Response> {
    const activeUrl = this.activeBase();
    const isLocalhost = activeUrl.includes("127.0.0.1:8000") || activeUrl.includes("localhost:8000");
    try {
      return await this.fetchWithTimeout(`${activeUrl}${path}`, init, isLocalhost ? 20000 : 45000);
    } catch (err) {
      if (!this.useDesktopCloud && this.desktopCloudUrl && this.baseUrl.includes("127.0.0.1:8000")) {
        const res = await this.fetchWithTimeout(`${this.desktopCloudUrl}${path}`, init, 45000);
        this.useDesktopCloud = true;
        return res;
      }
      throw err;
    }
  }



  private async request<T>(path: string, init: RequestInit = {}, suppressUnauthorized = false): Promise<T> {

    const token = this.getAccessToken ? await this.getAccessToken() : null;

    const headers = new Headers(init.headers);

    headers.set("Accept", "application/json");

    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);



    let response: Response | undefined;
    try {
      response = await this.fetchWithDesktopFailover(path, { ...init, headers });
    } catch {
      response = undefined;
    }



    if (!response) {

      const fallback = getDemoFallbackResponse<T>(path, init);

      if (fallback !== undefined) return fallback;

      throw new ApiError("Nanvi is unreachable. Check your connection and try again.", 0);

    }



    if (response.status === 401 && !suppressUnauthorized) {

      this.onUnauthorized?.();

    }



    if (!response.ok) {

      let detail = "Nanvi could not complete the request.";



      try {

        const body = (await response.json()) as { detail?: string };



        if (typeof body.detail === "string" && body.detail.trim()) {

          detail = body.detail;

        }

      } catch {

        // Preserve the safe generic message when the backend returns non-JSON content.

      }



      const retryAfterHeader = response.headers.get("Retry-After");

      const retryAfter = retryAfterHeader

        ? Number.parseInt(retryAfterHeader, 10)

        : undefined;



      if (response.status === 413) {

        if (!detail || detail === "Request failed") {

          detail = "File exceeds the maximum upload size limit (3 MB on cloud).";

        }

      }



      if (response.status === 429) {

        detail = `Too many requests. Please try again${retryAfter ? ` in ${retryAfter}s` : " shortly"

          }.`;

      }



      if (response.status === 503 && detail && detail !== "Request failed") {

        // Preserve structured service-unavailable guidance from backend

      } else if (response.status >= 500) {

        detail = "Nanvi is temporarily unavailable. Please try again.";

      }



      throw new ApiError(

        detail,

        response.status,

        Number.isFinite(retryAfter) ? retryAfter : undefined

      );

    }



    if (response.status === 204) return undefined as T;

    return response.json() as Promise<T>;

  }



  me() { return this.request<UserIdentity>("/auth/me"); }



  uecpStatus() { return this.request<SafeUECPState>("/uecp/status"); }



  uecpHealth() { return this.request<{ configured: boolean; reachable: boolean }>("/health/uecp"); }



  localLogin(username: string, password: string, role?: LocalAccountRole | string) {

    return this.request<{ access_token: string; token_type: string; expires_in: number }>(

      "/auth/login",

      { method: "POST", body: JSON.stringify({ username, password, role }) },

      true,

    );

  }



  forgotPassword(username: string, email: string) {

    return this.request<ForgotPasswordResponse>(

      "/auth/forgot-password",

      { method: "POST", body: JSON.stringify({ username, email }) },

      true,

    );

  }



  verifyResetToken(token: string) {

    return this.request<VerifyResetTokenResponse>(

      `/auth/verify-reset-token?token=${encodeURIComponent(token)}`,

      { method: "GET" },

      true,

    );

  }



  resetPasswordWithToken(token: string, newPassword: string) {

    return this.request<ResetPasswordResponse>(

      "/auth/reset-password",

      { method: "POST", body: JSON.stringify({ token, new_password: newPassword }) },

      true,

    );

  }



  registerAccount(account: { username: string; email: string; password: string; display_name: string; department?: string }) {

    return this.request<LocalAccount>(

      "/auth/register",

      { method: "POST", body: JSON.stringify(account) },

      true,

    );

  }



  listLocalAccounts() { return this.request<LocalAccount[]>("/auth/accounts"); }

  createLocalAccount(account: LocalAccountCreate) {
    return this.request<LocalAccount>("/auth/accounts", { method: "POST", body: JSON.stringify(account) });
  }

  updateLocalAccount(id: string, updates: LocalAccountUpdate) {
    return this.request<LocalAccount>(`/auth/accounts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  deleteLocalAccount(id: string) {
    return this.request<void>(`/auth/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  listDepartments() {
    return this.request<string[]>("/auth/departments");
  }

  addDepartment(name: string) {
    return this.request<string[]>("/auth/departments", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }



  private reconcileDesktopChatResponse(res: ChatResponse, localCtx: any, query: string): ChatResponse {
    if (!localCtx || typeof localCtx !== "object") return res;
    const localFiles = Array.isArray(localCtx.files) ? localCtx.files : [];
    const localSummary = String(localCtx.structured_summary || "").trim();
    const isLocalZero = Boolean(localCtx.zero_match) || (localFiles.length === 0 && Boolean(localSummary));

    const resFiles = Array.isArray(res.file_results) ? res.file_results : [];
    const resSources = Array.isArray(res.sources) ? res.sources : [];
    const hasNonLocalSource = resSources.some((s) => {
      const st = String(s.source_type || "").toLowerCase();
      return st && st !== "file" && st !== "local";
    });
    if (hasNonLocalSource) return res;

    const answer = String(res.answer || "");
    const ansLow = answer.toLowerCase();
    const isGenericLocalTable =
      ansLow.includes("matching document") && ansLow.includes("local storage");
    const isUnhelpfulBackend =
      ansLow.includes("couldn't find") ||
      ansLow.includes("could not find") ||
      ansLow.includes("how can i assist") ||
      ansLow.includes("unable to process your request");

    const hasUsefulServerAnswer =
      resFiles.length > 0 ||
      resSources.length > 0 ||
      (!isUnhelpfulBackend && !isGenericLocalTable && answer.trim().length > 0);

    if (isLocalZero) {
      // Never wipe valid server file_results / sources / markdown file tables when another machine lacks the local folder.
      if (hasUsefulServerAnswer && !localSummary) {
        return res;
      }
      if (resFiles.length > 0 || resSources.length > 0) {
        return res;
      }
      const stats = localCtx.folder_stats;
      const cats = stats?.categories
        ? Object.entries(stats.categories).slice(0, 8).map(([k, v]) => `${k} (${v})`).join(", ")
        : "";
      const fallbackZero =
        localSummary ||
        `No documents matching **${query}** were found in your connected folder.` +
          (stats?.total_files ? `\n\nScanned **${stats.total_files}** indexed files${cats ? ` across: ${cats}.` : "."}` : "");
      return {
        ...res,
        answer: localSummary || (isUnhelpfulBackend ? fallbackZero : answer || fallbackZero),
        file_results: [],
        sources: [],
      };
    }

    if (localSummary && (isGenericLocalTable || isUnhelpfulBackend || !answer.trim())) {
      const excerptMarker = /\*\*Relevant Document Excerpts:?\*\*/i;
      const hasMoreLine = localCtx.has_more && typeof localCtx.total_matches === "number"
        ? `\n\n💡 **${Math.max(0, localCtx.total_matches - ((localCtx.offset || 0) + localFiles.length))} more matching files available.** Say **"I need more"** or **"next set"** to load the next batch.`
        : "";
      return {
        ...res,
        answer: `${localSummary}${hasMoreLine}`,
        file_results: localFiles.length > 0 ? localFiles : res.file_results,
      };
    }

    if (localFiles.length > 0 && (!res.file_results || res.file_results.length === 0)) {
      return { ...res, file_results: localFiles };
    }
    return res;
  }

  async chat(
    query: string,
    conversationId?: string,
    ragEnabled: boolean = true,
    activeDocumentId?: string,
    contextOverride?: Record<string, unknown>,
  ) {
    let effContext = contextOverride;
    let localCtx: any = null;
    const skipLocalFolderRAG = isEmailQuery(query);
    if (ragEnabled !== false && getDesktopLocalStatus() && !skipLocalFolderRAG) {
      localCtx = await queryDesktopLocalContext(query, 8, 10, conversationId || "__default__");
      if (localCtx) {
        effContext = { ...contextOverride, local_context: localCtx };
      }
    }

    const res = await this.request<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify({
        query,
        conversation_id: conversationId,
        rag_enabled: ragEnabled,
        active_document_id: activeDocumentId,
        context_override: effContext,
      }),
    });
    return this.reconcileDesktopChatResponse(res, localCtx, query);
  }



  async fileSearch(query: string, source: string, conversationId?: string, maxResults: number = 10) {
    let localFiles: unknown;
    if (source === "local" && getDesktopLocalStatus()) {
      const localCtx = await queryDesktopLocalContext(query, 8, maxResults);
      if (localCtx?.files?.length) {
        localFiles = localCtx.files;
      }
    }

    return this.request<{

      conversation_id: string;

      answer: string;

      files: Array<{

        name: string;

        path: string;

        type?: string;

        open_url?: string;

        full_path?: string;

        display_path?: string;

        modified_at?: string;

        source?: string;

        content_snippet?: string;

      }>;

      total_count: number;

      source: string;

      capability: string;

      sources: ChatSource[];

    }>("/chat/file-search", {

      method: "POST",

      body: JSON.stringify({

        query,

        source,

        conversation_id: conversationId,

        max_results: maxResults,

        local_files: localFiles,

      }),

    });

  }



  openFile(filePath: string) {
    return this.request<{ status: string; opened?: string; message?: string; queued?: boolean; local?: boolean; desktop_agent_online?: boolean }>("/local-agent/open-file", {
      method: "POST",
      body: JSON.stringify({ file_path: filePath }),
    });
  }



  async getDocumentBlob(filePath: string, download = false): Promise<{ blob: Blob; filename: string; mimeType: string }> {

    const token = this.getAccessToken ? await this.getAccessToken() : null;

    const headers = new Headers();

    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);



    const dlParam = download ? "&download=true" : "";

    const response = await this.fetchWithDesktopFailover(
      `/local-agent/document-content?path=${encodeURIComponent(filePath)}${dlParam}`,
      { headers, credentials: "same-origin" }
    );

    if (!response.ok) {

      throw new ApiError(`Failed to load document (${response.status})`, response.status);

    }

    const blob = await response.blob();

    const disposition = response.headers.get("Content-Disposition") || "";

    let filename = filePath.split(/[/\\]/).pop() || "document";

    const match = disposition.match(/filename="?([^";]+)"?/);

    if (match && match[1]) filename = match[1];



    return {

      blob,

      filename,

      mimeType: blob.type || "application/octet-stream",

    };

  }



  getContext(conversationId: string) {

    return this.request<ConversationContext>(`/chat/context/${encodeURIComponent(conversationId)}`);

  }



  updateContext(conversationId: string, updates: Partial<ConversationContext>) {

    return this.request<ConversationContext>(`/chat/context/${encodeURIComponent(conversationId)}`, {

      method: "PUT",

      body: JSON.stringify(updates),

    });

  }



  async streamChat(

    options: {

      query: string;

      conversationId?: string;

      ragEnabled?: boolean;

      activeDocumentId?: string;

      contextOverride?: Record<string, unknown>;

    },

    onEvent: (event: StreamEvent) => void,

    signal?: AbortSignal,

  ): Promise<ChatResponse> {

    const token = this.getAccessToken ? await this.getAccessToken() : null;

    const headers = new Headers();

    headers.set("Content-Type", "application/json");

    headers.set("Accept", "text/event-stream");

    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);



    let effContext = options.contextOverride;
    let localCtxRef: any = (effContext as Record<string, any> | undefined)?.local_context || null;
    const skipLocalFolderRAG = isEmailQuery(options.query);
    if (options.ragEnabled !== false && getDesktopLocalStatus() && !skipLocalFolderRAG) {
      const localCtx = await queryDesktopLocalContext(
        options.query,
        8,
        10,
        options.conversationId || "__default__",
      );
      if (localCtx) {
        localCtxRef = localCtx;
        effContext = { ...options.contextOverride, local_context: localCtx };
      }
    }

    const streamBody = JSON.stringify({
      query: options.query,
      conversation_id: options.conversationId,
      rag_enabled: options.ragEnabled ?? true,
      active_document_id: options.activeDocumentId,
      context_override: effContext,
    });

    let response: Response;
    try {
      response = await this.fetchWithDesktopFailover("/chat/stream", {
        method: "POST",
        headers,
        body: streamBody,
        credentials: "same-origin",
        signal,
      });
    } catch (err) {
      const localCtx = (effContext as Record<string, any> | undefined)?.local_context;
      const localSlmUrlRaw =
        typeof window !== "undefined" ? window.localStorage?.getItem("nanvi_local_llm_url")?.trim() : "";
      if (localSlmUrlRaw && localCtx && Array.isArray(localCtx.chunks) && localCtx.chunks.length > 0) {
        try {
          const parsedUrl = new URL(localSlmUrlRaw);
          if (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost") {
            const localModel =
              window.localStorage?.getItem("nanvi_local_llm_model")?.trim() || "llama3.2:3b";
            const excerpts = localCtx.chunks
              .slice(0, 6)
              .map((c: any) => `[${c.citation || c.filename || "doc"}]\n${String(c.text || "").slice(0, 900)}`)
              .join("\n\n");
            const slmRes = await fetch(parsedUrl.toString(), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal,
              body: JSON.stringify({
                model: localModel,
                temperature: 0.1,
                messages: [
                  {
                    role: "system",
                    content:
                      "Answer strictly from the provided authorized local document excerpts with file citations.",
                  },
                  { role: "user", content: `Excerpts:\n${excerpts}\n\nQuestion: ${options.query}` },
                ],
              }),
            });
            if (slmRes.ok) {
              const slmJson = (await slmRes.json()) as {
                choices?: Array<{ message?: { content?: string } }>;
              };
              const slmAnswer = slmJson.choices?.[0]?.message?.content?.trim();
              if (slmAnswer) {
                const matchedFiles = Array.isArray(localCtx.files) ? localCtx.files : [];
                const slmPayload: ChatResponse = {
                  conversation_id: options.conversationId || `conv-${Date.now()}`,
                  answer: `${slmAnswer}\n\n> **Offline Local SLM Mode** (${localModel}): Synthesized strictly from retrieved on-device citations.`,
                  capability: "knowledge",
                  sources: matchedFiles.map((f: any, idx: number) => ({
                    reference_id: `desk-slm-${idx}`,
                    source_type: "file",
                    display_name: f.name || "document",
                    title: f.name || "document",
                    location: f.full_path || f.path || "",
                  })),
                  trace: [
                    `Offline Multi-Engine Retrieval (${Array.isArray(localCtx.engines_used) ? localCtx.engines_used.join(" + ") : "local"})`,
                    `Local OpenAI-compatible SLM synthesis (${localModel})`,
                  ],
                  history: [
                    { role: "user", content: options.query, created_at: new Date().toISOString() },
                    { role: "assistant", content: slmAnswer, created_at: new Date().toISOString() },
                  ],
                  file_results: matchedFiles,
                };
                onEvent({
                  event: "task_complete",
                  payload: slmPayload as unknown as Record<string, unknown>,
                } as StreamEvent);
                return slmPayload;
              }
            }
          }
        } catch {
          // Local SLM not running or unreachable; fall through to honest offline retrieval response.
        }
      }
      const fallback = getDemoFallbackResponse<ChatResponse>("/chat", { method: "POST", body: streamBody });
      if (fallback) {
        onEvent({ event: "task_complete", payload: fallback as unknown as Record<string, unknown> } as StreamEvent);
        return fallback;
      }
      throw err;
    }



    if (!response.ok) {

      throw new ApiError("Failed to initiate streaming chat", response.status);

    }



    if (!response.body) {

      throw new ApiError("No response stream body available", 0);

    }



    const reader = response.body.getReader();

    const decoder = new TextDecoder();

    let buffer = "";

    let finalResponse: ChatResponse | null = null;



    try {

      while (true) {

        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });



        const lines = buffer.split("\n");

        buffer = lines.pop() ?? "";



        for (const line of lines) {

          const trimmed = line.trim();

          if (trimmed.startsWith("data: ")) {

            try {

              const eventData = JSON.parse(trimmed.slice(6)) as StreamEvent;

              onEvent(eventData);

              if (eventData.event === "task_complete") {

                const payload = eventData.payload as unknown as ChatResponse;

                const reconciled = this.reconcileDesktopChatResponse(payload, localCtxRef, options.query);
                finalResponse = {

                  conversation_id: reconciled.conversation_id,

                  answer: reconciled.answer,

                  capability: reconciled.capability,

                  sources: reconciled.sources || [],

                  trace: reconciled.trace || [],

                  history: reconciled.history || [],

                  report_id: reconciled.report_id,

                  file_results: reconciled.file_results,

                };

              }

            } catch {

              // Ignore partial or unparseable event chunks

            }

          }

        }

      }

    } finally {

      reader.releaseLock();

    }



    if (finalResponse) return finalResponse;

    return {

      conversation_id: options.conversationId || "",

      answer: "",

      capability: "",

      sources: [],

      trace: [],

      history: [],

    };

  }



  voiceRespond(

    query: string,

    conversationId?: string,

    ragEnabled: boolean = true,

    contextOverride?: Record<string, any>,

    confidence?: number,

  ) {

    return this.request<VoiceResponse>("/voice/respond", {

      method: "POST",

      body: JSON.stringify({

        query,

        conversation_id: conversationId,

        rag_enabled: ragEnabled,

        context_override: contextOverride,

        confidence,

      }),

    });

  }



  refineSpokenQuery(query: string, conversationId?: string) {

    return this.request<{

      status: "success" | "clarify";

      original_query: string;

      refined_query: string;

      is_corrected: boolean;

      clarification?: string | null;

      suggestions?: string[];

    }>("/voice/refine-query", {

      method: "POST",

      body: JSON.stringify({ query, conversation_id: conversationId }),

    });

  }



  getRealtimeVoiceStatus() {

    return this.request<RealtimeVoiceStatus>("/voice/realtime/status");

  }



  async openRealtimeVoiceSocket(

    conversationId?: string,

    ragEnabled: boolean = true,

    preferences: { verbosity: string; privacy_mode: boolean } = { verbosity: "normal", privacy_mode: false },

  ): Promise<WebSocket> {

    const token = this.getAccessToken ? await this.getAccessToken() : null;

    if (!token) throw new ApiError("Authentication is required for realtime voice.", 401);



    const socketUrl = new URL(`${this.activeBase()}/voice/realtime`, window.location.href);

    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

    const socket = new WebSocket(socketUrl);

    socket.addEventListener("open", () => {

      socket.send(JSON.stringify({

        type: "session.start",

        access_token: token,

        conversation_id: conversationId,

        rag_enabled: ragEnabled,

        preferences,

      }));

    }, { once: true });

    return socket;

  }



  executeVoiceIntent(

    intentId: string,

    parameters: Record<string, any> = {},

    conversationId?: string,

    confirmed: boolean = false,

    ragEnabled: boolean = true,

  ) {

    return this.request<VoiceResponse | { status: "confirmation_required"; intent_id: string; label: string; risk_level: string; message: string }>("/voice/intent/execute", {

      method: "POST",

      body: JSON.stringify({

        intent_id: intentId,

        parameters,

        conversation_id: conversationId,

        confirmed,

        rag_enabled: ragEnabled,

      }),

    });

  }



  listVoiceIntents() {

    return this.request<{ intents: Array<{ intent_id: string; label: string; description: string; category: string; risk_level: string; icon: string }> }>("/voice/intents");

  }



  reportVoiceBargeIn(latencyMs: number = 180.0) {

    return this.request<{ status: string; recorded_latency_ms: number }>("/voice/telemetry/barge-in", {

      method: "POST",

      body: JSON.stringify({ latency_ms: latencyMs }),

    });

  }



  getVoiceTelemetry() {

    return this.request<{

      total_queries: number;

      total_barge_ins: number;

      total_clarifications: number;

      total_errors: number;

      success_rate_percent: number;

      avg_latency_ms: number;

      p95_latency_ms: number;

      avg_barge_in_latency_ms: number;

      privacy_mode_queries: number;

      intents: Record<string, number>;

      languages: Record<string, number>;

      recent_events: Array<Record<string, any>>;

    }>("/voice/telemetry");

  }



  voiceTranscribe(audioBase64: string, mimeType: string = "audio/webm", filename: string = "recording.webm") {

    return this.request<{ text: string; confidence: number; no_speech?: boolean; reason?: string }>("/voice/transcribe", {

      method: "POST",

      body: JSON.stringify({ audio_base64: audioBase64, mime_type: mimeType, filename }),

    });

  }



  async voiceSynthesize(

    text: string,

    profileId: string = "nanvi-pro",

    language: string = "auto",

    signal?: AbortSignal

  ): Promise<Blob> {

    const token = this.getAccessToken ? await this.getAccessToken() : null;

    const headers = new Headers();

    headers.set("Content-Type", "application/json");

    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);



    const response = await this.fetchWithDesktopFailover("/voice/synthesize", {

      method: "POST",

      headers,

      body: JSON.stringify({ text, profile_id: profileId, language }),

      credentials: "same-origin",

      signal,

    });



    if (!response.ok) {

      throw new ApiError("Failed to synthesize neural voice", response.status);

    }



    return await response.blob();

  }



  uploadDocument(filename: string, contentBase64: string, conversationId?: string) {

    return this.request<UploadDocumentResponse>("/chat/upload", {

      method: "POST",

      body: JSON.stringify({ filename, content_base64: contentBase64, conversation_id: conversationId }),

    });

  }



  history() { return this.request<HistoryResponse>("/chat/history"); }



  conversation(conversationId: string) {

    return this.request<{ conversation_id: string; messages: Array<{ role: "user" | "assistant"; content: string; created_at: string }> }>(

      `/chat/history/${encodeURIComponent(conversationId)}`

    );

  }



  deleteConversation(conversationId: string) {

    return this.request<{ deleted: boolean; conversation_id: string }>(

      `/chat/history/${encodeURIComponent(conversationId)}`,

      { method: "DELETE" }

    );

  }



  clearHistory() {

    return this.request<{ deleted: boolean; count: number }>(

      "/chat/history",

      { method: "DELETE" }

    );

  }



  source(referenceId: string) {

    return this.request<SourceReference>(`/sources/${encodeURIComponent(referenceId)}`);

  }



  reportDownloadUrl(reportId: string) {

    return this.request<DownloadUrlResponse>(`/reports/${encodeURIComponent(reportId)}/download-url`, { method: "POST" });

  }



  devToken(username: string, password: string) {

    return this.request<{

      access_token: string;

      token_type: string;

      expires_in: number;

    }>("/dev/token", {

      method: "POST",

      body: JSON.stringify({

        username,

        password,

      }),

    });

  }



  emailStatus() {

    return this.request<EmailStatusResponse>("/email/status");

  }



  googleAuthUrl(redirectUri?: string) {

    const q = redirectUri ? `?redirect_uri=${encodeURIComponent(redirectUri)}` : "";

    return this.request<{ auth_url: string }>(`/email/oauth/google/url${q}`);

  }



  connectGoogleMailbox(code: string, state?: string, redirectUri?: string) {

    return this.request<{ status: string; account: EmailAccount }>("/email/oauth/google/callback", {

      method: "POST",

      body: JSON.stringify({ code, state, redirect_uri: redirectUri }),

    });

  }



  connectSavedEmail() {
    return this.request<{ status: string; account: EmailAccount }>("/email/oauth/google/connect-saved", {
      method: "POST",
    });
  }

  connectSavedMicrosoftEmail() {
    return this.request<{ status: string; account: EmailAccount }>("/email/oauth/microsoft/connect-saved", {
      method: "POST",
    });
  }

  connectSavedYahooEmail() {
    return this.request<{ status: string; account: EmailAccount }>("/email/connect/yahoo/connect-saved", {
      method: "POST",
    });
  }

  connectOutlookMailbox(emailAddress: string, password: string, displayName?: string) {
    return this.request<{ status: string; account: EmailAccount }>("/email/connect/outlook", {
      method: "POST",
      body: JSON.stringify({ email_address: emailAddress, password, display_name: displayName }),
    });
  }



  disconnectEmail(accountId?: string) {

    return this.request<{ status: string }>("/email/disconnect", {

      method: "POST",

      body: JSON.stringify({ account_id: accountId }),

    });

  }



  manualConnectEmail(emailAddress: string, displayName?: string, refreshToken?: string) {
    return this.request<{ status: string; account: EmailAccount }>("/email/manual-connect", {
      method: "POST",
      body: JSON.stringify({ email_address: emailAddress, display_name: displayName, refresh_token: refreshToken }),
    });
  }

  listEmailAccounts() {
    return this.request<EmailAccount[]>("/email/accounts");
  }

  microsoftAuthUrl(redirectUri?: string) {
    const q = redirectUri ? `?redirect_uri=${encodeURIComponent(redirectUri)}` : "";
    return this.request<{ auth_url: string; redirect_uri: string }>(`/email/oauth/microsoft/url${q}`);
  }

  connectMicrosoftMailbox(code: string, state?: string, redirectUri?: string) {
    return this.request<{ status: string; account: EmailAccount }>("/email/oauth/microsoft/callback", {
      method: "POST",
      body: JSON.stringify({ code, state, redirect_uri: redirectUri }),
    });
  }

  connectYahooMailbox(emailAddress: string, appPassword: string, displayName?: string) {
    return this.request<{ status: string; account: EmailAccount }>("/email/connect/yahoo", {
      method: "POST",
      body: JSON.stringify({ email_address: emailAddress, app_password: appPassword, display_name: displayName }),
    });
  }

  getEmailFolders(accountId?: string) {
    const q = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
    return this.request<EmailFolder[]>(`/email/folders${q}`);
  }

  getEmailMessages(params?: { folder_id?: string; account_id?: string; query?: string; limit?: number; cursor?: string }) {
    const searchParams = new URLSearchParams();
    if (params?.folder_id) searchParams.set("folder_id", params.folder_id);
    if (params?.account_id) searchParams.set("account_id", params.account_id);
    if (params?.query) searchParams.set("query", params.query);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.cursor) searchParams.set("cursor", params.cursor);
    const qs = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return this.request<{ messages: EmailMessageSummary[]; next_cursor?: string | null }>(`/email/messages${qs}`);
  }

  getEmailMessage(messageId: string, accountId?: string) {
    const q = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
    return this.request<EmailMessageDetail>(`/email/messages/${encodeURIComponent(messageId)}${q}`);
  }

  downloadEmailAttachment(messageId: string, attachmentId: string, accountId?: string) {
    const q = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
    return this.request<EmailAttachmentDownload>(
      `/email/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}${q}`
    );
  }

  sendEmail(req: {
    to: string[];
    subject: string;
    body_text: string;
    body_html?: string;
    cc?: string[];
    bcc?: string[];
    reply_to?: string[];
    account_id?: string;
    confirmed: boolean;
  }) {
    return this.request<{ status: string; message: EmailMessageSummary }>("/email/send", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  replyEmail(req: {
    message_id: string;
    body_text: string;
    body_html?: string;
    reply_all?: boolean;
    account_id?: string;
    confirmed: boolean;
  }) {
    return this.request<{ status: string; message: EmailMessageSummary }>("/email/reply", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }



  // Company folder settings

  async getCompanyFolder(): Promise<CompanyFolderResponse> {
    const localSt = getDesktopLocalStatus();
    if (localSt && localSt.connected_folders.length > 0) {
      return {
        path: localSt.connected_folders[0].folder_path,
        exists: true,
        folder_count: localSt.connected_folders.length,
        file_count: localSt.total_files,
      };
    }
    return this.request<CompanyFolderResponse>("/settings/company-folder", {}, true);
  }



  updateCompanyFolder(path: string) {

    return this.request<CompanyFolderUpdateResponse>(

      "/settings/company-folder",

      {

        method: "PUT",

        body: JSON.stringify({ path }),

      },

      true,

    );

  }



  browseDirectory(path: string) {

    return this.request<BrowseDirectoryResponse>(

      "/settings/company-folder/browse",

      {

        method: "POST",

        body: JSON.stringify({ path }),

      },

      true,

    );

  }



  // Local Agent Integration

  getLocalAgentToken() {

    return this.request<LocalAgentTokenResponse>("/local-agent/token", { method: "POST" }, true);

  }

  syncLocalFolderWithPairingToken(
    pairingToken: string,
    payload: {
      folder_id: string;
      folder_path: string;
      display_name: string;
      files: Array<{
        relative_path: string;
        filename: string;
        folder_name: string;
        file_type: string;
        size_bytes: number;
        chunk_count: number;
        modified_at?: string;
      }>;
      chunks: Array<{
        chunk_id: string;
        relative_path: string;
        filename: string;
        folder_name: string;
        chunk_index: number;
        text: string;
        char_count: number;
        modified_at?: string;
        metadata?: Record<string, unknown>;
      }>;
      replace_all: boolean;
    },
  ) {
    return this.request<{ status: string; folder_id: string; chunks_synced: number; files_synced: number }>(
      "/local-agent/sync",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${pairingToken}` },
        body: JSON.stringify(payload),
      },
      true,
    );
  }

  sendLocalAgentHeartbeatWithPairingToken(
    pairingToken: string,
    payload: {
      agent_version: string;
      folders: Array<{
        folder_id: string;
        folder_path: string;
        display_name: string;
        file_count: number;
        chunk_count: number;
        status: string;
      }>;
    },
  ) {
    return this.request<{ status?: string; commands?: any[]; requested_folders?: string[] }>(
      "/local-agent/heartbeat",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${pairingToken}` },
        body: JSON.stringify(payload),
      },
      true,
    );
  }

  extractLocalDocumentText(filename: string, contentBase64: string) {
    return this.request<{ filename: string; text: string }>(
      "/local-agent/extract-text",
      {
        method: "POST",
        body: JSON.stringify({ filename, content_base64: contentBase64 }),
      },
      true,
    );
  }



  async downloadLocalAgentPackage(_token?: string): Promise<void> {

    const url = `${this.activeBase()}/local-agent/download?format=exe`;

    const a = document.createElement("a");

    a.href = url;

    a.download = "Nanvi AI Assistant-Setup-0.1.2.exe";

    document.body.appendChild(a);

    a.click();

    a.remove();

  }



  async getLocalAgentStatus(): Promise<LocalAgentStatusResponse> {
    const localSt = getDesktopLocalStatus();
    if (localSt && localSt.connected_folders.length > 0) {
      return localSt as LocalAgentStatusResponse;
    }
    const isDesktopOrigin =
      typeof window !== "undefined" &&
      (Boolean((window as any).electronAPI?.isDesktop) || window.location.protocol === "file:");
    if (isDesktopOrigin && (window as any).electronAPI?.connectFolderFast) {
      return {
        is_online: true,
        last_heartbeat: new Date().toISOString(),
        agent_version: "desktop-local-only",
        connected_folders: [],
        total_files: 0,
        total_chunks: 0,
      };
    }
    return this.request<LocalAgentStatusResponse>("/local-agent/status", {}, true);
  }



  addLocalFolder(folderPath: string) {

    return this.request<{ status: string; message: string }>("/local-agent/folders", {

      method: "POST",

      body: JSON.stringify({ folder_path: folderPath }),

    });

  }



  browseLocalFolder() {

    return this.request<{ status: string; message: string; folder_path?: string }>("/local-agent/browse-folder", {

      method: "POST",

    });

  }



  async removeLocalFolder(folderId: string) {
    const hadLocalDesktop = Boolean(getDesktopLocalStatus());
    if (hadLocalDesktop || (typeof window !== "undefined" && (window as any).electronAPI?.isDesktop)) {
      await clearDesktopLocalFolder();
    }
    try {
      return await this.request<{ status: string; message: string }>(
        `/local-agent/folders?folder_path=${encodeURIComponent(folderId)}`,
        { method: "DELETE" },
      );
    } catch (err) {
      if (hadLocalDesktop) {
        return { status: "ok", message: `Folder '${folderId}' disconnected cleanly.` };
      }
      throw err;
    }
  }



  testSearchLocalAgent(query: string) {

    return this.request<{ query: string; total_hits: number; chunks: any[] }>("/local-agent/search", {

      method: "POST",

      body: JSON.stringify({ query }),

    });

  }



  listProviders() {

    return this.request<{ providers: ProviderPublic[] }>("/connections/providers");

  }



  listConnectionCategories() {

    return this.request<string[]>("/connections/categories");

  }



  listConnections(params?: { provider?: string; scope?: string; status?: string; q?: string }) {

    const qp = new URLSearchParams();

    if (params?.provider) qp.set("provider", params.provider);

    if (params?.scope) qp.set("scope", params.scope);

    if (params?.status) qp.set("status", params.status);

    if (params?.q) qp.set("q", params.q);

    const qs = qp.toString();

    return this.request<ConnectionListResponse>(`/connections${qs ? `?${qs}` : ""}`);

  }



  getConnection(id: string) {

    return this.request<ConnectionPublic>(`/connections/${encodeURIComponent(id)}`);

  }



  createConnection(req: CreateConnectionRequest) {

    return this.request<ConnectionPublic>("/connections", {

      method: "POST",

      body: JSON.stringify(req),

    });

  }



  validateConnection(req: ValidateConnectionRequest) {

    return this.request<TestConnectionResponse>("/connections/validate", {

      method: "POST",

      body: JSON.stringify(req),

    });

  }



  testConnection(id: string) {

    return this.request<TestConnectionResponse>(`/connections/${encodeURIComponent(id)}/test`, {

      method: "POST",

    });

  }



  updateConnection(id: string, req: UpdateConnectionRequest) {

    return this.request<ConnectionPublic>(`/connections/${encodeURIComponent(id)}`, {

      method: "PATCH",

      body: JSON.stringify(req),

    });

  }



  deleteConnection(id: string) {

    return this.request<void>(`/connections/${encodeURIComponent(id)}`, {

      method: "DELETE",

    });

  }



  getOAuthAuthorizeUrl(provider: string, scopeLevel = "user", redirectAfter?: string) {

    const qp = new URLSearchParams({ scope_level: scopeLevel });

    if (redirectAfter) qp.set("redirect_after", redirectAfter);

    return this.request<{ authorization_url: string }>(`/connections/oauth/${encodeURIComponent(provider)}/authorize?${qp.toString()}`);

  }



  getConnectionServices(id: string) {

    return this.request<ServiceState[] | { services: ServiceState[] }>(`/connections/${encodeURIComponent(id)}/services`);

  }



  updateConnectionService(

    id: string,

    serviceId: string,

    req: { enabled?: boolean; permissions?: string[]; sync_frequency?: string }

  ) {

    return this.request<ConnectionPublic | { status: string; service: ServiceState }>(

      `/connections/${encodeURIComponent(id)}/services/${encodeURIComponent(serviceId)}`,

      {

        method: "PATCH",

        body: JSON.stringify(req),

      }

    );

  }



  updateConnectionSyncConfig(

    id: string,

    req: { auto_sync?: boolean; frequency?: string }

  ) {

    return this.request<{ status: string; sync_config: SyncConfig }>(

      `/connections/${encodeURIComponent(id)}/sync-config`,

      {

        method: "PATCH",

        body: JSON.stringify(req),

      }

    );

  }



  syncConnection(id: string) {

    return this.request<{ status: string; synced_at: string; items_checked: number }>(

      `/connections/${encodeURIComponent(id)}/sync`,

      {

        method: "POST",

      }

    );

  }



  revokeConnection(id: string) {

    return this.request<{ status: string; revoked_at: string; provider_revoked: boolean; message: string }>(

      `/connections/${encodeURIComponent(id)}/revoke`,

      {

        method: "POST",

      }

    );

  }



  listConnectionAudit(id: string) {

    return this.request<ConnectionAuditEvent[]>(`/connections/${encodeURIComponent(id)}/audit`);

  }



  listConnectionAuditEvents() {

    return this.request<any[]>("/connections/audit/events");

  }



  // --- Admin Console & Website Management ---

  adminOverview() {

    return this.request<AdminOverview>("/admin/overview");

  }



  adminListAccounts() {

    return this.request<LocalAccount[]>("/admin/accounts");

  }



  adminCreateAccount(account: LocalAccountCreate) {

    return this.request<LocalAccount>("/admin/accounts", {

      method: "POST",

      body: JSON.stringify(account),

    });

  }



  adminUpdateAccount(id: string, data: Partial<LocalAccount>) {

    return this.request<LocalAccount>(`/admin/accounts/${encodeURIComponent(id)}`, {

      method: "PATCH",

      body: JSON.stringify(data),

    });

  }



  adminResetPassword(id: string, newPassword: string) {

    return this.request<LocalAccount>(`/admin/accounts/${encodeURIComponent(id)}/reset-password`, {

      method: "POST",

      body: JSON.stringify({ new_password: newPassword }),

    });

  }



  adminDeleteAccount(id: string) {

    return this.request<void>(`/admin/accounts/${encodeURIComponent(id)}`, {

      method: "DELETE",

    });

  }



  adminListTickets(statusFilter?: string) {

    const q = statusFilter && statusFilter !== "all" ? `?status=${encodeURIComponent(statusFilter)}` : "";

    return this.request<SupportTicket[]>(`/admin/tickets${q}`);

  }



  adminUpdateTicket(id: string, data: { status: string; admin_notes?: string }) {

    return this.request<SupportTicket>(`/admin/tickets/${encodeURIComponent(id)}`, {

      method: "PATCH",

      body: JSON.stringify(data),

    });

  }



  adminDeleteTicket(id: string) {

    return this.request<void>(`/admin/tickets/${encodeURIComponent(id)}`, {

      method: "DELETE",

    });

  }



  adminGetDatabaseConfig() {

    return this.request<DatabaseConfig>("/admin/database/config");

  }



  adminTestDatabase(data?: { database_url?: string; supabase_database_url?: string }) {

    return this.request<{ success: boolean; message: string; latency_ms: number; server_version?: string }>(

      "/admin/database/test",

      {

        method: "POST",

        body: JSON.stringify(data || {}),

      }

    );

  }



  adminUpdateDatabaseConfig(data: Partial<DatabaseConfig> & { pool_min_size?: number; pool_max_size?: number }) {

    return this.request<{ success: boolean; message: string; updated_keys: string[] }>(

      "/admin/database/config",

      {

        method: "PUT",

        body: JSON.stringify(data),

      }

    );

  }



  // --- Company Details & AI Memory Management ---

  adminGetCompanyMemory() {

    return this.request<CompanyMemory>("/admin/company-details");

  }



  adminSaveCompanyMemory(data: { company_name: string; details: string; tagline?: string }) {

    return this.request<CompanyMemory>("/admin/company-details", {

      method: "POST",

      body: JSON.stringify(data),

    });

  }



  async adminUploadCompanyPdf(file: File, append = false) {

    return new Promise<{ success: boolean; message: string; memory: CompanyMemory }>((resolve, reject) => {

      const reader = new FileReader();

      reader.onload = async () => {

        try {

          const res = await this.adminUploadCompanyPdfBase64({

            filename: file.name,

            content_base64: reader.result as string,

            append,

          });

          resolve(res);

        } catch (err) {

          reject(err);

        }

      };

      reader.onerror = () => reject(new Error("Failed to read file"));

      reader.readAsDataURL(file);

    });

  }



  async adminUploadCompanyPdfBase64(data: { filename: string; content_base64: string; append?: boolean }) {

    return this.request<{ success: boolean; message: string; memory: CompanyMemory }>(

      "/admin/company-details/upload-pdf",

      {

        method: "POST",

        body: JSON.stringify(data),

      }

    );

  }



  adminClearCompanyMemory() {

    return this.request<CompanyMemory>("/admin/company-details", {

      method: "DELETE",

    });

  }



  // --- User Trouble & Issue Reporting ---

  submitSupportTicket(ticket: {

    category: string;

    severity?: string;

    subject: string;

    description: string;

    diagnostic_info?: Record<string, any>;

  }) {

    return this.request<SupportTicket>("/support/tickets", {

      method: "POST",

      body: JSON.stringify(ticket),

    });

  }



  getMySupportTickets() {

    return this.request<SupportTicket[]>("/support/my-tickets");

  }



  // --- User Query & System Answer Logs (Superior & Admin only) ---

  getUserLogDates() {

    return this.request<UserLogDatesResponse>("/logs/dates");

  }



  getUserLogs(params?: {

    date?: string;

    search?: string;

    user_id?: string;

    limit?: number;

    offset?: number;

  }) {

    const q = new URLSearchParams();

    if (params?.date) q.set("date", params.date);

    if (params?.search) q.set("search", params.search);

    if (params?.user_id) q.set("user_id", params.user_id);

    if (params?.limit) q.set("limit", String(params.limit));

    if (params?.offset) q.set("offset", String(params.offset));

    const qs = q.toString();

    return this.request<UserLogsResponse>(qs ? `/logs?${qs}` : "/logs");

  }

}



export const api = new NanviApiClient();





export type EmailAccount = {

  id: string;

  email_address: string;

  display_name: string;

  provider: string;

  avatar_url?: string | null;

  connected_at: string;

  last_synced_at?: string | null;

  is_active?: boolean;

};



export type EmailStatusResponse = {
  connected: boolean;
  account: EmailAccount | null;
  accounts?: EmailAccount[];
  has_enterprise_fallback?: boolean;
  has_microsoft_fallback?: boolean;
  has_yahoo_fallback?: boolean;
  is_microsoft_oauth_configured?: boolean;
};

export type EmailFolder = {
  id: string;
  name: string;
  total_count: number;
  unread_count: number;
};

export type EmailAddressInfo = {
  address: string;
  name?: string | null;
};

export type EmailAttachmentMeta = {
  id: string;
  name: string;
  content_type?: string | null;
  size_bytes?: number | null;
};

export type EmailMessageSummary = {
  id: string;
  conversation_id?: string | null;
  subject: string;
  sender?: EmailAddressInfo | null;
  to_recipients: EmailAddressInfo[];
  received_at?: string | null;
  sent_at?: string | null;
  body_preview?: string | null;
  has_attachments: boolean;
  attachments: EmailAttachmentMeta[];
  web_link?: string | null;
  source: string;
  folder?: string;
  account_id?: string | null;
  account_email?: string | null;
  provider?: string | null;
};

export type EmailMessageDetail = EmailMessageSummary & {
  body_text?: string | null;
  body_html_sanitized?: string | null;
  cc_recipients: EmailAddressInfo[];
  reply_to: EmailAddressInfo[];
  message_id_header?: string | null;
};

export type EmailAttachmentDownload = {
  id: string;
  name: string;
  content_type?: string | null;
  size_bytes?: number | null;
  data_base64: string;
};



export type CompanyFolderResponse = {

  path: string;

  exists: boolean;

  folder_count: number;

  file_count: number;

};



export type CompanyFolderUpdateResponse = {

  status: string;

  path: string;

  exists: boolean;

  folder_count: number;

  file_count: number;

  indexed_files: number;

  message: string;

};



export type BrowseDirectoryEntry = {

  name: string;

  path: string;

  is_dir: boolean;

};



export type BrowseDirectoryResponse = {

  path: string;

  parent?: string | null;

  entries: BrowseDirectoryEntry[];

  error?: string;

};



export type LocalFolderInfo = {

  folder_id: string;

  folder_path: string;

  display_name: string;

  file_count: number;

  chunk_count: number;

  status: string;

  last_synced_at?: string | null;

};



export type LocalAgentStatusResponse = {

  is_online: boolean;

  last_heartbeat?: string | null;

  agent_version?: string | null;

  connected_folders: LocalFolderInfo[];

  total_files: number;

  total_chunks: number;

  pairing_command?: string;

};



export type LocalAgentTokenResponse = {

  token: string;

  expires_in_days: number;

  server_url: string;

  tenant_id: string;

  user_id: string;

  display_name: string;

};



export type ServicePermission = {

  id: string;

  name?: string;

  label?: string;

  description: string;

  enabled?: boolean;

  granted?: boolean;

  required_scopes?: string[];

};



export type ServiceState = {

  id: string;

  name: string;

  description: string;

  icon?: string | null;

  enabled: boolean;

  status: "AUTHORIZED" | "UNAUTHORIZED" | "CONFIG_REQUIRED" | "ENABLED" | "DISABLED" | string;

  status_reason?: string | null;

  required_scopes?: string[];

  requires_scopes?: string[];

  granted_scopes?: string[];

  permissions: ServicePermission[];

  last_synced_at?: string | null;

  sync_frequency?: string | null;

  sync_status?: string | null;

  item_count?: number | null;

};



export type ProviderServiceDef = {

  id: string;

  name: string;

  description: string;

  icon?: string | null;

  default_enabled: boolean;

  requires_scopes: string[];

};



export type SyncConfig = {

  auto_sync: boolean;

  frequency: string;

  last_synced_at?: string | null;

  last_status?: string | null;

  last_error?: string | null;

};



export type ConnectionAuditEvent = {

  id: string;

  connection_id: string;

  event_type: string;

  actor_user_id?: string | null;

  details: Record<string, any>;

  ip_address?: string | null;

  created_at: string;

};



export type ProviderPublic = {

  id: string;

  name: string;

  categories: string[];

  icon: string;

  description: string;

  auth_type: string;

  capabilities: string[];

  available: boolean;

  available_reason: string;

  configuration_schema: Record<string, any>;

  supported_services?: ProviderServiceDef[];

};



export type ConnectionPublic = {

  id: string;

  provider: string;

  display_name: string;

  account_identifier?: string | null;

  scope_level: "user" | "organization";

  account_type?: "Personal" | "Organization";

  status: "CONNECTED" | "DISCONNECTED" | "ERROR" | "EXPIRED" | "REAUTH_REQUIRED" | "TESTING";

  status_reason?: string | null;

  granted_scopes: string[];

  metadata_safe: Record<string, any>;

  credential_type?: string | null;

  services?: ServiceState[];

  enabled_services_count?: number;

  total_services_count?: number;

  sync_config?: SyncConfig;

  auto_sync?: boolean;

  sync_frequency?: string;

  last_tested_at?: string | null;

  last_used_at?: string | null;

  last_synced_at?: string | null;

  created_at?: string | null;

  updated_at?: string | null;

  created_by?: string | null;

  owner_user_id?: string | null;

};



export type ConnectionListResponse = {

  connections: ConnectionPublic[];

  total: number;

};



export type CreateConnectionRequest = {

  provider: string;

  display_name: string;

  scope_level?: "user" | "organization";

  config: Record<string, any>;

};



export type ValidateConnectionRequest = {

  provider: string;

  config: Record<string, any>;

};



export type UpdateConnectionRequest = {

  display_name?: string | null;

  config?: Record<string, any> | null;

};



export type TestConnectionResponse = {

  ok: boolean;

  message: string;

  details?: Record<string, any>;

};



export type AdminOverview = {

  total_users: number;

  active_users: number;

  total_tickets: number;

  open_tickets: number;

  db_type: string;

  db_connected: boolean;

  db_latency_ms: number;

  multi_tenant_status: string;

  uecp_status: string;

  app_env: string;

  current_admin: {

    name: string;

    email?: string;

    roles: string[];

  };

};



export type SupportTicket = {

  id: string;

  reporter_id: string;

  reporter_name: string;

  reporter_email: string;

  reporter_role: string;

  category: string;

  severity: string;

  subject: string;

  description: string;

  status: string;

  admin_notes?: string | null;

  diagnostic_info?: Record<string, any> | null;

  created_at: string;

  updated_at: string;

};



export type DatabaseConfig = {

  database_type: string;

  database_url_masked: string;

  supabase_database_url_masked: string;

  supabase_url: string;

  supabase_key_masked: string;

  host: string;

  port: number | string;

  database_name: string;

  username: string;

  pool_min_size: number;

  pool_max_size: number;

  is_connected: boolean;

  latency_ms: number;

  server_version?: string;

  table_stats: Record<string, number>;

  multi_tenant_partitioning: {

    status: string;

    description: string;

  };

};



export type CompanyMemory = {

  company_name: string;

  tagline?: string;

  details: string;

  source_type: "pasted" | "pdf_upload" | "combined" | "default";

  source_filename?: string | null;

  updated_at: string;

  updated_by: string;

  character_count: number;

  word_count: number;

  is_configured: boolean;

};






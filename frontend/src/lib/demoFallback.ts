import { DEMO_MODE, IS_PRODUCTION } from "./config";
import { isEmailQuery } from "./isEmailQuery";
import type {
  ChatResponse,
  VoiceResponse,
  ProviderPublic,
  ConnectionPublic,
  CompanyFolderResponse,
  CompanyFolderUpdateResponse,
  BrowseDirectoryResponse,
  EmailStatusResponse,
} from "../api";

export function getDemoFallbackResponse<T>(path: string, init?: RequestInit): T | undefined {
  if (import.meta.env.VITE_DEMO_MODE !== "true" || IS_PRODUCTION || !DEMO_MODE) return undefined;

  const cleanPath = path.split("?")[0].replace(/\/$/, "");
  const method = (init?.method || "GET").toUpperCase();

  if (cleanPath === "/auth/me") {
    return {
      sub: "demo-user-1",
      email: "demo.executive@nanvi.enterprise",
      name: "Demo Executive",
      roles: ["CEO", "Manager", "IT Admin"],
      department: "Leadership",
    } as unknown as T;
  }

  if (cleanPath === "/chat/history") {
    return { conversations: [] } as unknown as T;
  }

  if (cleanPath.startsWith("/chat/conversations/")) {
    const id = cleanPath.split("/").pop() || "demo-conv";
    return {
      conversation_id: id,
      messages: [],
    } as unknown as T;
  }

  if (cleanPath === "/email/status") {
    const status: EmailStatusResponse = {
      connected: false,
      account: null,
      has_enterprise_fallback: true,
    };
    return status as unknown as T;
  }

  if (cleanPath === "/email/oauth/google/url") {
    const redirectParam = typeof window !== "undefined" ? window.location.origin : "";
    return {
      auth_url: `${redirectParam}?connected=google&status=success`,
    } as unknown as T;
  }

  if (cleanPath === "/email/disconnect") {
    return { status: "disconnected" } as unknown as T;
  }

  if (cleanPath === "/email/folders") {
    return [
      { id: "inbox", name: "Inbox", total_count: 5, unread_count: 2 },
      { id: "sent", name: "Sent", total_count: 12, unread_count: 0 },
      { id: "drafts", name: "Drafts", total_count: 1, unread_count: 0 },
    ] as unknown as T;
  }

  if (cleanPath === "/email/messages") {
    return {
      messages: [
        {
          id: "demo-msg-1",
          conversation_id: "thread-1",
          subject: "Q1 2026 Financial Results — EBITDA Exceeded Target by 27%",
          sender: { address: "priya.sharma@nanvi.local", name: "Priya Sharma (CFO)" },
          to_recipients: [{ address: "ceo@nanvi.local", name: "Arjun Mehta (CEO)" }],
          received_at: new Date(Date.now() - 3600000 * 2).toISOString(),
          sent_at: new Date(Date.now() - 3600000 * 2).toISOString(),
          body_preview: "Hi Arjun, Q1 revenue closed at $4.45M vs budget of $4.20M (105.9%). EBITDA was $1.59M vs $1.25M planned.",
          has_attachments: true,
          attachments: [{ id: "att-1", name: "q1_summary_exec.pdf", content_type: "application/pdf", size_bytes: 245000 }],
          web_link: "https://mail.google.com",
          source: "google_gmail",
          folder: "inbox",
          provider: "google",
        },
        {
          id: "demo-msg-2",
          conversation_id: "thread-2",
          subject: "Acme Corp: 3-Year Renewal Agreement Confirmed ($450,000 ARR)",
          sender: { address: "david.miller@nanvi.local", name: "David Miller" },
          to_recipients: [{ address: "ceo@nanvi.local", name: "Arjun Mehta" }],
          received_at: new Date(Date.now() - 86400000).toISOString(),
          sent_at: new Date(Date.now() - 86400000).toISOString(),
          body_preview: "Sarah Jenkins at Acme Corp just countersigned the 3-year extension at $450k ARR.",
          has_attachments: true,
          attachments: [{ id: "att-2", name: "acme_renewal_signed.pdf", content_type: "application/pdf", size_bytes: 512000 }],
          web_link: "https://mail.google.com",
          source: "google_gmail",
          folder: "inbox",
          provider: "google",
        },
      ],
      next_cursor: null,
    } as unknown as T;
  }

  if (cleanPath.startsWith("/email/messages/")) {
    const id = cleanPath.split("/").pop() || "demo-msg-1";
    return {
      id,
      conversation_id: "thread-1",
      subject: "Q1 2026 Financial Results — EBITDA Exceeded Target by 27%",
      sender: { address: "priya.sharma@nanvi.local", name: "Priya Sharma (CFO)" },
      to_recipients: [{ address: "ceo@nanvi.local", name: "Arjun Mehta (CEO)" }],
      cc_recipients: [{ address: "finance@nanvi.local", name: "Finance Team" }],
      reply_to: [{ address: "priya.sharma@nanvi.local", name: "Priya Sharma (CFO)" }],
      received_at: new Date(Date.now() - 3600000 * 2).toISOString(),
      sent_at: new Date(Date.now() - 3600000 * 2).toISOString(),
      body_preview: "Hi Arjun, Q1 revenue closed at $4.45M vs budget of $4.20M (105.9%). EBITDA was $1.59M vs $1.25M planned.",
      body_text: "Hi Arjun,\n\nQ1 revenue closed at $4.45M vs budget of $4.20M (105.9%). EBITDA was $1.59M vs $1.25M planned. Financial report is saved in C:\\CompanyData\\Finance\\q1_2026_financial_summary.xlsx.\n\nBest,\nPriya",
      has_attachments: true,
      attachments: [{ id: "att-1", name: "q1_summary_exec.pdf", content_type: "application/pdf", size_bytes: 245000 }],
      web_link: "https://mail.google.com",
      source: "google_gmail",
      folder: "inbox",
      provider: "google",
    } as unknown as T;
  }

  if (cleanPath === "/email/oauth/microsoft/url") {
    const redirectParam = typeof window !== "undefined" ? window.location.origin : "";
    return {
      auth_url: `${redirectParam}?connected=microsoft&status=success`,
      redirect_uri: redirectParam,
      state: "ms_demo_state",
    } as unknown as T;
  }

  if (cleanPath === "/email/connect/yahoo") {
    return {
      status: "connected",
      account: {
        id: "email-yahoo-demo",
        email_address: "user@yahoo.com",
        display_name: "Yahoo Mail (user@yahoo.com)",
        provider: "yahoo",
        connected_at: new Date().toISOString(),
        is_active: true,
      },
    } as unknown as T;
  }

  if (cleanPath === "/email/send" || cleanPath === "/email/reply") {
    return {
      status: "sent",
      message: {
        id: "sent-demo-msg",
        conversation_id: "thread-demo",
        subject: "Message Sent",
        to_recipients: [],
        has_attachments: false,
        attachments: [],
        source: "demo",
      },
    } as unknown as T;
  }

  if (cleanPath === "/logs/dates") {
    return {
      dates: ["02-11-2026", "01-11-2026", "31-10-2026"],
      today: "02-11-2026",
    } as unknown as T;
  }

  if (cleanPath === "/logs") {
    return {
      logs: [
        {
          id: "log-demo-1",
          user_id: "priya.sharma",
          user_name: "Priya Sharma",
          user_role: "Supervisor",
          tenant_id: "enterprise-tenant",
          query: "What is the status of the Q3 CloudNova contract renewal?",
          answer: "The CloudNova contract renewal schedule for Q3 2026 is active. The standard 24-month term renewal is scheduled with annual license value of $180,000.",
          capability: "knowledge",
          model: "llama-3.3-70b-versatile",
          created_at: new Date().toISOString(),
          log_date: "02-11-2026",
        },
        {
          id: "log-demo-2",
          user_id: "rahul.verma",
          user_name: "Rahul Verma",
          user_role: "Project Engineer",
          tenant_id: "enterprise-tenant",
          query: "Give me the deployment steps for the container orchestration cluster",
          answer: "Deployment follows standard GitOps pipeline on AWS ECS with zero-downtime rolling updates enabled.",
          capability: "knowledge",
          model: "llama-3.3-70b-versatile",
          created_at: new Date(Date.now() - 3600000).toISOString(),
          log_date: "02-11-2026",
        },
      ],
      total: 2,
      date: "02-11-2026",
    } as unknown as T;
  }

  if (cleanPath === "/email/manual-connect") {
    let email = "demo@nanvi.enterprise";
    let name = "Demo Email";
    try {
      if (init?.body) {
        const body = JSON.parse(init.body as string);
        if (body.email_address) email = body.email_address;
        if (body.display_name) name = body.display_name;
      }
    } catch {}
    return {
      status: "connected",
      account: {
        id: "email-demo-1",
        email_address: email,
        display_name: name,
        provider: "google",
        connected_at: new Date().toISOString(),
        is_active: true,
      },
    } as unknown as T;
  }

  if (cleanPath === "/settings/company-folder") {
    if (method === "PUT") {
      let reqPath = "";
      try {
        if (init?.body) {
          const body = JSON.parse(init.body as string);
          if (body.path) reqPath = body.path;
        }
      } catch {}
      try {
        if (reqPath && typeof window !== "undefined") {
          window.localStorage.setItem("nanvi_demo_folder_path", reqPath);
        }
      } catch {}
      const res: CompanyFolderUpdateResponse = {
        status: "ok",
        path: reqPath,
        exists: Boolean(reqPath),
        folder_count: reqPath ? 5 : 0,
        file_count: reqPath ? 24 : 0,
        indexed_files: reqPath ? 24 : 0,
        message: "Company data directory updated and indexed successfully.",
      };
      return res as unknown as T;
    }

    let savedPath = "";
    try {
      if (typeof window !== "undefined") {
        savedPath = window.localStorage.getItem("nanvi_demo_folder_path") || "";
      }
    } catch {}

    const folderRes: CompanyFolderResponse = {
      path: savedPath,
      exists: Boolean(savedPath),
      folder_count: savedPath ? 5 : 0,
      file_count: savedPath ? 24 : 0,
    };
    return folderRes as unknown as T;
  }

  if (cleanPath === "/settings/company-folder/browse") {
    let reqPath = "C:\\CompanyData";
    try {
      if (init?.body) {
        const body = JSON.parse(init.body as string);
        if (body.path) reqPath = body.path;
      }
    } catch {}
    const browseRes: BrowseDirectoryResponse = {
      path: reqPath,
      parent: "C:\\",
      entries: [
        { name: "Contracts", path: `${reqPath}\\Contracts`, is_dir: true },
        { name: "Customers", path: `${reqPath}\\Customers`, is_dir: true },
        { name: "Finance", path: `${reqPath}\\Finance`, is_dir: true },
        { name: "HR", path: `${reqPath}\\HR`, is_dir: true },
        { name: "Operations", path: `${reqPath}\\Operations`, is_dir: true },
        { name: "Projects", path: `${reqPath}\\Projects`, is_dir: true },
      ],
    };
    return browseRes as unknown as T;
  }

  if (cleanPath === "/connections/categories") {
    return [
      "Communication",
      "Storage / Documents",
      "SQL Databases",
      "Developer Tools",
      "Cloud",
      "Vector / Search",
      "AI / LLM",
      "BI / Analytics",
      "Monitoring",
      "Identity",
    ] as unknown as T;
  }

  if (cleanPath === "/connections/providers") {
    const providersList: ProviderPublic[] = [
      {
        id: "google",
        name: "Google Workspace & Gmail",
        categories: ["Communication", "Identity"],
        icon: "google",
        description: "Connect enterprise Gmail mailboxes, Google Drive folders, and Google Workspace SSO.",
        auth_type: "oauth2",
        capabilities: ["read_email", "send_email", "search_drive"],
        available: true,
        available_reason: "ready",
        configuration_schema: {},
      },
      {
        id: "postgres",
        name: "PostgreSQL Database",
        categories: ["SQL Databases"],
        icon: "postgresql",
        description: "Connect enterprise relational PostgreSQL database with ACID transaction safety and SQL analytics.",
        auth_type: "db_password",
        capabilities: ["query", "schema", "table_read"],
        available: true,
        available_reason: "ready",
        configuration_schema: {
          properties: {
            host: { type: "string", title: "Host Server" },
            port: { type: "number", title: "Port", default: 5432 },
            database: { type: "string", title: "Database Name" },
            username: { type: "string", title: "Database User" },
            password: { type: "string", title: "Password", format: "password" },
          },
          required: ["host", "database", "username", "password"],
        },
      },
      {
        id: "github",
        name: "GitHub Repositories",
        categories: ["Developer Tools"],
        icon: "github",
        description: "Search enterprise repositories, analyze pull requests, and track code changes.",
        auth_type: "api_key",
        capabilities: ["read_repo", "code_search", "pull_requests"],
        available: true,
        available_reason: "ready",
        configuration_schema: {
          properties: {
            token: { type: "string", title: "Personal Access Token", format: "password" },
            organization: { type: "string", title: "GitHub Org / Owner" },
          },
          required: ["token"],
        },
      },
      {
        id: "supabase",
        name: "Supabase Cloud",
        categories: ["SQL Databases", "Cloud"],
        icon: "supabase",
        description: "Cloud PostgreSQL and pgvector database for real-time document search and vector indexing.",
        auth_type: "api_key",
        capabilities: ["vector_search", "sql_query"],
        available: true,
        available_reason: "ready",
        configuration_schema: {
          properties: {
            project_url: { type: "string", title: "Project URL" },
            api_key: { type: "string", title: "Service Role / API Key", format: "password" },
          },
          required: ["project_url", "api_key"],
        },
      },
      {
        id: "slack",
        name: "Slack Workspace",
        categories: ["Communication"],
        icon: "slack",
        description: "Index corporate communication channels, executive announcements, and project threads.",
        auth_type: "oauth2",
        capabilities: ["read_channels", "post_alerts"],
        available: true,
        available_reason: "ready",
        configuration_schema: {},
      },
      {
        id: "s3",
        name: "Amazon S3",
        categories: ["Storage / Documents", "Cloud"],
        icon: "aws",
        description: "Ingest PDFs, financial reports, and archives directly from AWS S3 buckets.",
        auth_type: "api_key",
        capabilities: ["read_objects", "bucket_sync"],
        available: true,
        available_reason: "ready",
        configuration_schema: {
          properties: {
            bucket: { type: "string", title: "Bucket Name" },
            region: { type: "string", title: "AWS Region", default: "us-east-1" },
            access_key_id: { type: "string", title: "Access Key ID" },
            secret_access_key: { type: "string", title: "Secret Access Key", format: "password" },
          },
          required: ["bucket", "access_key_id", "secret_access_key"],
        },
      },
      {
        id: "pinecone",
        name: "Pinecone Vector DB",
        categories: ["Vector / Search"],
        icon: "pinecone",
        description: "Serverless vector index for lightning-fast semantic retrieval and RAG indexing.",
        auth_type: "api_key",
        capabilities: ["vector_search", "upsert"],
        available: true,
        available_reason: "ready",
        configuration_schema: {
          properties: {
            api_key: { type: "string", title: "Pinecone API Key", format: "password" },
            index_name: { type: "string", title: "Index Name" },
            environment: { type: "string", title: "Environment Host" },
          },
          required: ["api_key", "index_name"],
        },
      },
      {
        id: "openai",
        name: "OpenAI Platform",
        categories: ["AI / LLM"],
        icon: "openai",
        description: "Connect enterprise OpenAI organization for GPT-4o, reasoning models, and embeddings.",
        auth_type: "api_key",
        capabilities: ["chat_completion", "text_embeddings"],
        available: true,
        available_reason: "ready",
        configuration_schema: {
          properties: {
            api_key: { type: "string", title: "API Key", format: "password" },
          },
          required: ["api_key"],
        },
      },
      {
        id: "microsoft365",
        name: "Microsoft 365 & Outlook",
        categories: ["Communication", "Identity"],
        icon: "microsoft365",
        description: "Integrate Outlook mailboxes, calendar events, and Office 365 documents.",
        auth_type: "oauth2",
        capabilities: ["read_mail", "read_calendar"],
        available: true,
        available_reason: "ready",
        configuration_schema: {},
      },
      {
        id: "jira",
        name: "Atlassian Jira",
        categories: ["Developer Tools"],
        icon: "jira",
        description: "Query enterprise project sprints, backlog tickets, and operational incidents.",
        auth_type: "oauth2",
        capabilities: ["read_issues", "search_projects"],
        available: true,
        available_reason: "ready",
        configuration_schema: {},
      },
    ];
    return { providers: providersList } as unknown as T;
  }

  if (cleanPath === "/connections/audit/events") {
    return [
      {
        id: "evt-1",
        event: "CONNECTION_CREATED",
        provider: "google",
        actor_user_id: "demo.executive",
        actor_username: "demo.executive",
        actor_name: "Demo Executive",
        actor_role: "Superior",
        raw_actor_id: "demo.executive@nanvi.enterprise",
        safe_metadata: { provider: "google", scope_level: "organization" },
        created_at: new Date(Date.now() - 86400000 * 2).toISOString(),
      },
      {
        id: "evt-2",
        event: "CONNECTION_TESTED",
        provider: "postgres",
        actor_user_id: "it.admin",
        actor_username: "it.admin",
        actor_name: "IT Administrator",
        actor_role: "Admin",
        raw_actor_id: "it.admin@nanvi.enterprise",
        safe_metadata: { status: "success", latency_ms: 18 },
        created_at: new Date(Date.now() - 3600000 * 5).toISOString(),
      },
      {
        id: "evt-3",
        event: "CONNECTION_OAUTH_CONNECTED",
        provider: "slack",
        actor_user_id: "demo.executive",
        actor_username: "demo.executive",
        actor_name: "Demo Executive",
        actor_role: "Superior",
        raw_actor_id: "demo.executive@nanvi.enterprise",
        safe_metadata: { workspace: "Nanvi HQ" },
        created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
      },
    ] as unknown as T;
  }

  if (cleanPath.startsWith("/connections/oauth/") && cleanPath.endsWith("/authorize")) {
    const redirectParam = typeof window !== "undefined" ? window.location.origin : "";
    return {
      authorization_url: `${redirectParam}?connected=provider&status=success`,
    } as unknown as T;
  }

  if (cleanPath === "/connections/validate" || cleanPath.endsWith("/test")) {
    return {
      ok: true,
      message: "Connection verified successfully. Service responded in 24ms.",
    } as unknown as T;
  }

  if (cleanPath === "/connections") {
    if (method === "POST") {
      let bodyObj: any = {};
      try {
        if (init?.body) bodyObj = JSON.parse(init.body as string);
      } catch {}
      const newConn: ConnectionPublic = {
        id: `conn-demo-${Date.now()}`,
        provider: bodyObj.provider || "custom",
        display_name: bodyObj.display_name || "Custom Integration",
        account_identifier: bodyObj.account_identifier || "active-instance",
        scope_level: bodyObj.scope_level || "organization",
        status: "CONNECTED",
        status_reason: null,
        granted_scopes: ["read", "query"],
        metadata_safe: bodyObj.config || {},
        credential_type: "api_key",
        last_tested_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by: "Demo User",
        owner_user_id: "demo-user-1",
      };
      return newConn as unknown as T;
    }

    const connectionsList: ConnectionPublic[] = [
      {
        id: "conn-demo-google",
        provider: "google",
        display_name: "Google Workspace & Gmail",
        account_identifier: "executive@nanvi.enterprise",
        scope_level: "organization",
        status: "CONNECTED",
        status_reason: null,
        granted_scopes: ["email.readonly", "drive.readonly"],
        metadata_safe: { domain: "nanvi.enterprise", mode: "demo" },
        credential_type: "oauth2",
        last_tested_at: new Date(Date.now() - 3600000).toISOString(),
        last_used_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString(),
        created_at: new Date(Date.now() - 86400000 * 7).toISOString(),
        updated_at: new Date().toISOString(),
        created_by: "System Administrator",
        owner_user_id: "demo-user-1",
      },
      {
        id: "conn-demo-postgres",
        provider: "postgres",
        display_name: "Enterprise Core DB",
        account_identifier: "db-primary.internal.nanvi:5432/core",
        scope_level: "organization",
        status: "CONNECTED",
        status_reason: null,
        granted_scopes: ["read_tables", "run_queries"],
        metadata_safe: { host: "db-primary.internal.nanvi", port: 5432, database: "core" },
        credential_type: "db_password",
        last_tested_at: new Date(Date.now() - 7200000).toISOString(),
        last_used_at: new Date().toISOString(),
        last_synced_at: new Date().toISOString(),
        created_at: new Date(Date.now() - 86400000 * 14).toISOString(),
        updated_at: new Date().toISOString(),
        created_by: "IT Admin",
        owner_user_id: "demo-admin-1",
      },
    ];

    return {
      connections: connectionsList,
      total: connectionsList.length,
    } as unknown as T;
  }

  if (cleanPath.startsWith("/connections/")) {
    if (method === "DELETE") {
      return {} as unknown as T;
    }
    if (method === "PATCH") {
      let bodyObj: any = {};
      try {
        if (init?.body) bodyObj = JSON.parse(init.body as string);
      } catch {}
      const updatedConn: ConnectionPublic = {
        id: cleanPath.split("/").pop() || "conn-demo",
        provider: "google",
        display_name: bodyObj.display_name || "Updated Connection",
        account_identifier: "executive@nanvi.enterprise",
        scope_level: "organization",
        status: "CONNECTED",
        status_reason: null,
        granted_scopes: ["read"],
        metadata_safe: {},
        credential_type: "oauth2",
        last_tested_at: new Date().toISOString(),
        created_at: new Date(Date.now() - 86400000).toISOString(),
        updated_at: new Date().toISOString(),
      };
      return updatedConn as unknown as T;
    }
  }

  if (cleanPath.startsWith("/sources/")) {
    const id = cleanPath.split("/").pop() || "doc-1";
    return {
      reference_id: id,
      source_type: "file",
      title: "Enterprise Strategy & Operations Briefing.pdf",
      snippet: "Nanvi Enterprise Assistant incorporates zero-trust role-based access control, cryptographic transparent citation traces, and multi-modal voice processing.",
      location: "CompanyData/Projects/Enterprise_Strategic_Plan_2026.pdf",
      page: 2,
    } as unknown as T;
  }

  if (cleanPath === "/documents/upload") {
    return {
      status: "ok",
      filename: "uploaded_doc.pdf",
      path: "CompanyData/uploaded_doc.pdf",
      size_bytes: 2048,
      message: "Document indexed and secured successfully.",
    } as unknown as T;
  }

  if (cleanPath.startsWith("/reports/") && cleanPath.endsWith("/download")) {
    const downloadUrl = typeof window !== "undefined" ? window.location.origin : "#";
    return { download_url: downloadUrl } as unknown as T;
  }

  if (cleanPath === "/chat/file-search") {
    let query = "";
    let localFiles: any[] = [];
    try {
      if (init?.body) {
        const parsed = JSON.parse(init.body as string);
        query = parsed.query || "";
        if (Array.isArray(parsed.local_files)) localFiles = parsed.local_files;
      }
    } catch {}
    if (localFiles.length > 0) {
      return {
        conversation_id: `conv-${Date.now()}`,
        answer: `Found **${localFiles.length}** matching document${localFiles.length === 1 ? "" : "s"} in **Local Storage** for **${query}**:`,
        files: localFiles,
        total_count: localFiles.length,
        source: "local",
        capability: "document_search",
        sources: localFiles.map((f, i) => ({
          reference_id: `local-${i}`,
          source_type: "file",
          display_name: f.name,
          title: f.name,
          location: f.full_path || f.path,
        })),
      } as unknown as T;
    }
  }

  if (cleanPath === "/chat") {
    let query = "Hello";
    let conversationId = `conv-${Date.now()}`;
    let localCtx: any = null;
    try {
      if (init?.body) {
        const parsed = JSON.parse(init.body as string);
        if (parsed.query) query = parsed.query;
        if (parsed.conversation_id) conversationId = parsed.conversation_id;
        localCtx = parsed.context_override?.local_context || null;
      }
    } catch {
      // Keep default query
    }

    const qLower = query.toLowerCase();
    const isEmail = isEmailQuery(query);
    const isGreeting = /^(hi|hello|hey|hola|greetings|good\s+morning|good\s+afternoon|good\s+evening)\b/i.test(query.trim());

    if (isEmail) {
      const emailAnswer = `### 📬 Executive Mailbox Briefing (3 Unread Messages)

I have checked your connected Google Workspace inbox for **Executive Leadership**:

1. **Board Meeting Pre-Read: Q3 Operations & Financial Performance**
   * **Sender:** Sarah Jenkins (VP Operations) \`<s.jenkins@nanvi.enterprise>\`
   * **Received:** Today, 08:30 AM
   * **Key Highlights:** Attached slide deck for Thursday's board sync. Annual Recurring Revenue (ARR) is up **14.2%** quarter-over-quarter; enterprise client retention is at **98.4%**. Action requested: Review slide 5 (H2 hiring plan) before 3:00 PM.

2. **Security Audit & Compliance Sign-Off (SOC2 Type II)**
   * **Sender:** DevSecOps Team \`<security@nanvi.enterprise>\`
   * **Received:** Yesterday, 05:15 PM
   * **Key Highlights:** Annual penetration testing completed with **zero critical findings**. Zero-Trust role-based access rules and cryptographic audit trails successfully validated for enterprise SOC2 compliance.

3. **Vendor Contract Renewal: Cloud Infrastructure**
   * **Sender:** Legal & Procurement \`<procurement@nanvi.enterprise>\`
   * **Received:** Yesterday, 02:40 PM
   * **Key Highlights:** Proposed 3-year enterprise commit tier reduces annualized compute and database costs by **22%**. Contract document generated and awaiting CEO signature.

---
*Would you like me to draft an approval response to Sarah Jenkins, or prepare an executive summary of the cloud contract?*`;

      const emailSources = [
        {
          reference_id: "demo-email-1",
          source_type: "email",
          display_name: "Executive Briefing: Q3 Performance",
          title: "Operations & Leadership Sync",
          timestamp: new Date().toISOString(),
        },
        {
          reference_id: "demo-email-2",
          source_type: "email",
          display_name: "SOC2 Compliance Attestation",
          title: "Security & Governance Audit Report",
          timestamp: new Date(Date.now() - 86400000).toISOString(),
        },
        {
          reference_id: "demo-email-3",
          source_type: "email",
          display_name: "Vendor Contract Renewal: Cloud Infrastructure",
          title: "Legal & Procurement Update",
          timestamp: new Date(Date.now() - 172800000).toISOString(),
        },
      ];

      return {
        conversation_id: conversationId,
        answer: emailAnswer,
        capability: "email",
        sources: emailSources,
        trace: [
          "Zero-Trust RBAC policy evaluation: User role authorized for mailbox access",
          "Retrieved recent unread messages from connected Google Workspace inbox",
          "Synthesized executive briefing with cryptographic attestation",
        ],
        history: [
          { role: "user", content: query, created_at: new Date().toISOString() },
          { role: "assistant", content: emailAnswer, created_at: new Date().toISOString() },
        ],
        file_results: [
          {
            name: "Board Meeting Pre-Read: Q3 Operations & Financial Performance.eml",
            path: "Email: Board Meeting Pre-Read (From: Sarah Jenkins)",
            type: "eml",
            modified_at: new Date().toISOString(),
            open_url: "https://mail.google.com/mail/u/0/#inbox",
            source: "email",
            content_snippet: "Attached slide deck for Thursday's board sync. Annual Recurring Revenue (ARR) is up 14.2% quarter-over-quarter...",
          },
          {
            name: "Security Audit & Compliance Sign-Off (SOC2 Type II).eml",
            path: "Email: SOC2 Compliance Sign-Off (From: DevSecOps Team)",
            type: "eml",
            modified_at: new Date(Date.now() - 86400000).toISOString(),
            open_url: "https://mail.google.com/mail/u/0/#inbox",
            source: "email",
            content_snippet: "Annual penetration testing completed with zero critical findings. Zero-Trust role-based access rules validated...",
          },
          {
            name: "Vendor Contract Renewal: Cloud Infrastructure.eml",
            path: "Email: Cloud Infrastructure Renewal (From: Legal & Procurement)",
            type: "eml",
            modified_at: new Date(Date.now() - 172800000).toISOString(),
            open_url: "https://mail.google.com/mail/u/0/#inbox",
            source: "email",
            content_snippet: "Proposed 3-year enterprise commit tier reduces annualized compute and database costs by 22%...",
          },
        ],
      } as unknown as T;
    }

    if (isGreeting) {
      const greetingAnswer = `Hello! I am your **Nanvi AI Enterprise Assistant**. How can I help you today?\n\nHere are some things you can ask me:\n- 📬 **"Check my recent email and update me"** to review your latest inbox messages\n- 📁 **"What files are in my folder?"** to search connected company documents\n- 📊 **"Show Q3 financial performance"** for operational analytics\n- 📑 **"Review active contracts"** for legal agreements`;
      return {
        conversation_id: conversationId,
        answer: greetingAnswer,
        capability: "conversation",
        sources: [],
        trace: ["Conversational greeting handled directly"],
        history: [
          { role: "user", content: query, created_at: new Date().toISOString() },
          { role: "assistant", content: greetingAnswer, created_at: new Date().toISOString() },
        ],
      } as unknown as T;
    }

    if (localCtx && localCtx.zero_match && (!Array.isArray(localCtx.files) || localCtx.files.length === 0)) {
      const stats = localCtx.folder_stats;
      const cats = stats?.categories ? Object.entries(stats.categories).slice(0, 8).map(([k, v]) => `${k} (${v})`).join(", ") : "";
      const zeroAnswer = localCtx.structured_summary
        ? `${String(localCtx.structured_summary)}\n\n> **Offline Local Search Mode:** Cloud AI synthesis is offline. Showing structured on-device extractions.`
        : (
          `No matching files or records were found in your connected folder for **${query}**.` +
          (stats?.total_files ? `\n\nScanned **${stats.total_files}** indexed files` + (cats ? ` across: ${cats}.` : ".") : "") +
          `\n\n💡 **Suggestions:** Try asking for an invoice ID, overdue invoices, employee headcount, salary range, customer list, or browse one of those categories.` +
          `\n\n> **Offline Local Search Mode:** Cloud generative AI is unreachable. Configure an optional local SLM or reconnect to enable full AI synthesis.`
        );
      return {
        conversation_id: conversationId,
        answer: zeroAnswer,
        capability: "knowledge",
        sources: [],
        trace: ["Offline Local Search Mode: on-device zero-match verification across indexed folder"],
        history: [
          { role: "user", content: query, created_at: new Date().toISOString() },
          { role: "assistant", content: zeroAnswer, created_at: new Date().toISOString() },
        ],
      } as unknown as T;
    }

    if (localCtx && ((Array.isArray(localCtx.chunks) && localCtx.chunks.length > 0) || (Array.isArray(localCtx.files) && localCtx.files.length > 0) || localCtx.structured_summary)) {
      const matchedChunks = Array.isArray(localCtx.chunks) ? localCtx.chunks : [];
      const matchedFiles = Array.isArray(localCtx.files) ? localCtx.files : [];
      const totalMatches = typeof localCtx.total_matches === "number" ? localCtx.total_matches : matchedFiles.length;
      const offset = typeof localCtx.offset === "number" ? localCtx.offset : 0;
      const enginesUsed = Array.isArray(localCtx.engines_used) && localCtx.engines_used.length > 0
        ? localCtx.engines_used.join(" + ")
        : "local index";
      const parts: string[] = [];
      if (localCtx.structured_summary) {
        parts.push(String(localCtx.structured_summary));
      } else if (matchedChunks.length > 0) {
        const excerptLines = ["**Relevant Document Excerpts**"];
        const seenChunkFiles = new Set<string>();
        for (const ch of matchedChunks.slice(0, 4)) {
          const fn = String(ch.filename || ch.citation || "Local Document").split(/[\\/]/).pop() || "Local Document";
          if (seenChunkFiles.has(fn.toLowerCase())) continue;
          seenChunkFiles.add(fn.toLowerCase());
          const snippet = String(ch.text || "").trim().replace(/\s+/g, " ").slice(0, 320);
          if (snippet) excerptLines.push(`• **${fn}**: ${snippet}`);
        }
        if (excerptLines.length > 1) parts.push(excerptLines.join("\n"));
      }
      const headerTxt = totalMatches > matchedFiles.length
        ? `Showing **${offset + 1}–${offset + matchedFiles.length}** of **${totalMatches}** matching files for **${query}**`
        : `Found matching records in your local folder for **${query}**`;
      let localAnswer = parts.length > 0
        ? (localCtx.structured_summary ? parts.join("\n\n") : `${headerTxt}\n\n${parts.join("\n\n")}`)
        : headerTxt;
      if (localCtx.has_more) {
        localAnswer += `\n\n💡 **${totalMatches - (offset + matchedFiles.length)} more matching files available.** Say **"I need more"** or **"next set"** to see the next batch.`;
      }
      localAnswer += `\n\n> **Offline Local Search Mode** (${enginesUsed}): Document retrieval & structured matching ran 100% locally. Cloud generative AI synthesis is unavailable while offline unless a local OpenAI-compatible SLM is configured.`;
      const localSources = matchedFiles.map((f: any, i: number) => ({
        reference_id: `desk-demo-${offset + i}`,
        source_type: "file",
        display_name: f.name || "document",
        title: f.name || "document",
        location: f.full_path || f.path || "",
      }));
      return {
        conversation_id: conversationId,
        answer: localAnswer,
        capability: "knowledge",
        sources: localSources,
        trace: [
          `Offline Local Search Mode executed on-device via ${enginesUsed}`,
          "Cloud generative LLM unavailable; returning verified retrieved excerpts without fabrication",
        ],
        history: [
          { role: "user", content: query, created_at: new Date().toISOString() },
          { role: "assistant", content: localAnswer, created_at: new Date().toISOString() },
        ],
        file_results: matchedFiles,
      } as unknown as T;
    }

    let answer = "";
    let capability = "knowledge";
    let sources: any[] = [];
    let trace: string[] = [
      "Zero-Trust RBAC policy evaluation: User role authorized for tenant queries",
      "Scanning indexed enterprise documents and connected data stores",
      "Grounding response with cryptographic source attestation",
    ];

    if (qLower.includes("email") || qLower.includes("inbox") || qLower.includes("mail") || qLower.includes("message")) {
      capability = "email";
      answer = `### 📬 Executive Mailbox Briefing (3 Unread Messages)

I have checked your connected Google Workspace inbox for **Executive Leadership**:

1. **Board Meeting Pre-Read: Q3 Operations & Financial Performance**
   * **Sender:** Sarah Jenkins (VP Operations) \`<s.jenkins@nanvi.enterprise>\`
   * **Received:** Today, 08:30 AM
   * **Key Highlights:** Attached slide deck for Thursday's board sync. Annual Recurring Revenue (ARR) is up **14.2%** quarter-over-quarter; enterprise client retention is at **98.4%**. Action requested: Review slide 5 (H2 hiring plan) before 3:00 PM.

2. **Security Audit & Compliance Sign-Off (SOC2 Type II)**
   * **Sender:** DevSecOps Team \`<security@nanvi.enterprise>\`
   * **Received:** Yesterday, 05:15 PM
   * **Key Highlights:** Annual penetration testing completed with **zero critical findings**. Zero-Trust role-based access rules and cryptographic audit trails successfully validated for enterprise SOC2 compliance.

3. **Vendor Contract Renewal: Cloud Infrastructure**
   * **Sender:** Legal & Procurement \`<procurement@nanvi.enterprise>\`
   * **Received:** Yesterday, 02:40 PM
   * **Key Highlights:** Proposed 3-year enterprise commit tier reduces annualized compute and database costs by **22%**. Contract document generated and awaiting CEO signature.

---
*Would you like me to draft an approval response to Sarah Jenkins, or prepare an executive summary of the cloud contract?*`;

      sources = [
        {
          reference_id: "demo-email-1",
          source_type: "email",
          display_name: "Executive Briefing: Q3 Performance",
          title: "Operations & Leadership Sync",
          timestamp: new Date().toISOString(),
        },
        {
          reference_id: "demo-email-2",
          source_type: "email",
          display_name: "SOC2 Compliance Attestation",
          title: "Security & Governance Audit Report",
          timestamp: new Date(Date.now() - 86400000).toISOString(),
        },
        {
          reference_id: "demo-doc-1",
          source_type: "file",
          display_name: "Enterprise_Strategic_Plan_2026.pdf",
          title: "Enterprise Strategy & Operations",
          location: "CompanyData/Projects/Enterprise_Strategic_Plan_2026.pdf",
          page: 2,
        },
      ];
      trace.push("Cross-referenced Google Workspace mail stream with Enterprise Directory");
    } else if (qLower.includes("revenue") || qLower.includes("finance") || qLower.includes("financial") || qLower.includes("arr") || qLower.includes("profit") || qLower.includes("budget") || qLower.includes("q3")) {
      capability = "analytics";
      answer = `### 📊 Q3 Financial & Strategic Performance Summary

Based on authorized enterprise records in **CompanyData/Finance**:

* **Annual Recurring Revenue (ARR):** **$24.8M** (+14.2% YoY growth, exceeding consensus target).
* **Net Revenue Retention (NRR):** **118%** sustained across enterprise-tier accounts.
* **Operating Margin:** **23.5%**, outperforming the initial Q3 forecast target of 21.0%.
* **Gross Margin:** **78.2%**, maintained through optimized cloud database operations.

**Key Financial Takeaways:**
1. **Enterprise Expansion:** 3 Fortune 500 pilots converted into multi-year commercial commitments.
2. **Cash Runway:** Current cash reserves provide **28 months** of operational runway without external financing.
3. **Budget Variance:** Operational expenditures tracked 4.1% below forecasted quarterly ceiling.

---
*Would you like an export of the variance breakdown or a department-by-department allocation report?*`;

      sources = [
        {
          reference_id: "demo-doc-1",
          source_type: "file",
          display_name: "Enterprise_Strategic_Plan_2026.pdf",
          title: "Enterprise Strategy & Operations",
          location: "CompanyData/Projects/Enterprise_Strategic_Plan_2026.pdf",
          page: 4,
        },
        {
          reference_id: "demo-doc-finance",
          source_type: "file",
          display_name: "Q3_Consolidated_Financial_Model.xlsx",
          title: "Quarterly Financial Performance & Budget",
          location: "CompanyData/Finance/Q3_Consolidated_Financial_Model.xlsx",
          page: 1,
        },
      ];
      trace.push("Extracted ledger balances and operational projections from financial models");
    } else if (qLower.includes("contract") || qLower.includes("legal") || qLower.includes("agreement") || qLower.includes("nda") || qLower.includes("sla")) {
      capability = "knowledge";
      answer = `### 📑 Active Enterprise Contracts Overview

Reviewing authorized agreements in **CompanyData/Contracts**:

1. **Apex Global Logistics (Master Services Agreement MSA-2025-089)**
   * **Total Value:** $1,200,000 / 3-Year Commitment
   * **Status:** Fully executed. Includes 24/7 dedicated enterprise support and 99.95% uptime SLA.
   * **Governing Jurisdiction:** Delaware, USA.

2. **Meridian Health Systems (Business Associate Agreement BAA-2026-012)**
   * **Total Value:** $850,000 / Annual Subscription
   * **Status:** Active. HIPAA-compliant zero-trust encryption and encrypted audit logging confirmed.

3. **Horizon Cloud Services (Vendor SLA-2024-441)**
   * **Total Value:** $420,000 / Annual
   * **Status:** Renewal review window opens in **45 days**. Procurement proposes auto-renewal with 22% compute discount.

---
*Would you like me to flag the renewal milestones in your calendar or inspect specific liability terms?*`;

      sources = [
        {
          reference_id: "demo-doc-contract-1",
          source_type: "file",
          display_name: "Apex_Global_Logistics_MSA_Executed.pdf",
          title: "Master Services Agreement: Apex Global",
          location: "CompanyData/Contracts/Apex_Global_Logistics_MSA_Executed.pdf",
          page: 1,
        },
        {
          reference_id: "demo-doc-1",
          source_type: "file",
          display_name: "Enterprise_Strategic_Plan_2026.pdf",
          title: "Enterprise Strategy & Operations",
          location: "CompanyData/Projects/Enterprise_Strategic_Plan_2026.pdf",
          page: 6,
        },
      ];
      trace.push("Verified contract metadata against Zero-Trust RBAC access rules");
    } else if (qLower.includes("team") || qLower.includes("employee") || qLower.includes("people") || qLower.includes("headcount") || qLower.includes("hr")) {
      capability = "knowledge";
      answer = `### 👥 Enterprise Organizational & Personnel Directory

Authorized HR directory records in **CompanyData/HR**:

* **Total Headcount:** **142 employees** across 5 global offices (San Francisco, New York, London, Singapore, Bangalore).
* **Department Breakdown:**
  * **Engineering & Infrastructure:** 52 members (36.6%)
  * **Product, AI & Design:** 18 members (12.7%)
  * **Enterprise Sales & Customer Success:** 34 members (23.9%)
  * **Finance & Operations:** 22 members (15.5%)
  * **Legal, Compliance & People Ops:** 16 members (11.3%)
* **Active Requisitions:** 8 open positions prioritized for Cloud Security Engineers and Solutions Architects.
* **Compliance Status:** 100% completion of Q3 enterprise data handling and Zero-Trust credential security training.`;

      sources = [
        {
          reference_id: "demo-doc-hr",
          source_type: "file",
          display_name: "Organizational_Headcount_Q3.xlsx",
          title: "Human Resources & Workforce Planning",
          location: "CompanyData/HR/Organizational_Headcount_Q3.xlsx",
          page: 1,
        },
      ];
      trace.push("Retrieved organizational directory from authorized HR storage partition");
    } else if (qLower.includes("invoice") || qLower.includes("bill") || qLower.includes("payable") || qLower.includes("overdue") || qLower.includes("unpaid")) {
      capability = "analytics";
      answer = `### 📑 Enterprise Invoices & Receivables Summary

Reviewing billing and accounts payable/receivable records in **CompanyData/Finance**:

1. **CloudNova Technologies (INV-2026-0042)**
   * **Amount:** $47,200.00 · **Status:** Overdue (Net 30) · **Due Date:** October 28, 2026
   * **Customer:** Nanvi Solutions · **Department:** Finance

2. **Vertex Logistics (INV-00008)**
   * **Amount:** INR 106,984.70 · **Status:** Paid · **Invoice Date:** January 3, 2026
   * **Vendor:** CloudNova · **Customer:** Vertex Logistics

3. **BluePeak Solutions (INV-00004)**
   * **Amount:** INR 174,199.86 · **Status:** Overdue · **Invoice Date:** January 28, 2025
   * **Vendor:** Prime Telecom · **Customer:** BluePeak Solutions

---
*Would you like to export the overdue aging analysis or check remittance statuses?*`;

      sources = [
        {
          reference_id: "demo-doc-inv-1",
          source_type: "file",
          display_name: "mock_test_invoice.pdf",
          title: "Invoice INV-2026-0042",
          location: "CompanyData/Finance/mock_test_invoice.pdf",
          page: 1,
        },
        {
          reference_id: "demo-doc-inv-2",
          source_type: "file",
          display_name: "invoice_008.txt",
          title: "Invoice INV-00008",
          location: "CompanyData/Finance/invoice_008.txt",
          page: 1,
        },
      ];
      trace.push("Audited accounts payable ledger and matched invoice records");
    } else if (qLower.includes("customer") || qLower.includes("client") || qLower.includes("vendor") || qLower.includes("supplier")) {
      capability = "knowledge";
      answer = `### 🏢 Enterprise Customer & Partner Directory

Authorized client and vendor records in **CompanyData/Customers**:

* **Customer 001 (Acme Corporation):**
  * **Annual Recurring Value (ARR):** **$450,000**
  * **Tier:** Enterprise · **Status:** Active · **Renewal Window:** Q3 2026
* **Customer 002 (Globex Global):**
  * **Annual Recurring Value (ARR):** **$320,000**
  * **Tier:** Enterprise · **Status:** Active
* **Customer 015 (Asteron Technologies):**
  * **Annual Recurring Value (ARR):** **$780,000**
  * **Tier:** Strategic Tier 1 · **Status:** Active · **Region:** APAC

---
*Would you like to view contact details, active contract clauses, or billing history for a specific customer?*`;

      sources = [
        {
          reference_id: "demo-doc-cust-1",
          source_type: "file",
          display_name: "customer_directory.xlsx",
          title: "Enterprise Client Directory",
          location: "CompanyData/Customers/customer_directory.xlsx",
          page: 1,
        },
        {
          reference_id: "demo-doc-cust-2",
          source_type: "file",
          display_name: "contract_register_01.csv",
          title: "Commercial Contract Register",
          location: "CompanyData/Contracts/contract_register_01.csv",
          page: 1,
        },
      ];
      trace.push("Retrieved client accounts from enterprise customer register");
    } else {
      capability = "knowledge";
      answer = `### ⚡ Nanvi AI Enterprise Analysis

I have processed your inquiry: **"${query}"** against authorized enterprise repositories.

* **Context Evaluation:** Cross-referenced enterprise documents, active connections, and team resources.
* **Role-Based Access Control:** All retrieved sources adhere to your authorized user role permissions.
* **Security & Transparency:** Cryptographic attestation references are cited below for full auditability.

**Key Findings:**
1. Relevant enterprise records for **"${query}"** are indexed and accessible in the company repository.
2. Zero data exfiltration rules and SOC2 Type II cryptographic security invariants are enforced for all queries.
3. You can connect additional live services (Google Workspace, PostgreSQL, Supabase, Slack, Jira) in the **Connections Hub**.

---
*How else can I assist you with this analysis or related operational workflows?*`;

      sources = [
        {
          reference_id: "demo-doc-1",
          source_type: "file",
          display_name: "Enterprise_Strategic_Plan_2026.pdf",
          title: "Enterprise Strategy & Operations",
          location: "CompanyData/Projects/Enterprise_Strategic_Plan_2026.pdf",
          page: 2,
        },
        {
          reference_id: "demo-email-1",
          source_type: "email",
          display_name: "Executive Briefing: Q3 Performance",
          title: "Operations & Leadership Sync",
          timestamp: new Date().toISOString(),
        },
      ];
    }

    const chatRes: ChatResponse = {
      conversation_id: conversationId,
      answer,
      capability,
      sources,
      trace,
      history: [
        { role: "user", content: query, created_at: new Date().toISOString() },
        { role: "assistant", content: answer, created_at: new Date().toISOString() },
      ],
    };
    return chatRes as unknown as T;
  }

  if (cleanPath === "/voice/transcribe") {
    return {
      text: "How are our quarterly milestones performing?",
      confidence: 0.98,
    } as unknown as T;
  }

  if (cleanPath === "/voice/respond") {
    let query = "Voice assistant active";
    let conversationId = `conv-${Date.now()}`;
    try {
      if (init?.body) {
        const parsed = JSON.parse(init.body as string);
        if (parsed.query) query = parsed.query;
        if (parsed.conversation_id) conversationId = parsed.conversation_id;
      }
    } catch {
      // Keep default
    }

    const qLower = query.toLowerCase();
    let spokenText = "Welcome to Nanvi Enterprise Assistant. Voice mode is active.";
    let answerText = `Voice session processed query: "${query}".`;
    let importantPoints = ["Voice mode connected", "Zero-trust session established", "Ready for voice input"];

    if (qLower.includes("email") || qLower.includes("mail") || qLower.includes("inbox")) {
      spokenText = "You have three unread messages in your executive inbox, including Sarah's board meeting pre-read and the SOC 2 security compliance report.";
      answerText = "Checked executive mailbox. Discovered 3 unread messages: Board Pre-read from Sarah Jenkins, SOC2 compliance report, and cloud vendor renewal contract.";
      importantPoints = ["3 unread emails identified", "Board deck review requested by 3 PM", "SOC2 compliance verified"];
    } else if (qLower.includes("revenue") || qLower.includes("finance") || qLower.includes("profit") || qLower.includes("q3")) {
      spokenText = "Quarter 3 Annual Recurring Revenue is 24.8 million dollars, up 14.2 percent year over year, with an operating margin of 23.5 percent.";
      answerText = "Q3 ARR reached $24.8M (+14.2% YoY). Net Revenue Retention is 118%, with 28 months of operational runway.";
      importantPoints = ["$24.8M ARR (+14.2% YoY)", "118% Net Revenue Retention", "28 months cash runway"];
    }

    const voiceRes: VoiceResponse = {
      conversation_id: conversationId,
      answer: answerText,
      spoken_text: spokenText,
      important_points: importantPoints,
      capability: "voice",
      sources: [
        {
          reference_id: "demo-doc-1",
          source_type: "file",
          display_name: "Enterprise_Strategic_Plan_2026.pdf",
          title: "Enterprise Strategy & Operations",
          location: "CompanyData/Projects/Enterprise_Strategic_Plan_2026.pdf",
          page: 2,
        },
      ],
      trace: ["Voice neural core synthesized response", "RBAC access rules verified"],
      history: [
        { role: "user", content: query, created_at: new Date().toISOString() },
        { role: "assistant", content: spokenText, created_at: new Date().toISOString() },
      ],
    };
    return voiceRes as unknown as T;
  }

  if (cleanPath === "/local-agent/status") {
    return {
      is_online: false,
      last_heartbeat: null,
      agent_version: "browser-direct",
      connected_folders: [],
      total_files: 0,
      total_chunks: 0,
    } as unknown as T;
  }

  return undefined;
}

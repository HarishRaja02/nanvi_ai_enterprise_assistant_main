import { useEffect } from "react";
import { LegalLayout } from "./LegalLayout";
import { Shield, Lock, FileSearch } from "lucide-react";

interface PrivacyPolicyPageProps {
  onNavigateToTerms: () => void;
  onBack: () => void;
}

const TOC = [
  { id: "overview", label: "1. Overview & Scope" },
  { id: "information-collected", label: "2. Information We Collect" },
  { id: "authentication", label: "3. Account Authentication & SSO" },
  { id: "google-data-policy", label: "4. Google API User Data & Limited Use" },
  { id: "microsoft-graph", label: "5. Microsoft 365 & Graph Data" },
  { id: "file-processing", label: "6. Document & Local File Processing" },
  { id: "ai-processing", label: "7. AI Processing & Third-Party LLMs" },
  { id: "security-retention", label: "8. Data Security, Retention & Deletion" },
  { id: "user-rights", label: "9. Your Rights & Choices" },
  { id: "contact-us", label: "10. Contact Information" },
  { id: "age-restriction", label: "11. Age Restriction & Enterprise Use" },
  { id: "security-incidents", label: "12. Security Incidents & Breach Notification" },
  { id: "policy-changes", label: "13. Changes to This Privacy Policy" },
];

export function PrivacyPolicyPage({ onNavigateToTerms, onBack }: PrivacyPolicyPageProps) {
  useEffect(() => {
    document.title = "Privacy Policy — Nanvi AI Enterprise Assistant";
    if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
      try {
        window.scrollTo(0, 0);
      } catch {
        // Safe fallback in test environments
      }
    }
  }, []);

  return (
    <LegalLayout
      activePage="privacy"
      title="Privacy Policy"
      description="How Nanvi AI Enterprise Assistant accesses, processes, protects, and handles your enterprise documents, emails, and account data with Zero-Trust principles."
      badge="Enterprise Data Privacy & Security"
      lastUpdated="November 25, 2026"
      tableOfContents={TOC}
      onNavigateToPrivacy={() => { }}
      onNavigateToTerms={onNavigateToTerms}
      onBack={onBack}
    >
      {/* ── 1. Overview & Scope ───────────────────────────────── */}
      <section id="overview" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">01</span>
          <span>Overview & Scope</span>
        </h2>
        <p>
          This Privacy Policy explains how <strong>Nanvi AI Enterprise Assistant</strong> (operated by{" "}
          <span className="legal-placeholder-tag">[Insert Legal Entity Name, e.g., Nanvi AI Technologies Private Limited]</span>,{" "}
          referred to herein as &ldquo;Nanvi&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;, or &ldquo;our&rdquo;) collects,
          uses, processes, stores, and protects information when you access or interact with our web application
          (<code>https://nanviaienterpriseassistant.vercel.app</code>), Windows desktop application, API services, and
          associated productivity integrations (collectively, the &ldquo;Service&rdquo;).
        </p>
        <p>
          Nanvi is designed specifically for enterprise environments, professional organizations, and authorized corporate
          teams. We operate under a <strong>Zero-Trust architecture</strong>: access to organizational knowledge, company files,
          mailboxes, and databases is strictly governed by server-enforced Role-Based Access Controls (RBAC) and explicit user consent.
        </p>
        <div className="legal-callout legal-callout-info">
          <div className="legal-callout-title">
            <Shield size={16} aria-hidden="true" />
            <span>Core Privacy Commitment</span>
          </div>
          <p>
            Your enterprise documents, internal queries, and personal mailbox contents belong exclusively to you and your
            organization. We do not sell your personal or business data, we do not share it with advertisers, and we never
            use your sensitive private data or Google user data to train, retrain, or improve generalized public artificial
            intelligence or machine learning models.
          </p>
        </div>
      </section>

      {/* ── 2. Information We Collect ─────────────────────────── */}
      <section id="information-collected" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">02</span>
          <span>Information We Collect</span>
        </h2>
        <p>
          We collect only the minimum information necessary to authenticate your identity, execute your requested searches,
          and provide real-time AI assistant workflows:
        </p>
        <ul>
          <li>
            <strong>Account &amp; Identity Information:</strong> Your user identity identifier (Subject/User ID), full name,
            corporate email address, organizational role (e.g., Superior, Supervisor, Project Engineer, Employee, or Administrator),
            and enterprise tenant ID.
          </li>
          <li>
            <strong>Authentication Credentials &amp; Tokens:</strong> Cryptographically signed session tokens (JWT) and
            encrypted OAuth 2.0 access and refresh tokens returned when you explicitly link external services (such as Google Workspace
            or Microsoft 365).
          </li>
          <li>
            <strong>Local &amp; Workplace File Metadata:</strong> When you connect a local folder or choose specific documents
            (e.g., PDF, DOCX, XLSX, PPTX, CSV, TXT) for assistant search, the desktop application inspects file names, file paths,
            and extracted text.
          </li>
          <li>
            <strong>Mailbox &amp; Communication Metadata:</strong> When you search or interact with connected mailboxes (Google Gmail,
            Microsoft Outlook, Yahoo Mail), we retrieve message headers, subjects, sender addresses, timestamps, body excerpts, and
            attachment names necessary to answer your queries.
          </li>
          <li>
            <strong>Operational Audit Logs:</strong> Access logs, query timestamps, operation types, and role verification records
            maintained for administrative security and compliance within your enterprise tenant.
          </li>
        </ul>
      </section>

      {/* ── 3. Account Authentication & SSO ───────────────────── */}
      <section id="authentication" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">03</span>
          <span>Account Authentication &amp; Federated SSO</span>
        </h2>
        <p>
          Nanvi AI Enterprise Assistant supports enterprise authentication through internal credential verification as well as
          federated Single Sign-On (SSO) via Google and Microsoft Azure Active Directory:
        </p>
        <ul>
          <li>
            <strong>Server-Signed Cryptographic Tokens:</strong> User sessions are validated using server-signed tokens.
            Each API request verifies the caller&rsquo;s active role and organizational tenant boundaries before executing queries.
          </li>
          <li>
            <strong>OAuth 2.0 PKCE Authorization:</strong> Third-party connections use industry-standard OAuth 2.0 authorization
            code exchange with PKCE verifiers. You authenticate directly on the provider&rsquo;s official login interface (e.g.,
            Google or Microsoft); Nanvi never sees or stores your external account password.
          </li>
          <li>
            <strong>Credential Encryption at Rest:</strong> All external OAuth refresh tokens and API secrets are encrypted at rest
            using symmetric Fernet AES-128-CBC encryption before being stored in the database.
          </li>
        </ul>
      </section>

      {/* ── 4. Google API User Data & Limited Use ─────────────── */}
      <section id="google-data-policy" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">04</span>
          <span>Google API User Data &amp; Limited Use Disclosure</span>
        </h2>
        <p>
          Nanvi AI Enterprise Assistant allows users to optionally connect their Google Workspace or Gmail accounts to search
          their emails, check recent inbox messages, locate Google Drive documents, or prepare email drafts.
        </p>

        <h3 style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--ink-950)", margin: "1.25rem 0 0.5rem" }}>
          Google Scopes Requested
        </h3>
        <p>Depending on the specific services you enable in <strong>Settings → Connections Hub</strong>, Nanvi requests the following scopes:</p>

        <div className="legal-table-wrapper">
          <table className="legal-table">
            <thead>
              <tr>
                <th>Scope</th>
                <th>Purpose</th>
                <th>User Action Required</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>https://www.googleapis.com/auth/gmail.readonly</code></td>
                <td>Read user messages and threads to answer inbox search and briefing queries in chat.</td>
                <td>Explicit user query (e.g. &ldquo;check my recent emails&rdquo;)</td>
              </tr>
              <tr>
                <td><code>https://www.googleapis.com/auth/gmail.send</code></td>
                <td>Send or reply to emails drafted by the assistant upon user direction.</td>
                <td>Requires explicit user confirmation button in chat</td>
              </tr>
              <tr>
                <td><code>https://www.googleapis.com/auth/drive.readonly</code></td>
                <td>Search and retrieve authorized Google Drive files cited in user questions.</td>
                <td>Explicit user document search query</td>
              </tr>
              <tr>
                <td><code>openid</code>, <code>profile</code>, <code>email</code></td>
                <td>Verify your Google account identity and display your email address in Settings.</td>
                <td>Initial account linking</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="legal-callout legal-callout-success">
          <div className="legal-callout-title">
            <Lock size={16} aria-hidden="true" />
            <span>Google API Services User Data Policy — Limited Use Disclosure</span>
          </div>
          <p>
            Nanvi AI Enterprise Assistant&rsquo;s use and transfer to any other app of information received from Google APIs will
            adhere to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements:
          </p>
          <ul style={{ margin: "0.5rem 0 0 1rem" }}>
            <li>
              <strong>No Generalized AI/ML Training:</strong> Google user data is <strong>NEVER used to train, retrain, or fine-tune</strong> generalized
              artificial intelligence or machine learning foundation models.
            </li>
            <li>
              <strong>No Advertising:</strong> Google user data is <strong>NEVER used or transferred for serving advertisements</strong>,
              including personalized, retargeted, or interest-based advertising.
            </li>
            <li>
              <strong>No Sale of Data:</strong> Google user data is <strong>NEVER sold, leased, or rented</strong> to third parties or data brokers.
            </li>
            <li>
              <strong>Strict Purpose Limitation:</strong> We only access, use, and process Google user data strictly to provide user-facing
              features that are prominent in the Nanvi interface and explicitly requested by the authorized user.
            </li>
            <li>
              <strong>Human Access Restrictions:</strong> Humans will not read your Google user data unless: (a) you have provided explicit affirmative
              consent for specific support troubleshooting; (b) it is strictly necessary for security purposes (such as investigating abuse or malware);
              or (c) we are compelled by applicable law.
            </li>
          </ul>
        </div>
      </section>

      {/* ── 5. Microsoft 365 & Graph Data ─────────────────────── */}
      <section id="microsoft-graph" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">05</span>
          <span>Microsoft 365 &amp; Microsoft Graph Data</span>
        </h2>
        <p>
          When you link a Microsoft 365 or Outlook account, Nanvi interacts with the Microsoft Graph API using delegated user permissions:
        </p>
        <ul>
          <li>
            <strong>Requested Permissions:</strong> <code>User.Read</code>, <code>Mail.Read</code>, <code>Mail.ReadWrite</code>,{" "}
            <code>Mail.Send</code>, <code>Files.Read</code>, <code>Files.Read.All</code>, <code>Sites.Read.All</code>, and <code>offline_access</code>.
          </li>
          <li>
            <strong>Operational Scope:</strong> Used solely to search Outlook mailboxes, read email threads, view attachments, and index authorized
            OneDrive for Business or SharePoint documents upon direct user search queries.
          </li>
          <li>
            <strong>Revocation:</strong> You can disconnect your Microsoft 365 integration at any time from <strong>Settings → Connections Hub</strong>,
            which immediately deletes stored tokens and halts all synchronization.
          </li>
        </ul>
      </section>

      {/* ── 6. Document & Local File Processing ───────────────── */}
      <section id="file-processing" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">06</span>
          <span>Document &amp; Local File Processing</span>
        </h2>
        <p>
          Nanvi AI Enterprise Assistant provides robust document retrieval capabilities designed with data minimization in mind:
        </p>
        <div className="legal-callout legal-callout-info">
          <div className="legal-callout-title">
            <FileSearch size={16} aria-hidden="true" />
            <span>On-Device &amp; In-Memory Privacy in Desktop &amp; Web</span>
          </div>
          <p>
            <strong>Windows Desktop Application (MSIX / NSIS):</strong> When you connect a local folder (such as a directory of PDFs or Office files),
            the desktop engine indexes and parses files <em>locally on your machine</em>. Your local files are <strong>not uploaded</strong> to external
            cloud servers or centralized databases; text extraction and search scoring execute directly on-device.
          </p>
          <p style={{ marginTop: "0.5rem" }}>
            <strong>Web Application:</strong> When using directory picker tools in the browser, file handles remain in ephemeral browser memory
            (IndexedDB session storage) and are not broadcast to third parties.
          </p>
        </div>
      </section>

      {/* ── 7. AI Processing & Third-Party LLMs ────────────────── */}
      <section id="ai-processing" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">07</span>
          <span>AI Processing &amp; Third-Party AI Providers</span>
        </h2>
        <p>
          To provide natural language understanding, question answering, and document synthesis, Nanvi transmits structured prompts to
          enterprise-tier inference services:
        </p>
        <ul>
          <li>
            <strong>Enterprise Inference Providers:</strong> Inference requests are handled via secure enterprise API endpoints
            (such as Groq Cloud API using models like <code>openai/gpt-oss-120b</code>, or organization-configured private LLM instances).
          </li>
          <li>
            <strong>Encrypted Transit:</strong> All communications between the Nanvi backend and AI inference providers occur over TLS 1.3
            encrypted tunnels.
          </li>
          <li>
            <strong>No Data Retention for Public Training:</strong> Data transmitted during inference calls is processed ephemerally solely
            to generate the immediate chat completion. Our enterprise provider agreements stipulate that customer prompt data is not retained
            to train commercial or public foundation models.
          </li>
        </ul>
      </section>

      {/* ── 8. Data Security, Retention & Deletion ────────────── */}
      <section id="security-retention" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">08</span>
          <span>Data Security, Retention &amp; Deletion</span>
        </h2>
        <p>We implement multiple defense-in-depth measures to safeguard enterprise data:</p>
        <ul>
          <li>
            <strong>Cryptographic Storage:</strong> User account credentials and OAuth tokens are stored in an access-restricted PostgreSQL
            database (hosted on Supabase infrastructure) and encrypted at rest with Fernet AES-128-CBC encryption.
          </li>
          <li>
            <strong>Access Isolation:</strong> Multi-tenant database queries enforce organizational tenant separation, preventing cross-tenant
            data exposure.
          </li>
          <li>
            <strong>Data Retention:</strong> We retain account metadata and conversation history only for as long as your enterprise account
            remains active, or until deleted by you or your organization&rsquo;s administrator.
          </li>
          <li>
            <strong>Account Deletion &amp; Disconnection:</strong>
            <ul>
              <li>You may disconnect any third-party integration (Google, Microsoft, Yahoo) instantly via <strong>Settings → Connections Hub</strong>, which deletes the associated access credentials.</li>
              <li>You may clear your chat conversation history at any time using the conversation manager.</li>
              <li>Enterprise administrators can remove user profiles or request complete tenant data deletion by contacting support.</li>
            </ul>
          </li>
        </ul>
      </section>

      {/* ── 9. Your Rights & Choices ──────────────────────────── */}
      <section id="user-rights" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">09</span>
          <span>Your Rights &amp; Choices</span>
        </h2>
        <p>
          Depending on your jurisdiction (including the EU/EEA under GDPR, the UK, and California under CCPA/CPRA), you possess the following
          rights regarding your personal information:
        </p>
        <ul>
          <li><strong>Right of Access:</strong> Request confirmation of whether your data is processed and obtain an export of your information.</li>
          <li><strong>Right to Rectification:</strong> Request correction of inaccurate or incomplete personal records.</li>
          <li><strong>Right to Erasure (&ldquo;Right to be Forgotten&rdquo;):</strong> Request deletion of your personal data when no longer needed for business or legal purposes.</li>
          <li><strong>Right to Restrict or Object:</strong> Restrict or object to specific processing operations where applicable.</li>
          <li><strong>Right to Revoke Consent:</strong> Revoke OAuth consent at any time directly through Google Account Security (<code>myaccount.google.com/permissions</code>) or Microsoft Account Privacy settings.</li>
        </ul>
      </section>

      {/* ── 10. Contact Information ───────────────────────────── */}
      <section id="contact-us" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">10</span>
          <span>Contact Information</span>
        </h2>
        <p>
          If you have any questions, privacy inquiries, data subject requests, or security concerns regarding this Privacy Policy or Nanvi AI
          Enterprise Assistant, please reach out to our designated Data Protection team:
        </p>
        <div className="legal-callout legal-callout-info">
          <p>
            <strong>Data Protection &amp; Privacy Office:</strong><br />
            Email: <span className="legal-placeholder-tag">[Insert Official Privacy &amp; Data Protection Contact Email, e.g., privacy@nanvi.ai]</span><br />
            Support: <span className="legal-placeholder-tag">[Insert Support Contact Email, e.g., support@nanvi.ai]</span><br />
            Legal Entity: <span className="legal-placeholder-tag">[Insert Company Legal Entity Name]</span><br />
            Registered Address: <span className="legal-placeholder-tag">[Insert Registered Business Address, City, State, Country]</span>
          </p>
        </div>
        <p style={{ marginTop: "1rem" }}>
          For terms governing the use of the platform, please review our{" "}
          <a
            href="/terms"
            onClick={(e) => {
              e.preventDefault();
              onNavigateToTerms();
            }}
          >
            Terms of Service
          </a>
          .
        </p>
      </section>

      {/* ── 11. Age Restriction & Enterprise Use ──────────────── */}
      <section id="age-restriction" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">11</span>
          <span>Age Restriction &amp; Enterprise Use</span>
        </h2>
        <p>
          The Service is intended solely for enterprise environments, professional organizations, and authorized corporate
          users. Nanvi AI Enterprise Assistant is not directed at, and does not knowingly collect personal information
          from, individuals under the age of 16 (or under the age of 18 where required by applicable law).
        </p>
        <p>
          If we become aware that we have collected personal information from a user under the applicable age limit
          without proper authorization, we will take steps to delete that information promptly. By using the Service, you
          represent that you are at least the required age and that you are authorized by your organization to access
          the Service.
        </p>
      </section>

      {/* ── 12. Security Incidents & Breach Notification ──────── */}
      <section id="security-incidents" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">12</span>
          <span>Security Incidents &amp; Breach Notification</span>
        </h2>
        <p>
          We maintain technical and organizational measures designed to protect your information. In the event of a
          confirmed security incident that affects your personal or organizational data, we will notify affected customers
          and, where required by applicable law, relevant supervisory authorities, without undue delay and in accordance
          with the timelines prescribed by those laws.
        </p>
        <p>
          Notifications will include, to the extent known and permitted, a description of the nature of the incident,
          the categories of data involved, and the measures we are taking to address the incident.
        </p>
      </section>

      {/* ── 13. Changes to This Privacy Policy ────────────────── */}
      <section id="policy-changes" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">13</span>
          <span>Changes to This Privacy Policy</span>
        </h2>
        <p>
          We may update this Privacy Policy from time to time to reflect changes in our practices, legal requirements, or
          the Service.
        </p>
        <p>
          The &ldquo;Last Updated&rdquo; date at the top of this policy indicates when the most recent changes were made.
          Material changes will be communicated to enterprise customers via email to the account administrator, an in-app
          notice, or both. Your continued use of the Service after the effective date of an updated policy constitutes
          your acknowledgment of the changes.
        </p>
        <p>We encourage you to review this Privacy Policy periodically.</p>
      </section>
    </LegalLayout>
  );
}

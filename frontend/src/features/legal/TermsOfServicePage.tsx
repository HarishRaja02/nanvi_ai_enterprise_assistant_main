import React, { useEffect } from "react";
import { LegalLayout } from "./LegalLayout";
import { AlertCircle, Scale, CheckCircle2, ShieldAlert, Cpu, Building } from "lucide-react";

interface TermsOfServicePageProps {
  onNavigateToPrivacy: () => void;
  onBack: () => void;
}

const TOC = [
  { id: "acceptance", label: "1. Acceptance of Terms" },
  { id: "description", label: "2. Description of the Service" },
  { id: "account-responsibilities", label: "3. Account Security & Responsibilities" },
  { id: "acceptable-use", label: "4. Acceptable Use Policy" },
  { id: "ai-limitations", label: "5. AI Outputs & Verification Responsibility" },
  { id: "third-party-integrations", label: "6. Third-Party Integrations & Services" },
  { id: "intellectual-property", label: "7. Intellectual Property & Ownership" },
  { id: "service-availability", label: "8. Availability, Maintenance & Disclaimers" },
  { id: "suspension-termination", label: "9. Suspension & Termination" },
  { id: "limitation-liability", label: "10. Limitation of Liability" },
  { id: "changes-terms", label: "11. Modifications to Terms" },
  { id: "contact-terms", label: "12. Contact & Legal Notices" },
];

export function TermsOfServicePage({ onNavigateToPrivacy, onBack }: TermsOfServicePageProps) {
  useEffect(() => {
    document.title = "Terms of Service — Nanvi AI Enterprise Assistant";
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
      activePage="terms"
      title="Terms of Service"
      description="The legally binding terms and enterprise use guidelines governing your access to the Nanvi AI Enterprise Assistant web portal and Windows desktop application."
      badge="Enterprise Agreement & Terms"
      lastUpdated="November 17, 2026"
      tableOfContents={TOC}
      onNavigateToPrivacy={onNavigateToPrivacy}
      onNavigateToTerms={() => { }}
      onBack={onBack}
    >
      {/* ── 1. Acceptance of Terms ────────────────────────────── */}
      <section id="acceptance" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">01</span>
          <span>Acceptance of Terms</span>
        </h2>
        <p>
          These Terms of Service (&ldquo;Terms&rdquo;) constitute a legally binding agreement between you (whether individually
          or on behalf of an enterprise entity, &ldquo;User&rdquo;, &ldquo;you&rdquo;, or &ldquo;your&rdquo;) and{" "}
          <span className="legal-placeholder-tag">[Insert Legal Entity Name, e.g., Nanvi AI Technologies Private Limited]</span>{" "}
          (&ldquo;Nanvi&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;, or &ldquo;our&rdquo;), governing your installation, access,
          and use of the <strong>Nanvi AI Enterprise Assistant</strong> software, web application
          (<code>https://nanviaienterpriseassistant.vercel.app</code>), Windows desktop application (MSIX / NSIS), APIs,
          and related documentation (collectively, the &ldquo;Service&rdquo;).
        </p>
        <p>
          By creating an account, signing in, installing the desktop application, or using the Service, you represent that you have read,
          understood, and agree to be bound by these Terms and our{" "}
          <a
            href="/privacy"
            onClick={(e) => {
              e.preventDefault();
              onNavigateToPrivacy();
            }}
          >
            Privacy Policy
          </a>
          . If you do not agree, you must not access or use the Service.
        </p>
      </section>

      {/* ── 2. Description of the Service ─────────────────────── */}
      <section id="description" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">02</span>
          <span>Description of the Service</span>
        </h2>
        <p>
          Nanvi AI Enterprise Assistant is an enterprise-grade cognitive assistant designed to streamline internal organizational
          workflows, information discovery, and communications. Core capabilities include:
        </p>
        <ul>
          <li><strong>Document &amp; File Intelligence:</strong> Semantic search, metadata filtering, and text extraction across local on-device folders and connected cloud repositories.</li>
          <li><strong>Mailbox &amp; Thread Search:</strong> Secure integration with enterprise mailboxes (Google Workspace Gmail, Microsoft 365 Outlook, Yahoo Mail) for reading and briefing unread or recent messages.</li>
          <li><strong>Zero-Trust Email Composition:</strong> Generating communication drafts with mandatory human-in-the-loop confirmation before dispatch.</li>
          <li><strong>Enterprise Data Retrieval:</strong> Querying connected enterprise databases and structured data catalogs with strict Role-Based Access Controls (RBAC).</li>
        </ul>
      </section>

      {/* ── 3. Account Security & Responsibilities ─────────────── */}
      <section id="account-responsibilities" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">03</span>
          <span>Account Security &amp; User Responsibilities</span>
        </h2>
        <p>
          You are responsible for maintaining the confidentiality of your login credentials and for all activities that occur under your account:
        </p>
        <ul>
          <li><strong>Authorized Credentials:</strong> You agree to provide accurate, current, and complete corporate identity information during authentication.</li>
          <li><strong>No Credential Sharing:</strong> Enterprise accounts are assigned to specific individuals or designated service actors. Sharing login credentials across multiple individuals is prohibited.</li>
          <li><strong>Notification of Breach:</strong> You must immediately notify your enterprise administrator and Nanvi Support upon discovering any unauthorized access, security incident, or credential compromise.</li>
          <li><strong>Role Compliance:</strong> You must strictly respect organizational access tiers (e.g. Employee, Project Engineer, Supervisor, Superior, Administrator) and not attempt to bypass access boundaries.</li>
        </ul>
      </section>

      {/* ── 4. Acceptable Use Policy ──────────────────────────── */}
      <section id="acceptable-use" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">04</span>
          <span>Acceptable Use Policy</span>
        </h2>
        <p>You agree not to use the Service, nor permit any third party to use the Service, for any prohibited purpose, including:</p>
        <ul>
          <li><strong>Security Circumvention:</strong> Probing, scanning, or testing vulnerabilities of the Service, or attempting to defeat authentication or authorization mechanisms (Zero-Trust RBAC boundaries).</li>
          <li><strong>Reverse Engineering:</strong> Decompiling, reverse engineering, disassembling, or deriving source code of the backend, desktop client, or proprietary algorithms, except where permitted by mandatory applicable law.</li>
          <li><strong>Malicious Code:</strong> Uploading or transmitting viruses, worms, malware, trojan horses, or destructive payloads through document upload or sync channels.</li>
          <li><strong>Unauthorized Exfiltration:</strong> Scraping, harvesting, or extracting organizational data from repositories or mailboxes without proper corporate authorization.</li>
          <li><strong>Violation of Third-Party Terms:</strong> Accessing connected third-party APIs (such as Google API Services or Microsoft Graph) in violation of their applicable developer terms, quotas, or acceptable use policies.</li>
        </ul>
      </section>

      {/* ── 5. AI Outputs & Verification Responsibility ───────── */}
      <section id="ai-limitations" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">05</span>
          <span>AI Outputs &amp; Verification Responsibility</span>
        </h2>
        <div className="legal-callout legal-callout-warning">
          <div className="legal-callout-title">
            <AlertCircle size={16} aria-hidden="true" />
            <span>Important Notice Regarding AI-Generated Content</span>
          </div>
          <p>
            Nanvi AI Enterprise Assistant utilizes probabilistic artificial intelligence and large language models (LLMs) to synthesize
            information and draft communications. While designed for high accuracy and grounded in cited source materials,
            <strong> AI outputs may occasionally contain errors, omissions, or inaccuracies (&ldquo;hallucinations&rdquo;)</strong>.
          </p>
        </div>
        <p>
          By using the Service, you acknowledge and agree that:
        </p>
        <ul>
          <li>
            <strong>Human Verification Required:</strong> You are solely responsible for independently reading, reviewing, and verifying the accuracy,
            legality, and completeness of all AI-generated answers, calculations, financial figures, summaries, and email drafts before acting
            upon them or sending them to external recipients.
          </li>
          <li>
            <strong>Not Professional Advice:</strong> Nanvi AI Enterprise Assistant does not provide legal, financial, accounting, medical, or
            regulated professional advice. Outputs should not be substituted for qualified professional review.
          </li>
          <li>
            <strong>Zero-Trust Confirmation:</strong> The Service provides confirmation controls before sensitive actions (e.g. sending emails or executing
            database changes). You retain full accountability for confirming any operational action triggered through the assistant interface.
          </li>
        </ul>
      </section>

      {/* ── 6. Third-Party Integrations & Services ────────────── */}
      <section id="third-party-integrations" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">06</span>
          <span>Third-Party Integrations &amp; External Services</span>
        </h2>
        <p>
          The Service facilitates optional integrations with external platforms, including Google Workspace, Microsoft 365, Yahoo Mail,
          cloud databases, and enterprise AI inference endpoints (such as Groq Cloud API):
        </p>
        <ul>
          <li>
            <strong>Independent Service Terms:</strong> Your use of third-party platforms is governed by their respective terms of service and
            privacy policies. Nanvi does not control and is not liable for third-party service interruptions, policy changes, or account suspensions.
          </li>
          <li>
            <strong>Google API Limited Use Adherence:</strong> Our use of Google Workspace and Gmail data adheres strictly to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , ensuring that Google data is not used for generalized AI training or advertising.
          </li>
          <li>
            <strong>Revocation:</strong> You may disconnect external integrations at any time via <strong>Settings → Connections Hub</strong>.
          </li>
        </ul>
      </section>

      {/* ── 7. Intellectual Property & Ownership ──────────────── */}
      <section id="intellectual-property" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">07</span>
          <span>Intellectual Property &amp; Ownership</span>
        </h2>
        <p>
          <strong>Nanvi Intellectual Property:</strong> All right, title, and interest in and to the Service, including the user interface design,
          logos, trademarks, codebase, algorithms, documentation, and enhancements, remain the exclusive property of Nanvi AI and its licensors.
        </p>
        <p>
          <strong>User &amp; Enterprise Content:</strong> You or your enterprise organization retain all existing rights, ownership, and intellectual
          property in your uploaded documents, files, emails, queries, and business data (&ldquo;Customer Data&rdquo;). Nothing in these Terms grants
          Nanvi any ownership rights in your Customer Data.
        </p>
      </section>

      {/* ── 8. Availability, Maintenance & Disclaimers ────────── */}
      <section id="service-availability" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">08</span>
          <span>Availability, Maintenance &amp; Disclaimers</span>
        </h2>
        <p>
          EXCEPT AS EXPRESSLY SET FORTH IN A SEPARATE EXECUTED MASTER SERVICES AGREEMENT (MSA) WITH NANVI, THE SERVICE IS PROVIDED ON AN
          <strong> &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; BASIS</strong>, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
          INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.
        </p>
        <p>
          We do not guarantee that the Service will operate uninterrupted, error-free, or entirely without delay. We may occasionally perform scheduled
          maintenance or emergency patches to safeguard platform security and reliability.
        </p>
      </section>

      {/* ── 9. Suspension & Termination ───────────────────────── */}
      <section id="suspension-termination" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">09</span>
          <span>Suspension &amp; Termination</span>
        </h2>
        <p>
          We reserve the right to temporarily suspend or terminate your access to the Service immediately if:
        </p>
        <ul>
          <li>You materially breach these Terms or the Acceptable Use Policy;</li>
          <li>Your account demonstrates activity that poses an immediate security threat to the platform, infrastructure, or other users;</li>
          <li>Your organization&rsquo;s enterprise subscription or licensing agreement expires or terminates; or</li>
          <li>We are required to do so by court order or applicable law.</li>
        </ul>
        <p>Upon termination, your right to access and use the Service immediately ceases.</p>
      </section>

      {/* ── 10. Limitation of Liability ───────────────────────── */}
      <section id="limitation-liability" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">10</span>
          <span>Limitation of Liability</span>
        </h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL NANVI, ITS DIRECTORS, EMPLOYEES, AGENTS, OR LICENSORS BE LIABLE FOR
          ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, DATA, USE, GOODWILL,
          BUSINESS INTERRUPTION, OR OTHER INTANGIBLE LOSSES, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OR INABILITY TO USE THE SERVICE OR AI OUTPUTS.
        </p>
        <p>
          TO THE EXTENT PERMITTED BY LAW, OUR TOTAL CUMULATIVE LIABILITY FOR ALL CLAIMS ARISING UNDER OR RELATING TO THESE TERMS SHALL NOT EXCEED
          THE AMOUNT PAID BY YOU (OR YOUR ENTERPRISE SPONSOR) TO NANVI FOR THE SERVICE IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM.
        </p>
      </section>

      {/* ── 11. Modifications to Terms ────────────────────────── */}
      <section id="changes-terms" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">11</span>
          <span>Modifications to Terms</span>
        </h2>
        <p>
          We may update or modify these Terms from time to time to reflect operational, legal, or regulatory enhancements. When revisions are made,
          we will update the &ldquo;Last Revised&rdquo; date at the top of this document. Continued use of the Service after effective revisions
          indicates your acknowledgment and acceptance of the updated Terms.
        </p>
      </section>

      {/* ── 12. Contact & Legal Notices ───────────────────────── */}
      <section id="contact-terms" className="legal-section">
        <h2 className="legal-section-title">
          <span className="legal-section-number">12</span>
          <span>Contact &amp; Legal Notices</span>
        </h2>
        <p>
          For legal questions, notices, enterprise licensing inquiries, or contract correspondence regarding these Terms, please contact:
        </p>
        <div className="legal-callout legal-callout-info">
          <p>
            <strong>Legal Department &amp; Corporate Notices:</strong><br />
            Email: <span className="legal-placeholder-tag">[Insert Official Legal &amp; Support Contact Email, e.g., legal@nanvi.ai]</span><br />
            Support: <span className="legal-placeholder-tag">[Insert Support Contact Email, e.g., support@nanvi.ai]</span><br />
            Company: <span className="legal-placeholder-tag">[Insert Company Legal Entity Name]</span><br />
            Address: <span className="legal-placeholder-tag">[Insert Registered Business Address, City, State, Country]</span><br />
            Governing Law: <span className="legal-placeholder-tag">[Insert Governing Jurisdiction, e.g., Laws of Delaware, USA / India]</span>
          </p>
        </div>
      </section>
    </LegalLayout>
  );
}

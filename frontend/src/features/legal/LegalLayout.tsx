import React from "react";
import { ArrowLeft, Shield, FileText, CheckCircle2, Calendar, Building2 } from "lucide-react";
import { LOGO_URL } from "../../lib/config";

interface TocItem {
  id: string;
  label: string;
}

interface LegalLayoutProps {
  activePage: "privacy" | "terms";
  title: string;
  description: string;
  badge: string;
  lastUpdated: string;
  tableOfContents: TocItem[];
  onNavigateToPrivacy: () => void;
  onNavigateToTerms: () => void;
  onBack: () => void;
  children: React.ReactNode;
}

export function LegalLayout({
  activePage,
  title,
  description,
  badge,
  lastUpdated,
  tableOfContents,
  onNavigateToPrivacy,
  onNavigateToTerms,
  onBack,
  children,
}: LegalLayoutProps) {
  const currentYear = new Date().getFullYear();

  const handleBack = React.useCallback(() => {
    if (onBack) {
      onBack();
    } else if (typeof window !== "undefined") {
      if (window.history && window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = "/";
      }
    }
  }, [onBack]);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleBack();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleBack]);

  return (
    <div className="legal-root">
      {/* ── Sticky Top Header ───────────────────────────────────── */}
      <header className="legal-header">
        <div className="legal-header-inner">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              handleBack();
            }}
            className="legal-brand"
            title="Return to Nanvi AI Assistant"
          >
            <img src={LOGO_URL} alt="Nanvi Logo" className="legal-brand-logo" />
            <span className="legal-brand-name">Nanvi AI Enterprise Assistant</span>
          </a>

          {/* Navigation Pill Tabs */}
          <div className="legal-nav-tabs" role="tablist">
            <a
              href="/privacy"
              role="tab"
              aria-selected={activePage === "privacy"}
              className={`legal-tab-btn ${activePage === "privacy" ? "is-active" : ""}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigateToPrivacy();
              }}
            >
              <Shield size={14} aria-hidden="true" />
              <span>Privacy Policy</span>
            </a>
            <a
              href="/terms"
              role="tab"
              aria-selected={activePage === "terms"}
              className={`legal-tab-btn ${activePage === "terms" ? "is-active" : ""}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigateToTerms();
              }}
            >
              <FileText size={14} aria-hidden="true" />
              <span>Terms of Service</span>
            </a>
          </div>

          <button
            type="button"
            className="legal-back-btn"
            onClick={handleBack}
            title="Return to Main Application"
            aria-label="Back to Assistant"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>Back to Assistant</span>
          </button>
        </div>
      </header>

      {/* ── Hero Banner ─────────────────────────────────────────── */}
      <section className="legal-hero">
        <div className="legal-hero-inner">
          <div className="legal-hero-breadcrumb">
            <button
              type="button"
              className="legal-hero-back-btn"
              onClick={handleBack}
              aria-label="Return to application"
            >
              <ArrowLeft size={13} aria-hidden="true" />
              <span>Return to Application</span>
            </button>
            <span className="legal-breadcrumb-sep">/</span>
            <span className="legal-breadcrumb-current">{title}</span>
          </div>

          <div className="legal-badge">
            <CheckCircle2 size={13} aria-hidden="true" />
            <span>{badge}</span>
          </div>
          <h1 className="legal-hero-title">{title}</h1>
          <p className="legal-hero-desc">{description}</p>
          <div className="legal-meta">
            <div className="legal-meta-item">
              <Calendar size={13} aria-hidden="true" />
              <span>Last Revised: {lastUpdated}</span>
            </div>
            <div className="legal-meta-item">
              <Building2 size={13} aria-hidden="true" />
              <span>Nanvi Enterprise Trust Center</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Document Body (TOC + Content) ───────────────────────── */}
      <div className="legal-body">
        {/* Table of Contents Column */}
        <aside className="legal-toc-wrapper" aria-label="Table of Contents">
          <h2 className="legal-toc-title">
            <FileText size={14} aria-hidden="true" />
            <span>Contents</span>
          </h2>
          <nav>
            <ul className="legal-toc-list">
              {tableOfContents.map((item) => (
                <li key={item.id}>
                  <a href={`#${item.id}`} className="legal-toc-link">
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        {/* Content Column */}
        <main className="legal-content" id="legal-main">
          {children}

          {/* Bottom Return Callout Banner */}
          <div className="legal-bottom-return-card">
            <div className="legal-bottom-return-text">
              <h3>Finished reviewing the {title}?</h3>
              <p>Return to Nanvi AI Assistant to resume your workspace, documents, and chat sessions.</p>
            </div>
            <button
              type="button"
              className="legal-return-cta-btn"
              onClick={handleBack}
              aria-label="Return to workspace overview"
            >
              <ArrowLeft size={16} aria-hidden="true" />
              <span>Return to Nanvi AI</span>
            </button>
          </div>
        </main>
      </div>

      {/* ── Floating Quick Return Pill ──────────────────────────── */}
      <button
        type="button"
        className="legal-floating-back-btn"
        onClick={handleBack}
        title="Quick Return to Main Application"
        aria-label="Quick Return to Main Application"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        <span>Return to App</span>
      </button>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer className="legal-footer" role="contentinfo">
        <div className="legal-footer-inner">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <img src={LOGO_URL} alt="Nanvi Logo" style={{ height: "20px", width: "auto" }} />
            <span>© {currentYear} Nanvi AI. All rights reserved.</span>
          </div>

          <div className="legal-footer-links">
            <a
              href="/privacy"
              className="legal-footer-link"
              onClick={(e) => {
                e.preventDefault();
                onNavigateToPrivacy();
              }}
            >
              Privacy Policy
            </a>
            <span>•</span>
            <a
              href="/terms"
              className="legal-footer-link"
              onClick={(e) => {
                e.preventDefault();
                onNavigateToTerms();
              }}
            >
              Terms of Service
            </a>
            <span>•</span>
            <a
              href="https://apps.microsoft.com/detail/9p8x2l43rwtm"
              target="_blank"
              rel="noopener noreferrer"
              className="legal-footer-link"
            >
              Microsoft Store
            </a>
            <span>•</span>
            <button
              type="button"
              onClick={handleBack}
              style={{
                background: "none",
                border: "none",
                color: "var(--brand-teal)",
                cursor: "pointer",
                padding: 0,
                fontSize: "inherit",
                textDecoration: "underline",
                fontWeight: 600,
              }}
            >
              Return to Assistant
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}


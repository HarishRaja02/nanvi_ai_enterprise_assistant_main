import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PrivacyPolicyPage } from "./PrivacyPolicyPage";
import { TermsOfServicePage } from "./TermsOfServicePage";

describe("PrivacyPolicyPage", () => {
  it("renders the Privacy Policy title, sections, and Google Limited Use disclosure", () => {
    const onNavigateToTerms = vi.fn();
    const onBack = vi.fn();

    render(
      <PrivacyPolicyPage
        onNavigateToTerms={onNavigateToTerms}
        onBack={onBack}
      />
    );

    // Hero title & badge
    expect(screen.getByRole("heading", { level: 1, name: /Privacy Policy/i })).toBeInTheDocument();
    expect(screen.getByText(/Enterprise Data Privacy & Security/i)).toBeInTheDocument();

    // Table of contents
    expect(screen.getByRole("complementary", { name: /Table of Contents/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Google API User Data & Limited Use/i })).toBeInTheDocument();

    // Google API & Limited Use disclosure
    expect(screen.getByText(/Google API Services User Data Policy — Limited Use Disclosure/i)).toBeInTheDocument();
    expect(screen.getByText(/NEVER used to train, retrain, or fine-tune/i)).toBeInTheDocument();
    expect(screen.getByText(/NEVER used or transferred for serving advertisements/i)).toBeInTheDocument();
    expect(screen.getByText(/NEVER sold, leased, or rented/i)).toBeInTheDocument();

    // Document & Local File Processing
    expect(screen.getByText(/On-Device & In-Memory Privacy in Desktop & Web/i)).toBeInTheDocument();

    // Contact placeholders
    expect(screen.getByText(/\[Insert Official Privacy & Data Protection Contact Email/i)).toBeInTheDocument();
  });

  it("calls navigation callbacks when tab or back buttons are clicked", async () => {
    const user = userEvent.setup();
    const onNavigateToTerms = vi.fn();
    const onBack = vi.fn();

    render(
      <PrivacyPolicyPage
        onNavigateToTerms={onNavigateToTerms}
        onBack={onBack}
      />
    );

    // Switch to Terms of Service
    const termsTab = screen.getByRole("tab", { name: /Terms of Service/i });
    await user.click(termsTab);
    expect(onNavigateToTerms).toHaveBeenCalledOnce();

    // Back to assistant
    const backBtn = screen.getByRole("button", { name: /Back to Assistant/i });
    await user.click(backBtn);
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("TermsOfServicePage", () => {
  it("renders the Terms of Service title, AI output limitations, and acceptable use", () => {
    const onNavigateToPrivacy = vi.fn();
    const onBack = vi.fn();

    render(
      <TermsOfServicePage
        onNavigateToPrivacy={onNavigateToPrivacy}
        onBack={onBack}
      />
    );

    // Hero title & badge
    expect(screen.getByRole("heading", { level: 1, name: /Terms of Service/i })).toBeInTheDocument();
    expect(screen.getByText(/Enterprise Agreement & Terms/i)).toBeInTheDocument();

    // Table of contents
    expect(screen.getByRole("complementary", { name: /Table of Contents/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /AI Outputs & Verification Responsibility/i })).toBeInTheDocument();

    // AI limitations warning
    expect(screen.getByText(/Important Notice Regarding AI-Generated Content/i)).toBeInTheDocument();
    expect(screen.getByText(/Human Verification Required/i)).toBeInTheDocument();

    // Acceptable use
    expect(screen.getByText(/Security Circumvention:/i)).toBeInTheDocument();
    expect(screen.getByText(/Reverse Engineering:/i)).toBeInTheDocument();

    // Contact placeholders
    expect(screen.getByText(/\[Insert Official Legal & Support Contact Email/i)).toBeInTheDocument();
  });

  it("calls navigation callbacks when tab or back buttons are clicked", async () => {
    const user = userEvent.setup();
    const onNavigateToPrivacy = vi.fn();
    const onBack = vi.fn();

    render(
      <TermsOfServicePage
        onNavigateToPrivacy={onNavigateToPrivacy}
        onBack={onBack}
      />
    );

    // Switch to Privacy Policy
    const privacyTab = screen.getByRole("tab", { name: /Privacy Policy/i });
    await user.click(privacyTab);
    expect(onNavigateToPrivacy).toHaveBeenCalledOnce();

    // Back to assistant
    const backBtn = screen.getByRole("button", { name: /Back to Assistant/i });
    await user.click(backBtn);
    expect(onBack).toHaveBeenCalledOnce();
  });
});


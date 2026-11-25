import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NanviApiClient, ProviderPublic } from "../../api";
import { ConnectionsHub } from "./ConnectionsHub";

const provider = (overrides: Partial<ProviderPublic>): ProviderPublic => ({
  id: "ready-provider",
  name: "Ready Provider",
  categories: ["Cloud"],
  icon: "plug",
  description: "A configured provider.",
  auth_type: "api_key",
  capabilities: [],
  available: true,
  available_reason: "available",
  configuration_schema: {},
  ...overrides,
});

describe("ConnectionsHub provider catalog", () => {
  it("hides coming-soon cards without hiding available providers", async () => {
    const api = {
      listProviders: vi.fn().mockResolvedValue({
        providers: [
          provider({ id: "google-drive", name: "Google Drive" }),
          provider({ id: "datadog", name: "Datadog", available: false, available_reason: "coming_soon" }),
        ],
      }),
      listConnectionCategories: vi.fn().mockResolvedValue(["Cloud"]),
      listConnections: vi.fn().mockResolvedValue({ connections: [] }),
    } as unknown as NanviApiClient;

    render(<ConnectionsHub api={api} canManageOrg={false} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Integrations Catalog (1)" })).toBeInTheDocument());
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
    expect(screen.queryByText("Datadog")).not.toBeInTheDocument();
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });

  it("hides Box and Egnyte from the Connection Hub UI", async () => {
    const api = {
      listProviders: vi.fn().mockResolvedValue({
        providers: [
          provider({ id: "dropbox", name: "Dropbox" }),
          provider({ id: "box", name: "Box" }),
          provider({ id: "egnyte", name: "Egnyte" }),
        ],
      }),
      listConnectionCategories: vi.fn().mockResolvedValue(["Cloud"]),
      listConnections: vi.fn().mockResolvedValue({
        connections: [
          {
            id: "conn-box-1",
            provider: "box",
            display_name: "Box Enterprise",
            status: "active",
            created_at: "2026-11-01T00:00:00Z",
          },
          {
            id: "conn-egnyte-1",
            provider: "egnyte",
            display_name: "Egnyte Storage",
            status: "active",
            created_at: "2026-11-01T00:00:00Z",
          },
        ],
      }),
    } as unknown as NanviApiClient;

    render(<ConnectionsHub api={api} canManageOrg={false} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Integrations Catalog (1)" })).toBeInTheDocument());
    expect(screen.getByText("Dropbox")).toBeInTheDocument();
    expect(screen.queryByText("Box")).not.toBeInTheDocument();
    expect(screen.queryByText("Box Enterprise")).not.toBeInTheDocument();
    expect(screen.queryByText("Egnyte")).not.toBeInTheDocument();
    expect(screen.queryByText("Egnyte Storage")).not.toBeInTheDocument();
  });

  it("renders OAuth button for OAuth2 Dropbox and opens Setup Guide when unconfigured", async () => {
    const listConnections = vi.fn().mockResolvedValue({ connections: [] });
    const api = {
      listProviders: vi.fn().mockResolvedValue({
        providers: [
          provider({
            id: "dropbox",
            name: "Dropbox Business",
            auth_type: "oauth2",
            available: false,
            available_reason: "not_configured",
          }),
        ],
      }),
      listConnectionCategories: vi.fn().mockResolvedValue(["Cloud Storage"]),
      listConnections,
    } as unknown as NanviApiClient;

    render(<ConnectionsHub api={api} canManageOrg={false} />);

    const setupBtn = await screen.findByRole("button", { name: "Setup Guide" });
    fireEvent.click(setupBtn);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Connect Dropbox Business with OAuth/i })).toBeInTheDocument()
    );
    expect(screen.getByText(/DROPBOX_CLIENT_ID & DROPBOX_CLIENT_SECRET/i)).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent("nanvi:connections-updated", { detail: { provider: "dropbox" } }));
    });
    await waitFor(() => expect(listConnections).toHaveBeenCalledTimes(2));
  });
});
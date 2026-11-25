import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { ROTATING_STARTERS } from "../../lib/prompts";
import type { Message } from "../../types";

const baseProps = {
  busy: false,
  resumed: null,
  starters: ROTATING_STARTERS.slice(0, 4),
  focusToken: 0,
  ragEnabled: true,
  onToggleRag: vi.fn(),
  onSend: vi.fn().mockResolvedValue(true),
  onRetry: vi.fn(),
  onOpenSource: vi.fn(),
  onDownload: vi.fn(),
  onNewConversation: vi.fn(),
};

describe("ChatView", () => {
  it("centers the greeting and search bar together when empty without suggestion section", () => {
    const { container } = render(<ChatView {...baseProps} messages={[]} />);

    const emptyRoot = container.querySelector(".empty-workspace-view");
    expect(emptyRoot).toBeInTheDocument();
    expect(within(emptyRoot as HTMLElement).getByRole("heading", { name: "How can I help you today?" })).toBeInTheDocument();
    expect(within(emptyRoot as HTMLElement).getByRole("textbox", { name: "Ask Nanvi" })).toBeInTheDocument();
    expect(within(emptyRoot as HTMLElement).queryByRole("region", { name: "Suggested questions" })).not.toBeInTheDocument();
    expect(container.querySelector(".floating-composer-dock")).not.toBeInTheDocument();
  });

  it("moves the search bar to the bottom dock once messages exist", () => {
    const messages: Message[] = [
      { id: "m1", role: "user", text: "Show overdue invoices", createdAt: Date.now() },
    ];
    const { container } = render(<ChatView {...baseProps} messages={messages} />);

    expect(container.querySelector(".empty-workspace-view")).not.toBeInTheDocument();
    const dock = container.querySelector(".floating-composer-dock");
    expect(dock).toBeInTheDocument();
    expect(within(dock as HTMLElement).getByRole("textbox", { name: "Ask Nanvi" })).toBeInTheDocument();
    expect(screen.getByText("Show overdue invoices")).toBeInTheDocument();
  });
});


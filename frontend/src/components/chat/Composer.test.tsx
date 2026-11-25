import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("sends the entered question with the selected search setting and preserves Voice entry", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockResolvedValue(true);
    const onToggleRag = vi.fn();
    const onOpenVoiceMode = vi.fn();
    const { rerender } = render(
      <Composer
        busy={false}
        onSend={onSend}
        focusToken={0}
        ragEnabled
        onToggleRag={onToggleRag}
        onOpenVoiceMode={onOpenVoiceMode}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Company file search: On" }));
    expect(onToggleRag).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Open Voice Assistant Mode" }));
    expect(onOpenVoiceMode).toHaveBeenCalledOnce();

    rerender(
      <Composer
        busy={false}
        onSend={onSend}
        focusToken={0}
        ragEnabled={false}
        onToggleRag={onToggleRag}
        onOpenVoiceMode={onOpenVoiceMode}
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "Ask Nanvi" }), "Find the current travel policy");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith("Find the current travel policy", false, undefined);
  });

  it("shows Attach File and waveform voice control when idle, then switches to Send when typing", async () => {
    const user = userEvent.setup();
    const onOpenVoiceMode = vi.fn();
    render(
      <Composer
        busy={false}
        onSend={async () => true}
        focusToken={0}
        ragEnabled
        onOpenVoiceMode={onOpenVoiceMode}
      />,
    );

    expect(screen.getByRole("button", { name: "Attach File" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();

    const waveBtn = screen.getByRole("button", { name: "Start voice conversation" });
    await user.click(waveBtn);
    expect(onOpenVoiceMode).toHaveBeenCalledOnce();

    await user.type(screen.getByRole("textbox", { name: "Ask Nanvi" }), "Hello");
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("accepts image attachments in the file upload input for OCR ingestion", () => {
    render(
      <Composer
        busy={false}
        onSend={async () => true}
        focusToken={0}
        ragEnabled
      />,
    );
    const fileInput = screen.getByLabelText("Upload document to RAG") as HTMLInputElement;
    expect(fileInput.accept).toContain(".png");
    expect(fileInput.accept).toContain(".jpg");
    expect(fileInput.accept).toContain(".pdf");
  });
});
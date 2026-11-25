import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import type { NanviApiClient } from "../../api";

describe("Composer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as any).electronAPI;
  });
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

  it("prompts user to activate microphone and opens mic settings when OS mic access is denied", async () => {
    const user = userEvent.setup();
    const openMicSettings = vi.fn().mockResolvedValue(true);
    const getMicAccessStatus = vi.fn().mockResolvedValue({ status: "denied", platform: "win32" });
    (window as any).electronAPI = {
      isDesktop: true,
      platform: "win32",
      getMicAccessStatus,
      openMicSettings,
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });

    const onSend = vi.fn().mockResolvedValue(true);
    render(
      <Composer
        busy={false}
        onSend={onSend}
        focusToken={0}
        ragEnabled
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open Voice Assistant Mode" }));
    expect(await screen.findByText(/activate microphone access/i)).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Open Mic Settings" }));
    expect(openMicSettings).toHaveBeenCalledOnce();
  });

  it("blocks Whisper hallucination 'Thank you for watching!' instead of auto-sending into chat", async () => {
    const user = userEvent.setup();
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: stopTrack, enabled: true }],
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    class FakeMediaRecorder {
      static isTypeSupported() { return true; }
      mimeType = "audio/webm";
      state = "inactive";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      requestData() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(1500)], { type: "audio/webm" }) });
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const onSend = vi.fn().mockResolvedValue(true);
    const fakeApi = {
      voiceTranscribe: vi.fn().mockResolvedValue({
        text: "Thank you for watching!",
        confidence: 0,
        no_speech: false,
      }),
    } as unknown as NanviApiClient;

    render(
      <Composer
        busy={false}
        onSend={onSend}
        focusToken={0}
        ragEnabled
        api={fakeApi}
      />,
    );

    // Start listening
    await user.click(screen.getByRole("button", { name: "Open Voice Assistant Mode" }));
    expect(await screen.findByText("Listening...")).toBeInTheDocument();

    // Stop listening and trigger Whisper fallback
    await user.click(screen.getByRole("button", { name: "Open Voice Assistant Mode" }));
    expect(await screen.findByText(/Could not detect clear speech/i)).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });
});
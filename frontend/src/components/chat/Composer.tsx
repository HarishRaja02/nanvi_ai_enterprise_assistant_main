import { FormEvent, KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, AudioLines, ChevronDown, FileText, Loader2, Mic, Plus, Sparkles, X } from "lucide-react";
import type { NanviApiClient } from "../../api";

const MAX_LENGTH = 4000;
const WARN_AT = 3600;
const MAX_HEIGHT = 180;

type Props = {
  busy: boolean;
  onSend: (text: string, rag?: boolean, activeDocumentId?: string) => Promise<boolean>;
  focusToken: number;
  ragEnabled?: boolean;
  onToggleRag?: (enabled: boolean) => void;
  api?: NanviApiClient;
  onOpenVoiceMode?: () => void;
};

export function Composer({
  busy,
  onSend,
  focusToken,
  ragEnabled = true,
  onToggleRag,
  api,
  onOpenVoiceMode,
}: Props) {
  const [value, setValue] = useState("");
  const [attachedFile, setAttachedFile] = useState<{ name: string; size: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Hands-free Voice Input & Query Refinement State
  const [isListening, setIsListening] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [isMultiline, setIsMultiline] = useState(false);
  const [clarification, setClarification] = useState<{
    message: string;
    suggestions: string[];
  } | null>(null);

  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<any>(null);
  const accumulatedTranscriptRef = useRef<string>("");
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const speechDetectedRef = useRef<boolean>(false);
  const lastSpokenTimeRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);

  const stopAudioCapture = async (): Promise<Blob | null> => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        void audioContextRef.current.close();
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }
    const rec = mediaRecorderRef.current;
    if (rec && rec.state === "recording") {
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        try {
          rec.requestData();
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            if (rec.state === "recording") rec.stop();
          } catch {
            // ignore
          }
          resolve();
        }, 100);
      });
    }
    mediaRecorderRef.current = null;
    if (mediaStreamRef.current) {
      try {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      } catch {
        // ignore
      }
      mediaStreamRef.current = null;
    }
    if (audioChunksRef.current.length > 0) {
      const mime = rec?.mimeType || "audio/webm";
      const blob = new Blob(audioChunksRef.current, { type: mime });
      audioChunksRef.current = [];
      return blob;
    }
    return null;
  };

  // Clean up speech recognition & audio recording on unmount
  useEffect(() => {
    return () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      if (audioContextRef.current) {
        try {
          void audioContextRef.current.close();
        } catch {
          // ignore
        }
      }
      if (mediaStreamRef.current) {
        try {
          mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        } catch {
          // ignore
        }
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const stopListening = async (transcribeFallback = false) => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
    const recordedBlob = await stopAudioCapture();
    setIsListening(false);

    // If Web Speech emitted transcript, use it
    const candidate = accumulatedTranscriptRef.current.trim();
    if (candidate) {
      accumulatedTranscriptRef.current = "";
      void handleFinishSpeaking(candidate);
      return;
    }

    // Fallback to Groq Whisper when Web Speech API is absent or errored (e.g. in Electron)
    if (transcribeFallback && recordedBlob && recordedBlob.size > 400 && api?.voiceTranscribe) {
      setIsRefining(true);
      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const res = reader.result as string;
            resolve(res.split(",")[1]);
          };
          reader.onerror = reject;
          reader.readAsDataURL(recordedBlob);
        });
        const res = await api.voiceTranscribe(base64, recordedBlob.type || "audio/webm");
        if (res?.text && res.text.trim()) {
          void handleFinishSpeaking(res.text.trim());
          return;
        }
      } catch (err) {
        console.warn("[Composer Voice] Whisper fallback transcription failed:", err);
      } finally {
        setIsRefining(false);
      }
    }
  };

  // Fast client-side phonetic & enterprise entity normalizer (0ms latency)
  const applyFastCorrections = (text: string): string => {
    let s = text.trim();
    s = s.replace(/\b(?:sri|shri)?\s*ganesh?\s*(?:ready\s*mix|redymix|radymix)?\b/gi, "Sri Ganesh ReadyMix");
    s = s.replace(/\b(?:in\s*voice|in\s*voices)\b/gi, "invoice");
    s = s.replace(/\b(?:ageing|aging)\s*(?:brakdown|break\s*down)\b/gi, "aging breakdown");
    s = s.replace(/\b(?:contrct|contraxt|contarct)\b/gi, "contract");
    s = s.replace(/\b(?:agreemnt|aggrement)\b/gi, "agreement");
    s = s.replace(/\b(?:warenty|warrenty)\b/gi, "warranty");
    s = s.replace(/\b(?:liabilty|liabelity)\b/gi, "liability");
    s = s.replace(/\b(?:procument|procuremnt)\b/gi, "procurement");
    s = s.replace(/\bfind\s+(?:the\s+)?invoices?\b/gi, "find invoice");
    return s;
  };

  const handleFinishSpeaking = async (rawSpokenText: string) => {
    stopListening();
    const spoken = rawSpokenText.trim();
    if (!spoken) return;

    // 1. Instant check for filler/unclear speech (0ms)
    const fillers = new Set(["uh", "um", "ah", "eh", "er", "hmm", "mm", "huh", "like"]);
    const words = spoken.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const isOnlyFiller = words.length === 0 || words.every((w) => fillers.has(w));

    if (isOnlyFiller) {
      return;
    }

    // 2. Instant client-side correction (0ms)
    const fastCorrected = applyFastCorrections(spoken);
    setValue(fastCorrected);
    setIsRefining(true);

    try {
      let finalQuery = fastCorrected;

      // If backend refine API is available, race it with a fast 350ms budget so it never lags
      if (api?.refineSpokenQuery) {
        try {
          const refinePromise = api.refineSpokenQuery(spoken);
          const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) =>
            setTimeout(() => resolve({ status: "timeout" }), 350)
          );
          const outcome: any = await Promise.race([refinePromise, timeoutPromise]);

          if (outcome && outcome.status === "clarify" && outcome.suggestions?.length) {
            setClarification({
              message: outcome.clarification || "Are you referring to one of these documents or vendors?",
              suggestions: outcome.suggestions,
            });
            setIsRefining(false);
            return;
          } else if (outcome && outcome.refined_query) {
            finalQuery = outcome.refined_query;
            setValue(finalQuery);
          }
        } catch {
          // Keep fastCorrected if API is slow or offline
        }
      }

      setIsRefining(false);

      // Auto-send query immediately hands-free!
      if (finalQuery && !busy) {
        const sent = await onSend(finalQuery, ragEnabled, attachedFile?.name);
        if (sent) {
          setValue("");
          setAttachedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
          if (ref.current) ref.current.style.height = "auto";
        }
      }
    } catch (err) {
      console.warn("Error processing refined voice query:", err);
      setIsRefining(false);
    }
  };

  const startListening = async () => {
    setClarification(null);
    accumulatedTranscriptRef.current = "";
    speechDetectedRef.current = false;
    lastSpokenTimeRef.current = 0;

    // 1. Initialize continuous MediaRecorder & AudioContext for bulletproof audio capture / Whisper fallback
    try {
      if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        mediaStreamRef.current = stream;
        audioChunksRef.current = [];

        const mimeType = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/ogg";

        if (typeof MediaRecorder !== "undefined") {
          const recorder = new MediaRecorder(stream, { mimeType });
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
              audioChunksRef.current.push(e.data);
            }
          };
          mediaRecorderRef.current = recorder;
          recorder.start(250);
        }

        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          if (ctx.state === "suspended") void ctx.resume();
          audioContextRef.current = ctx;

          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          const dataArray = new Uint8Array(analyser.frequencyBinCount);

          const checkLevel = () => {
            if (!mediaStreamRef.current) return;
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            const avg = sum / dataArray.length;
            if (avg > 3.0) {
              speechDetectedRef.current = true;
              lastSpokenTimeRef.current = Date.now();
              if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = setTimeout(() => {
                if (speechDetectedRef.current && Date.now() - lastSpokenTimeRef.current >= 800) {
                  void stopListening(true);
                }
              }, 1100);
            }
            animFrameRef.current = requestAnimationFrame(checkLevel);
          };
          animFrameRef.current = requestAnimationFrame(checkLevel);
        }
      }
    } catch (micErr) {
      console.warn("[Composer Voice] Microphone access notice:", micErr);
    }

    setIsListening(true);

    // 2. Initialize browser SpeechRecognition if available and not in Desktop Electron
    const isDesktop = typeof window !== "undefined" && Boolean((window as any).electronAPI?.isDesktop);
    const SpeechClass =
      typeof window !== "undefined" && !isDesktop
        ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        : null;

    if (SpeechClass) {
      try {
        const recognition = new SpeechClass();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang =
          typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-IN";

        recognition.onstart = () => {
          accumulatedTranscriptRef.current = "";
        };

        recognition.onresult = (event: any) => {
          let interim = "";
          let final = "";
          for (let i = 0; i < event.results.length; ++i) {
            const item = event.results[i][0];
            const transcript = item?.transcript || "";
            if (event.results[i].isFinal) {
              final = final ? `${final} ${transcript}` : transcript;
            } else {
              interim = interim ? `${interim} ${transcript}` : transcript;
            }
          }
          const currentFull = (final ? `${final} ${interim}` : interim).trim();
          if (currentFull) {
            accumulatedTranscriptRef.current = currentFull;
            setValue(currentFull);

            // Fast & snappy hands-free silence timeout: 650ms after speech pause triggers instant send!
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
            }
            silenceTimerRef.current = setTimeout(() => {
              void handleFinishSpeaking(accumulatedTranscriptRef.current);
            }, 650);
          }
        };

        recognition.onerror = (event: any) => {
          if (event.error === "no-speech") return;
          console.warn("[Composer Voice] Speech recognition notice:", event.error);
          if (event.error === "network") {
            // Google Speech API network unavailable; MediaRecorder Whisper fallback handles it
            return;
          }
          void stopListening(false);
        };

        recognition.onend = () => {
          if (isListening && !isRefining && !accumulatedTranscriptRef.current) {
            // Audio recording fallback stays active
          }
        };

        recognitionRef.current = recognition;
        recognition.start();
      } catch (err) {
        console.warn("Speech recognition initialization error:", err);
      }
    }
  };

  const handleVoiceClick = () => {
    onOpenVoiceMode?.();
    if (isListening) {
      void stopListening(true);
    } else {
      void startListening();
    }
  };

  // Auto-resize: starts compact (1 line), grows up to MAX_HEIGHT as text increases
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(el.scrollHeight, MAX_HEIGHT);
    const applied = Math.max(nextHeight, 36);
    el.style.height = `${applied}px`;
    setIsMultiline(applied > 44);
  }, [value]);

  // Focus only on explicit actions (new or resumed conversation)
  useEffect(() => {
    if (focusToken > 0) ref.current?.focus();
  }, [focusToken]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = value.trim();
    if (!text || busy) return;
    if (await onSend(text, ragEnabled, attachedFile?.name)) {
      setValue("");
      setAttachedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (ref.current) ref.current.style.height = "auto";
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const processFile = (file: File) => {
    const isDesktopOrigin = typeof window !== "undefined" && (
      window.location.protocol === "file:" ||
      Boolean((window as any).electronAPI?.isDesktop)
    );
    const maxBytes = isDesktopOrigin ? 15 * 1024 * 1024 : 3 * 1024 * 1024;
    if (file.size > maxBytes) {
      setUploadError(
        isDesktopOrigin
          ? "File exceeds maximum size of 15 MB."
          : "File exceeds the 3 MB cloud upload limit. Please attach a smaller file or connect your folder via Local Agent."
      );
      return;
    }
    setUploading(true);
    setUploadError(null);
    const reader = new FileReader();

    reader.onload = async () => {
      try {
        const base64 = (reader.result as string).split(",")[1];
        if (api?.uploadDocument) {
          await api.uploadDocument(file.name, base64);
        }
        setAttachedFile({ name: file.name, size: file.size });
        if (!value.trim()) {
          setValue(`Please analyze the attached document (${file.name}) and summarize its key findings.`);
        }
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Failed to upload document into RAG");
      } finally {
        setUploading(false);
      }
    };

    reader.onerror = () => {
      setUploadError("Could not read local file.");
      setUploading(false);
    };

    reader.readAsDataURL(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const nearLimit = value.length >= WARN_AT;
  const hasText = value.trim().length > 0;
  const hasStatusTray = Boolean(attachedFile || uploading || uploadError || clarification);

  return (
    <form
      className={`compact-composer${isMultiline || hasStatusTray ? " is-expanded" : ""}${isDragOver ? " is-drag-over" : ""}`}
      onSubmit={(e) => void submit(e)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      noValidate
    >
      {/* Hidden file input for RAG document & image OCR ingestion - supports all enterprise formats */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.xlsm,.xltx,.csv,.tsv,.txt,.text,.md,.markdown,.log,.rtf,.json,.jsonl,.xml,.html,.htm,.ppt,.pptx,.yaml,.yml,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.gif,image/*"
        style={{ display: "none" }}
        onChange={handleFileSelect}
        aria-label="Upload document to RAG"
      />

      {/* Optional attached file / upload / voice clarification tray */}
      {hasStatusTray && (
        <div className="composer-status-tray">
          {attachedFile && (
            <div className="composer-attached-pill">
              <FileText size={13} aria-hidden="true" />
              <span className="truncate">{attachedFile.name}</span>
              <span className="attach-size">({Math.round(attachedFile.size / 1024)} KB)</span>
              <button
                type="button"
                className="remove-attach-btn"
                onClick={() => {
                  setAttachedFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                aria-label="Remove attached file"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          )}

          {uploading && (
            <div className="composer-uploading-pill">
              <Loader2 size={13} className="spin" aria-hidden="true" />
              <span>Adding file to company search…</span>
            </div>
          )}

          {uploadError && (
            <div className="composer-error-pill" role="alert">
              {uploadError}
            </div>
          )}

          {clarification && (
            <div className="composer-voice-clarification" role="status">
              <div className="composer-clarification-header">
                <Sparkles size={14} className="clarification-sparkle-icon" />
                <span>{clarification.message}</span>
                <button
                  type="button"
                  className="clarification-close-btn"
                  onClick={() => setClarification(null)}
                  aria-label="Dismiss clarification"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="composer-clarification-suggestions">
                {clarification.suggestions.map((suggestion, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="clarification-chip"
                    onClick={async () => {
                      setClarification(null);
                      setValue(suggestion);
                      await onSend(suggestion, ragEnabled, attachedFile?.name);
                      setValue("");
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
                <button
                  type="button"
                  className="clarification-retry-btn"
                  onClick={startListening}
                >
                  <Mic size={12} />
                  <span>Speak again</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Single-row pill search bar */}
      <div className="composer-pill-row">
        <button
          type="button"
          className="composer-plus-btn"
          disabled={busy || uploading}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach File"
          title="Attach document to analyze"
        >
          <Plus size={18} strokeWidth={2} aria-hidden="true" />
        </button>

        <div className="composer-input-wrap">
          <label className="sr-only" htmlFor="nanvi-query">Ask Nanvi</label>
          <textarea
            id="nanvi-query"
            ref={ref}
            value={value}
            maxLength={MAX_LENGTH}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              isListening
                ? "Listening to your voice... Speak naturally (auto-sends on pause)"
                : isRefining
                ? "Refining and verifying query with AI..."
                : "Ask about company files, emails, or data..."
            }
            rows={1}
          />
        </div>

        <div className="composer-pill-actions">
          {nearLimit && (
            <span className="char-counter tabular is-warn">
              {value.length}/{MAX_LENGTH}
            </span>
          )}

          <button
            type="button"
            className={`composer-mode-btn ${ragEnabled ? "is-active" : "is-inactive"}`}
            onClick={() => onToggleRag?.(!ragEnabled)}
            aria-label={`Company file search: ${ragEnabled ? "On" : "Off"}`}
            title={
              ragEnabled
                ? "Company file search is on. Click to turn it off."
                : "Company file search is off. Click to turn it on."
            }
          >
            <span>{ragEnabled ? "Company files" : "Files off"}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>

          <button
            type="button"
            className={`composer-voice-icon-btn ${isListening ? "is-listening" : ""} ${isRefining ? "is-refining" : ""}`}
            onClick={handleVoiceClick}
            title={
              isListening
                ? "Listening... (Pause speaking to send hands-free)"
                : isRefining
                ? "Refining query with AI..."
                : "Voice Input (Speak naturally to type hands-free)"
            }
            aria-label="Open Voice Assistant Mode"
          >
            {isListening ? (
              <>
                <span className="voice-live-wave" aria-hidden="true">
                  <span className="wave-bar b1" />
                  <span className="wave-bar b2" />
                  <span className="wave-bar b3" />
                </span>
                <span>Listening...</span>
              </>
            ) : isRefining ? (
              <>
                <Sparkles size={13} className="spin" aria-hidden="true" />
                <span>Refining...</span>
              </>
            ) : (
              <>
                <Mic size={18} strokeWidth={1.8} aria-hidden="true" />
                <span className="sr-only">Voice</span>
              </>
            )}
          </button>

          {hasText || busy || uploading ? (
            <button
              type="submit"
              className={`round-send-btn ${hasText && !busy && !uploading ? "is-ready" : ""}`}
              disabled={!hasText || busy || uploading}
              aria-label="Send message"
              title="Send query"
            >
              {busy || uploading ? (
                <Loader2 size={16} className="spin" aria-hidden="true" />
              ) : (
                <ArrowUp size={17} strokeWidth={2.2} aria-hidden="true" />
              )}
            </button>
          ) : (
            <button
              type="button"
              className="composer-wave-btn"
              onClick={handleVoiceClick}
              aria-label="Start voice conversation"
              title="Voice input"
            >
              <AudioLines size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

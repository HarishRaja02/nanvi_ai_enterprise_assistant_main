import type { NanviApiClient } from "../../api";
import {
  analyzeCompleteness,
  resolveSelfRepair,
  TURN_TIMEOUTS,
} from "./turnDetector";
import {
  checkMicrophonePermission,
  classifyMicrophoneError,
  computeTimeDomainRms,
  isWhisperHallucination,
} from "../../lib/voiceInputGuard";
import { refineChatQuery } from "../../lib/queryRefiner";

type RecognitionCallbacks = {
  onInterimText?: (text: string) => void;
  onFinalText?: (text: string) => void;
  onError?: (error: string) => void;
  onAudioLevel?: (level: number) => void;
  onSilenceTimeout?: () => void;
  onSpeechStarted?: () => void;
};

// Enterprise domain vocabulary for speech recognition grammar biasing
export const ENTERPRISE_TERMS = [
  "Nanvi",
  "Nanvi AI",
  "Nanvi Assistant",
  "Project Phoenix",
  "Asteron Technologies",
  "CloudNova",
  "BluePeak",
  "NexaCorp",
  "Horizon Dynamics",
  "QuantumTech",
  "Arjun Mehta",
  "Priya Sharma",
  "Rahul Patel",
  "Kavita Reddy",
  "Deepak Kumar",
  "Anita Desai",
  "Vikram Malhotra",
  "GST",
  "CGST",
  "SGST",
  "IGST",
  "PO",
  "EBITDA",
  "CTC",
  "TDS",
  "ARR",
  "MRR",
  "SKU",
  "SLA",
  "NDA",
  "Lakh",
  "Crore",
];

export function applyPhoneticCorrections(text: string): string {
  if (!text) return "";
  return refineChatQuery(text, { mode: "voice" }).refinedQuery;
}

// Cross-browser speech recognition typing
interface IWindowSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

class SpeechRecognitionService {
  private recognition: IWindowSpeechRecognition | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId: number | null = null;
  private isListening = false;
  private callbacks: RecognitionCallbacks = {};
  private silenceTimer: number | null = null;
  private lastSpokenTime = 0;
  private speechDetected = false;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private activeSessionId = 0;
  private sessionPrefix = "";
  private accumulatedTranscript = "";
  private currentInterim = "";
  private currentWaitTimeoutMs = TURN_TIMEOUTS.STANDARD_PAUSE;
  private lastConfidence = 1.0;
  private preferredLang = "en-IN";
  private incompleteGraceCount = 0;
  private hasAudioAnalyser = false;
  private hasAudioSignal = false;
  private peakRms = 0;
  private peakFreqAvg = 0;
  private lastMicError: string | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        this.stopListening();
      });
      window.addEventListener("pagehide", () => {
        this.stopListening();
      });
    }
  }

  get supported(): boolean {
    return (
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window ||
        "webkitSpeechRecognition" in window ||
        Boolean(navigator.mediaDevices?.getUserMedia))
    );
  }

  async checkPermission(): Promise<"granted" | "denied" | "prompt"> {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
        return status.state;
      }
    } catch {
      // ignore
    }
    return "prompt";
  }

  async requestMicrophone(): Promise<MediaStream | null> {
    this.lastMicError = null;
    const perm = await checkMicrophonePermission();
    if (perm.blocked) {
      this.lastMicError =
        perm.message ||
        "Microphone access is required. Please activate microphone permission and try again.";
      this.callbacks.onError?.(this.lastMicError);
      return null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true, // Enable AGC so Bluetooth headsets (e.g. Rockerz) and quiet mics receive adequate gain
        },
      });
      return stream;
    } catch (err: any) {
      const classified = classifyMicrophoneError(err);
      this.lastMicError = classified.message;
      this.callbacks.onError?.(classified.message);
      return null;
    }
  }

  async startListening(callbacks: RecognitionCallbacks): Promise<boolean> {
    this.callbacks = callbacks;
    this.stopListening();

    const sessionId = ++this.activeSessionId;
    this.isListening = true;
    this.hasAudioAnalyser = false;
    this.hasAudioSignal = false;
    this.peakRms = 0;
    this.peakFreqAvg = 0;

    try {
      // 1. Obtain microphone stream
      const stream = await this.requestMicrophone();

      // Guard against race condition: if user exited voice mode while permission prompt was open
      if (sessionId !== this.activeSessionId || !this.isListening) {
        if (stream) {
          stream.getTracks().forEach((track) => {
            track.stop();
            track.enabled = false;
          });
        }
        return false;
      }

      if (!stream) {
        if (!this.lastMicError) {
          callbacks.onError?.(
            "Microphone access is required for Voice Assistant. Please activate your microphone and click 'Allow Microphone'."
          );
        }
        this.isListening = false;
        return false;
      }

      this.mediaStream = stream;

      // 2. Setup AudioContext analyser for live VU meter & speech activity
      this.setupAudioAnalysis(this.mediaStream);

      // 3. Setup continuous MediaRecorder for bulletproof Whisper fallback
      this.startMediaRecorder(this.mediaStream);

      // 4. Initialize browser SpeechRecognition if available
      const SpeechClass =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

      if (SpeechClass) {
        try {
          const recognition: IWindowSpeechRecognition = new SpeechClass();
          recognition.continuous = true;
          recognition.interimResults = true;

          // Adapt to user's browser English accent if available, falling back to preferredLang
          let activeLang = this.preferredLang;
          if (typeof navigator !== "undefined" && navigator.language) {
            const nav = navigator.language;
            if (nav.toLowerCase().startsWith("en")) {
              activeLang = nav;
            }
          }
          recognition.lang = activeLang;
          recognition.maxAlternatives = 1;

          // Keep open-vocabulary recognition active so ordinary English words are never
          // distorted or forced into restricted enterprise keywords.

          recognition.onstart = () => {
            this.isListening = true;
            console.log("[Nanvi Voice] SpeechRecognition started with lang:", activeLang);
          };

          recognition.onresult = (event: any) => {
            let sessionFinal = "";
            let sessionInterim = "";

            // In continuous Web Speech API, iterate across the session results from 0 to length - 1.
            // This prevents duplicate phrases when Chrome re-emits partial result sets.
            for (let i = 0; i < event.results.length; ++i) {
              const item = event.results[i][0];
              const transcript = item?.transcript ? item.transcript.trim() : "";
              if (item && typeof item.confidence === "number" && item.confidence > 0) {
                this.lastConfidence = item.confidence;
              }
              if (!transcript) continue;
              if (event.results[i].isFinal) {
                sessionFinal = sessionFinal ? `${sessionFinal} ${transcript}` : transcript;
              } else {
                sessionInterim = sessionInterim ? `${sessionInterim} ${transcript}` : transcript;
              }
            }

            const cleanFinal = applyPhoneticCorrections(sessionFinal);
            const cleanInterim = applyPhoneticCorrections(sessionInterim);

            this.accumulatedTranscript = (
              this.sessionPrefix ? `${this.sessionPrefix} ${cleanFinal}` : cleanFinal
            ).trim();
            this.currentInterim = cleanInterim;

            const fullText = (
              this.accumulatedTranscript ? `${this.accumulatedTranscript} ${this.currentInterim}` : this.currentInterim
            ).trim();

            if (fullText) {
              this.speechDetected = true;
              this.lastSpokenTime = Date.now();
              this.incompleteGraceCount = 0;
              this.callbacks.onSpeechStarted?.();
              this.callbacks.onInterimText?.(fullText);

              const analysis = analyzeCompleteness(fullText);
              this.currentWaitTimeoutMs = analysis.recommendedWaitMs;
              this.resetSilenceTimer(analysis.recommendedWaitMs);
            }
          };

          recognition.onerror = (event: any) => {
            console.warn("[Nanvi Voice] SpeechRecognition notice:", event.error);
            if (event.error === "no-speech") {
              return;
            }
            if (event.error === "network") {
              console.log("[Nanvi Voice] Google speech network unavailable; Whisper audio fallback active.");
              return;
            }
            if (event.error === "not-allowed") {
              this.callbacks.onError?.("Microphone permission was denied.");
              this.stopListening();
              return;
            }
          };

          recognition.onend = () => {
            // Save finalized words across continuous micro-restarts so turns aren't lost
            if (this.accumulatedTranscript) {
              this.sessionPrefix = this.accumulatedTranscript;
            }
            // In Chrome, restart cleanly with a micro-delay to prevent InvalidStateError
            if (this.isListening && this.recognition === recognition) {
              setTimeout(() => {
                if (this.isListening && this.recognition === recognition) {
                  try {
                    recognition.start();
                  } catch (e) {
                    // Ignore if already running or shutting down
                  }
                }
              }, 120);
            }
          };

          this.recognition = recognition;
          recognition.start();
        } catch (recErr) {
          console.warn("[Nanvi Voice] SpeechRecognition initialization failed, relying on Whisper fallback:", recErr);
        }
      }

      this.isListening = true;
      return true;
    } catch (err: any) {
      this.callbacks.onError?.(err?.message || "Failed to start speech recognition.");
      return false;
    }
  }

  private setupAudioAnalysis(stream: MediaStream) {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      this.audioContext = new AudioCtx();
      if (this.audioContext.state === "suspended") {
        void this.audioContext.resume();
      }

      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      this.sourceNode = source;
      this.analyser = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const timeDomainArray = new Uint8Array(analyser.fftSize);
      this.hasAudioAnalyser = true;

      const checkVolume = () => {
        if (!this.analyser || !this.isListening) return;

        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        let rms = 0;
        if (typeof this.analyser.getByteTimeDomainData === "function") {
          this.analyser.getByteTimeDomainData(timeDomainArray);
          rms = computeTimeDomainRms(timeDomainArray);
        }
        if (rms > this.peakRms) this.peakRms = rms;
        if (avg > this.peakFreqAvg) this.peakFreqAvg = avg;

        // Resilient volume normalization across all hardware types (Bluetooth headsets like Rockerz, laptops, USB mics)
        // Background floor in quiet room is avg < 2.5. Human voice raises avg to 8 - 45.
        const normalized = Math.min(1.0, Math.max(0, (avg - 2.5) / 42));

        // Detect user speech activity via microphone volume or time-domain RMS
        if (normalized > 0.08 || rms > 0.012) {
          this.hasAudioSignal = true;
          this.lastSpokenTime = Date.now();
          if (!this.speechDetected) {
            this.speechDetected = true;
            this.callbacks.onSpeechStarted?.();
          }
          this.resetSilenceTimer(this.currentWaitTimeoutMs);
        }

        this.callbacks.onAudioLevel?.(normalized);
        this.animFrameId = requestAnimationFrame(checkVolume);
      };

      this.animFrameId = requestAnimationFrame(checkVolume);
    } catch (e) {
      console.warn("[Nanvi Voice] AudioContext setup error:", e);
    }
  }

  private startMediaRecorder(stream: MediaStream) {
    try {
      this.audioChunks = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/ogg";

      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.audioChunks.push(e.data);
          // Keep sliding window of last ~15 seconds to avoid memory ballooning
          if (this.audioChunks.length > 60) {
            this.audioChunks.splice(0, 10);
          }
        }
      };
      this.mediaRecorder = recorder;
      recorder.start(250);
    } catch (e) {
      console.warn("[Nanvi Voice] MediaRecorder start error:", e);
    }
  }

  async getRecordedAudioBlob(): Promise<Blob | null> {
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      try {
        this.mediaRecorder.requestData();
      } catch {
        // ignore
      }
    }
    // Short wait for dataavailable event to push latest audio chunk
    await new Promise((r) => setTimeout(r, 80));
    if (!this.audioChunks || this.audioChunks.length === 0) return null;
    const mimeType = this.mediaRecorder?.mimeType || "audio/webm";
    return new Blob(this.audioChunks, { type: mimeType });
  }

  clearRecordedAudio(): void {
    this.audioChunks = [];
    this.speechDetected = false;
    this.hasAudioSignal = false;
    this.peakRms = 0;
    this.peakFreqAvg = 0;
  }

  async transcribeViaBackend(api: NanviApiClient): Promise<string | null> {
    const noSignal =
      this.hasAudioAnalyser &&
      !this.hasAudioSignal &&
      this.peakRms < 0.008 &&
      this.peakFreqAvg < 3.0;
    const blob = await this.getRecordedAudioBlob();
    if (noSignal || !blob || blob.size < 1000) {
      if (noSignal) {
        this.callbacks.onError?.(
          "No microphone audio detected. Please activate and unmute your microphone."
        );
      }
      return null;
    }

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const res = reader.result as string;
          const base64Data = res.split(",")[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      const mimeType = blob.type || "audio/webm";
      console.log(`[Nanvi Voice] Sending ${Math.round(blob.size / 1024)} KB audio to Groq Whisper...`);
      const res = await api.voiceTranscribe(base64, mimeType);
      const rawText = String(res?.text || "").trim();
      if (res?.no_speech || !rawText || isWhisperHallucination(rawText)) {
        return null;
      }
      const corrected = applyPhoneticCorrections(rawText);
      console.log("[Nanvi Voice] Groq Whisper transcribed:", corrected);
      return corrected;
    } catch (err) {
      console.warn("[Nanvi Voice] Backend transcription fallback error:", err);
      return null;
    }
  }

  private resetSilenceTimer(delayMs: number = TURN_TIMEOUTS.STANDARD_PAUSE) {
    this.clearSilenceTimer();
    this.silenceTimer = window.setTimeout(() => {
      if (!this.isListening) return;

      const fullText = (
        this.accumulatedTranscript ? `${this.accumulatedTranscript} ${this.currentInterim}` : this.currentInterim
      ).trim();
      const analysis = analyzeCompleteness(fullText);

      // 1. If only vocal hesitation, wait for substantive thought without wiping previous context
      if (analysis.status === "hesitation_only") {
        console.log(`[Nanvi Voice] Hesitation detected ('${fullText}'). Waiting for user thought.`);
        this.currentInterim = "";
        this.speechDetected = false;
        return;
      }

      // 2. If phrase is incomplete (e.g. trailing preposition, conjunction, suspension, hesitation, incomplete starter), give extra grace period
      if (analysis.status === "incomplete" && this.incompleteGraceCount < 2) {
        this.incompleteGraceCount += 1;
        console.log(`[Nanvi Voice] Incomplete phrase ('${fullText}'). Reason: ${analysis.reason}. Waiting for user to complete thought.`);
        this.resetSilenceTimer(2500);
        return;
      }

      this.incompleteGraceCount = 0;

      // 3. If user spoke substantive words and silence threshold has elapsed
      if (fullText.length > 0) {
        this.speechDetected = false;
        this.clearSilenceTimer();
        const resolvedText = resolveSelfRepair(fullText);
        console.log(
          "[Nanvi Voice] Smart turn finalized:",
          resolvedText,
          `(Completeness: ${analysis.status}, Reason: ${analysis.reason || "silence_timeout"})`
        );
        this.sessionPrefix = "";
        this.accumulatedTranscript = "";
        this.currentInterim = "";
        this.callbacks.onFinalText?.(resolvedText);
        return;
      }

      // 3. Fallback when speech was detected by audio analyser but Web Speech did not yield transcript
      if (this.speechDetected && Date.now() - this.lastSpokenTime >= 1000) {
        this.speechDetected = false;
        this.callbacks.onSilenceTimeout?.();
      }
    }, delayMs);
  }

  private clearSilenceTimer() {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  finalizeAccumulated(): string {
    const fullText = (
      this.accumulatedTranscript ? `${this.accumulatedTranscript} ${this.currentInterim}` : this.currentInterim
    ).trim();
    this.sessionPrefix = "";
    this.accumulatedTranscript = "";
    this.currentInterim = "";
    this.clearSilenceTimer();
    return resolveSelfRepair(fullText);
  }

  getAccumulatedTranscript(): string {
    return (
      this.accumulatedTranscript ? `${this.accumulatedTranscript} ${this.currentInterim}` : this.currentInterim
    ).trim();
  }

  clearAccumulatedTranscript(): void {
    this.sessionPrefix = "";
    this.accumulatedTranscript = "";
    this.currentInterim = "";
    this.clearSilenceTimer();
  }

  getLastConfidence(): number {
    return this.lastConfidence;
  }

  getPreferredLanguage(): string {
    return this.preferredLang;
  }

  setPreferredLanguage(lang: string): void {
    this.preferredLang = lang;
    if (this.recognition) {
      try {
        this.recognition.lang = lang;
      } catch {
        // ignore
      }
    }
  }

  pauseRecognition(): void {
    // Keep audio stream and analyser running for barge-in volume detection,
    // but pause current speech buffer
    this.sessionPrefix = "";
    this.accumulatedTranscript = "";
    this.currentInterim = "";
    this.speechDetected = false;
    this.clearSilenceTimer();
  }

  stopListening(): void {
    // Invalidate any in-flight requests immediately
    this.activeSessionId++;
    this.isListening = false;
    this.speechDetected = false;
    this.sessionPrefix = "";
    this.accumulatedTranscript = "";
    this.currentInterim = "";
    this.currentWaitTimeoutMs = TURN_TIMEOUTS.STANDARD_PAUSE;
    this.lastConfidence = 1.0;
    this.clearSilenceTimer();

    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch {
        // ignore
      }
      this.recognition = null;
    }

    if (this.mediaRecorder) {
      try {
        if (this.mediaRecorder.state !== "inactive") {
          this.mediaRecorder.stop();
        }
      } catch {
        // ignore
      }
      this.mediaRecorder = null;
    }

    // Forcefully stop and disable all audio tracks to immediately release hardware mic
    if (this.mediaStream) {
      try {
        this.mediaStream.getTracks().forEach((track) => {
          track.stop();
          track.enabled = false;
        });
      } catch (e) {
        console.warn("[Nanvi Voice] Error stopping media tracks:", e);
      }
      this.mediaStream = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }

    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        // ignore
      }
      this.analyser = null;
    }

    if (this.audioContext) {
      try {
        void this.audioContext.close().catch(() => {});
      } catch {
        // ignore
      }
      this.audioContext = null;
    }

    this.callbacks.onAudioLevel?.(0);
  }
}

export const speechRecognitionService = new SpeechRecognitionService();

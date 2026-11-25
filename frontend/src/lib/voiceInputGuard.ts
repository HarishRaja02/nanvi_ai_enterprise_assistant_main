const HALLUCINATION_EXACT = new Set([
  "thank you for watching",
  "thanks for watching",
  "thank you very much for watching",
  "thank you so much for watching",
  "thanks for watching this video",
  "thanks for watching my video",
  "thank you for listening",
  "thanks for listening",
  "please subscribe",
  "subscribe",
  "like and subscribe",
  "please like and subscribe",
  "subscribe to my channel",
  "see you in the next video",
  "see you next time",
  "bye bye",
  "mbc",
  "amara org",
]);

const HALLUCINATION_PATTERNS: RegExp[] = [
  /\bthank(?:s|\s+you)\b(?:\s+(?:very|so)\s+much)?\s+for\s+(?:watching|listening)\b/i,
  /\b(?:subtitles|captions|transcribed)\s+by\b/i,
  /\bamara\.org\b/i,
  /\b(?:don'?t\s+forget\s+to\s+subscribe|like\s+and\s+subscribe|subscribe\s+to\s+(?:my|our)\s+channel)\b/i,
];

export interface MicPermissionCheck {
  blocked: boolean;
  status: string;
  canOpenSettings: boolean;
  message?: string;
}

export function isDesktopEnvironment(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.electronAPI?.isDesktop) || window.location.protocol === "file:";
}

/**
 * Returns true if the transcription looks like a known Whisper silence/outro hallucination
 * (e.g. "Thank you for watching!") rather than real spoken user input.
 */
export function isWhisperHallucination(text: string): boolean {
  const raw = String(text || "").trim();
  if (!raw) return true;
  const normalized = raw
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return true;
  if (HALLUCINATION_EXACT.has(normalized)) return true;
  const wordCount = normalized.split(" ").filter(Boolean).length;
  return HALLUCINATION_PATTERNS.some((pat) => pat.test(raw) && wordCount <= 12);
}

/**
 * Computes normalized time-domain RMS [0..1] from an AnalyserNode byte buffer.
 * Returns ~0 when a microphone is muted, disabled, or blocked at OS level.
 */
export function computeTimeDomainRms(bytes: Uint8Array): number {
  if (!bytes || bytes.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < bytes.length; i++) {
    const centered = (bytes[i] - 128) / 128;
    sumSq += centered * centered;
  }
  return Math.sqrt(sumSq / bytes.length);
}

/**
 * Checks OS/Electron and browser microphone permission before capture starts.
 */
export async function checkMicrophonePermission(): Promise<MicPermissionCheck> {
  const isDesktop = isDesktopEnvironment();
  const canOpenSettings =
    typeof window !== "undefined" && Boolean(window.electronAPI?.openMicSettings);

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return {
      blocked: true,
      status: "unsupported",
      canOpenSettings,
      message:
        "Microphone capture is unavailable on this device. Please connect or enable a microphone and try again.",
    };
  }

  try {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (api?.getMicAccessStatus) {
      const osAccess = await api.getMicAccessStatus();
      const status = String(osAccess?.status || "unknown").toLowerCase();
      if (status === "denied" || status === "restricted") {
        return {
          blocked: true,
          status,
          canOpenSettings,
          message:
            osAccess?.platform === "win32" || isDesktop
              ? "Microphone permission is turned off. Please activate microphone access in Windows Privacy Settings to use voice input."
              : "Microphone permission is turned off in System Settings. Please enable microphone access to use voice input.",
        };
      }
      if (status === "not-determined" && api.requestMicAccess) {
        const req = await api.requestMicAccess();
        if (!req.granted) {
          return {
            blocked: true,
            status: req.status || "denied",
            canOpenSettings,
            message:
              "Microphone access was not granted. Please allow microphone access to use voice input.",
          };
        }
      }
    }
  } catch {
    // Fall back cleanly to browser permission & getUserMedia probe
  }

  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      if (status?.state === "denied") {
        return {
          blocked: true,
          status: "denied",
          canOpenSettings,
          message: isDesktop
            ? "Microphone permission is blocked. Please activate your microphone in Windows Privacy Settings and click Try Again."
            : "Microphone permission is blocked. Please allow microphone access in your browser site settings and try again.",
        };
      }
    }
  } catch {
    // Some WebViews don't support querying "microphone" via Permissions API
  }

  return { blocked: false, status: "prompt-or-granted", canOpenSettings };
}

/**
 * Maps getUserMedia errors to actionable instructions asking the user to activate their mic.
 */
export function classifyMicrophoneError(err: unknown): {
  message: string;
  canOpenSettings: boolean;
} {
  const isDesktop = isDesktopEnvironment();
  const canOpenSettings =
    typeof window !== "undefined" && Boolean(window.electronAPI?.openMicSettings);
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name?: unknown }).name || "")
      : "";
  const rawMsg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "";
  const lower = `${name} ${rawMsg}`.toLowerCase();

  if (
    lower.includes("notallowed") ||
    lower.includes("permissiondenied") ||
    lower.includes("permission denied") ||
    lower.includes("denied")
  ) {
    return {
      canOpenSettings,
      message: isDesktop
        ? "Microphone access is required. Please activate microphone permission in Windows Privacy Settings, then click Allow Microphone."
        : "Microphone permission is required. Please allow microphone access in your browser prompt/settings and try again.",
    };
  }

  if (lower.includes("notfound") || lower.includes("devicesnotfound") || lower.includes("no device")) {
    return {
      canOpenSettings,
      message:
        "No active microphone was found. Please connect or enable a microphone in your device settings and try again.",
    };
  }

  if (lower.includes("notreadable") || lower.includes("trackstart") || lower.includes("abort")) {
    return {
      canOpenSettings,
      message:
        "Your microphone could not be read (it may be muted, disabled in Windows Settings, or in use by another app). Please activate your mic and try again.",
    };
  }

  return {
    canOpenSettings,
    message:
      "Please check that your microphone is connected, unmuted, and permitted, then try voice input again.",
  };
}

export async function openSystemMicrophoneSettings(): Promise<boolean> {
  if (typeof window === "undefined" || !window.electronAPI?.openMicSettings) {
    return false;
  }
  try {
    return await window.electronAPI.openMicSettings();
  } catch {
    return false;
  }
}


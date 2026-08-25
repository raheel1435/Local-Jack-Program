/**
 * Curated subset of Kokoro-FastAPI's ~70 voice IDs (confirmed live via
 * GET /v1/audio/voices), presented with human-friendly labels -- Phase 8 of
 * the persona/voice milestone: never show a raw provider id as the primary
 * label. The full id is still available for debug/internal use.
 */
export interface VoiceOption {
  id: string;
  label: string;
  gender: "Female" | "Male";
  accent: string;
}

export const VOICE_OPTIONS: VoiceOption[] = [
  { id: "am_adam", label: "Jack", gender: "Male", accent: "English (US)" },
  { id: "af_nova", label: "Nova", gender: "Female", accent: "English (US)" },
];

export const DEFAULT_VOICE_ID = "am_adam";

/** Removed or malformed persisted selections safely become Jack. */
export function normalizeVoiceId(value: unknown): string {
  return typeof value === "string" && VOICE_OPTIONS.some((voice) => voice.id === value)
    ? value
    : DEFAULT_VOICE_ID;
}

/**
 * Language options for Jack's speech/conversation behavior. Honest about
 * current limitations (Phase 6): the installed Whisper model
 * (ggml-base.en.bin) is English-only, and Kokoro's available voices are all
 * English-family accents -- no Swedish voice exists. Selecting anything but
 * English is shown, not hidden, but doesn't yet change transcription or
 * speech output.
 */
export interface LanguageOption {
  id: string;
  label: string;
  /** Present when this option doesn't yet functionally change STT/TTS behavior. */
  limitation?: string;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { id: "English", label: "English" },
  {
    id: "Swedish",
    label: "Swedish",
    limitation: "Not yet supported by the local Whisper/Kokoro models -- Jack will keep listening and speaking in English.",
  },
  {
    id: "Auto",
    label: "Auto / same as presentation",
    limitation: "The installed Whisper model is English-only, so auto-detection isn't available yet -- Jack will use English.",
  },
];

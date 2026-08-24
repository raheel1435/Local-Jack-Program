/**
 * Client for the local Jack-Local-AI-Service gateway (whisper.cpp STT,
 * llama.cpp/Colibri LLM, Kokoro TTS) — see Local-Jack-Program/LOCAL_JACK_RUNTIME.md.
 * This is the ONLY place that knows the gateway's base URL or endpoint
 * shapes; everything else in the app goes through this module.
 */

const BASE_URL =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_JACK_LOCAL_URL) ||
  "http://127.0.0.1:43110";

export type JackIntentAction =
  | "start_presentation"
  | "next_slide"
  | "previous_slide"
  | "jump_to_slide"
  | "pause_presentation"
  | "resume_presentation"
  | "explain_slide"
  | "summarize_slide"
  | "handoff_to_presenter"
  | "stop_presentation";

export interface JackHealth {
  /** "unreachable" means the gateway process itself could not be reached at
   * all (connection refused, timeout, non-2xx, malformed response) -- see
   * jackApi.health()'s catch block. Distinct from any individual provider
   * being "unavailable" while the gateway process is genuinely up. */
  gateway: "ok" | "unreachable";
  colibri: "available" | "unavailable";
  llamacpp: "available" | "unavailable";
  whisper: "available" | "unavailable";
  vibevoice: "available" | "unavailable";
  kokoro: "available" | "unavailable";
  activeLlmProvider: "colibri" | "llamacpp";
}

/** Stable ASR engine ids -- "whisper" is Approved (default everywhere),
 * "vibevoice" is Test (opt-in only, never a silent fallback target). Mirrors
 * Jack-Local-AI-Service/src/types/jack.ts's AsrProviderId. */
export type AsrProviderId = "whisper" | "vibevoice";

export interface JackTranscribeResult {
  text: string;
  provider: AsrProviderId;
  latencyMs: number;
  language?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export type JackIntentType = "action" | "conversation" | "unknown";

export interface JackIntentResult {
  source: "deterministic" | "llm";
  /** "action" is the only type for which `action` is meaningful -- the gateway
   * enforces this server-side, but never trust a truthy `action` without also
   * checking `type === "action"`. */
  type: JackIntentType;
  action?: JackIntentAction | string;
  target?: string;
  raw?: string;
  latencyMs: number;
}

export interface JackChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JackChatResult {
  content: string;
  model: string;
  latencyMs: number;
}

const HEALTH_TIMEOUT_MS = 2000;

async function postJson<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { detail?: string } | null;
    throw new Error(detail?.detail || `Jack Local AI request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function rawSpeak(text: string, voice?: string): Promise<Blob> {
  const res = await fetch(`${BASE_URL}/jack/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Jack Local AI speech request failed: ${res.status}`);
  return res.blob();
}

// Single-file-of-record queue (see jackApi.speak's doc comment): every
// speak() call chains onto this promise, so the actual fetch to Kokoro
// never overlaps with another one from this client, regardless of how many
// callers requested speech concurrently. A rejection from one call must
// never poison the queue for the next -- .catch(() => {}) on the chain
// link, not on the caller's own returned promise.
let speakQueue: Promise<unknown> = Promise.resolve();
function enqueueSpeak<T>(run: () => Promise<T>): Promise<T> {
  const result = speakQueue.then(run, run);
  speakQueue = result.catch(() => {});
  return result;
}

export const jackApi = {
  baseUrl: BASE_URL,

  /** Never throws -- returns a synthetic report on any failure, so callers can always render an honest status. `gateway: "unreachable"` (CLAUDE-04 fix) distinguishes "the gateway process itself didn't respond" from a genuinely-up gateway whose providers happen to all be down. */
  async health(): Promise<JackHealth> {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()) as JackHealth;
    } catch {
      return {
        gateway: "unreachable",
        colibri: "unavailable",
        llamacpp: "unavailable",
        whisper: "unavailable",
        vibevoice: "unavailable",
        kokoro: "unavailable",
        activeLlmProvider: "llamacpp",
      };
    }
  },

  /** Runs the deterministic-command-router-then-LLM-fallback intent classifier.
   * `assistantName` is the currently selected persona (Bella/Adam/Nova/Sarah/
   * George/Emma/Jack/...) that the gateway treats as the wake word -- defaults
   * server-side to "Jack" when omitted. */
  detectIntent(text: string, assistantName?: string): Promise<JackIntentResult> {
    return postJson<JackIntentResult>("/jack/intent", { text, assistantName }, 15_000);
  },

  chat(messages: JackChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<JackChatResult> {
    return postJson<JackChatResult>(
      "/jack/chat",
      { messages, max_tokens: opts?.maxTokens ?? 200, temperature: opts?.temperature ?? 0.4 },
      30_000,
    );
  },

  /** Transcribes browser-captured audio (a WAV blob) via the selected ASR engine -- no filesystem path ever crosses the browser boundary. `provider` defaults to "whisper" (Approved) when omitted. */
  async transcribeAudio(audio: Blob, language?: string, provider?: AsrProviderId): Promise<JackTranscribeResult> {
    const params = new URLSearchParams();
    if (language) params.set("language", language);
    if (provider) params.set("provider", provider);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${BASE_URL}/jack/transcribe${qs}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: audio,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
      throw new Error(detail?.detail || `Jack Local AI transcription failed: ${res.status}`);
    }
    return res.json();
  },

  /**
   * Fetches Kokoro-synthesized speech audio for the given text.
   *
   * Serialized through speakQueue (latency-fix milestone): progressive
   * narration now fires more than one speak() concurrently by design (the
   * current slide's continuation and the next slide's prefetched opening
   * can both be in flight while the current opening plays). Confirmed live
   * that Kokoro-FastAPI returns 503 on a genuinely concurrent second
   * request rather than queuing it itself -- this queue is the fix, on the
   * client, without touching Kokoro. Callers still get true parallelism for
   * everything BEFORE this call (LLM generation, context building); only
   * the TTS requests themselves are serialized, one at a time, in the order
   * they were issued.
   */
  speak(text: string, voice?: string): Promise<Blob> {
    return enqueueSpeak(() => rawSpeak(text, voice));
  },

  /**
   * Converts a .pptx file to a faithful PDF via local PowerPoint COM
   * automation (real layout/fonts/images), for the PresentStage visual
   * renderer -- entirely separate from the semantic PPTX parser Jack's
   * context comes from. Throws with a clear reason on failure (no
   * PowerPoint installed, conversion error, timeout); callers must fall
   * back to the simplified reading view rather than retry indefinitely.
   */
  async convertPptxToPdf(file: File): Promise<Blob> {
    const res = await fetch(`${BASE_URL}/jack/convert-pptx`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
      body: file,
      signal: AbortSignal.timeout(75_000),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
      throw new Error(detail?.detail || `PPTX conversion failed: ${res.status}`);
    }
    return res.blob();
  },
};

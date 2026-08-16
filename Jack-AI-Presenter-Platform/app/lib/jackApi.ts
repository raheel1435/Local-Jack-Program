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
  gateway: "ok";
  colibri: "available" | "unavailable";
  llamacpp: "available" | "unavailable";
  whisper: "available" | "unavailable";
  kokoro: "available" | "unavailable";
  activeLlmProvider: "colibri" | "llamacpp";
}

export interface JackIntentResult {
  source: "deterministic" | "llm";
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

export const jackApi = {
  baseUrl: BASE_URL,

  /** Never throws -- returns a synthetic "unavailable" report on any failure, so callers can always render an honest status. */
  async health(): Promise<JackHealth> {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()) as JackHealth;
    } catch {
      return {
        gateway: "ok",
        colibri: "unavailable",
        llamacpp: "unavailable",
        whisper: "unavailable",
        kokoro: "unavailable",
        activeLlmProvider: "llamacpp",
      };
    }
  },

  /** Runs the deterministic-command-router-then-LLM-fallback intent classifier. */
  detectIntent(text: string): Promise<JackIntentResult> {
    return postJson<JackIntentResult>("/jack/intent", { text }, 15_000);
  },

  chat(messages: JackChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<JackChatResult> {
    return postJson<JackChatResult>(
      "/jack/chat",
      { messages, max_tokens: opts?.maxTokens ?? 200, temperature: opts?.temperature ?? 0.4 },
      30_000,
    );
  },

  /** Transcribes a local audio file already on disk (the gateway shells out to whisper.cpp by path, not upload). */
  transcribe(audioFilePath: string, language?: string): Promise<{ text: string; latencyMs: number }> {
    return postJson("/jack/transcribe", { audioFilePath, language }, 30_000);
  },

  /** Transcribes browser-captured audio (a WAV blob) via whisper.cpp -- no filesystem path ever crosses the browser boundary. */
  async transcribeAudio(audio: Blob, language?: string): Promise<{ text: string; latencyMs: number }> {
    const qs = language ? `?language=${encodeURIComponent(language)}` : "";
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

  /** Fetches Kokoro-synthesized speech audio for the given text. */
  async speak(text: string, voice?: string): Promise<Blob> {
    const res = await fetch(`${BASE_URL}/jack/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Jack Local AI speech request failed: ${res.status}`);
    return res.blob();
  },
};

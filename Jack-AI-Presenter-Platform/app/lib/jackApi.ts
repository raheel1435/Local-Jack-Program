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
  /** Multi-provider AI milestone: collapses "no key configured" into
   * "unavailable", same as every other provider's "can't be used right
   * now" -- the not-configured/invalid nuance lives in
   * jackApi.getCredentialStatus(), not here. */
  openai: "available" | "unavailable";
  anthropic: "available" | "unavailable";
  activeLlmProvider: "colibri" | "llamacpp";
}

/** Multi-provider AI milestone: which AI brain a request wants, independent
 * of ASR selection. "local" means whichever local engine the gateway
 * already picked at boot (colibri/llamacpp) -- this selector does not
 * choose between those two, it chooses local vs. a cloud BYOK provider.
 * Mirrors Jack-Local-AI-Service/src/types/jack.ts's AiBrainSelector. */
export type AiProviderId = "local" | "openai" | "anthropic";

/** BYOK credential-status vocabulary. Mirrors
 * Jack-Local-AI-Service/src/types/jack.ts's CredentialProviderId/
 * CredentialStatus/CredentialStatusReport. */
export type CredentialProviderId = "openai" | "anthropic";
export type CredentialStatus = "not_configured" | "connected" | "invalid";

export interface CredentialStatusReport {
  provider: CredentialProviderId;
  status: CredentialStatus;
  /** Last 4 characters of the stored key. Present only when
   * status !== "not_configured". NEVER the full key -- the gateway never
   * returns it, and this client never asks for or stores it. */
  lastFour?: string;
  updatedAt?: string;
  detail?: string;
}

/** Stable ASR engine ids -- "whisper" is Approved (default everywhere and
 * the request-level local fallback for Vibe), "vibevoice" is Test (opt-in),
 * "openai" is OpenAI Speech (Stage 2, multi-provider AI milestone) -- a
 * cloud BYOK engine, independent of AiProviderId's own "openai" value (two
 * separate axes; selecting one never implies the other). Mirrors
 * Jack-Local-AI-Service/src/types/jack.ts's AsrProviderId. */
export type AsrProviderId = "whisper" | "vibevoice" | "openai";

export interface JackTranscribeResult {
  text: string;
  provider: AsrProviderId;
  latencyMs: number;
  language?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
  requestedProvider?: AsrProviderId;
  actualProvider?: AsrProviderId;
  fallbackUsed?: boolean;
  fallbackFrom?: AsrProviderId;
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
  /** Council engineering audit finding: this field was already sent by the
   * gateway's LLM-fallback path (never by the deterministic path) whenever
   * its own safety gate downgraded a high-impact action (e.g. stop_presentation)
   * to a harmless "conversation" reply -- but this type never declared it, so
   * it was silently dropped by every caller. Present only on that downgrade
   * path; the name of the action that WOULD have run had the extra scrutiny
   * (direct address + no suspicious repetition) not failed. */
  downgradedFrom?: string;
  requestedProvider?: AiProviderId;
  actualProvider?: AiProviderId;
  actualLocalProvider?: "colibri" | "llamacpp";
  fallbackUsed?: boolean;
  fallbackFrom?: "colibri" | "llamacpp";
}

export interface JackChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JackChatResult {
  content: string;
  model: string;
  latencyMs: number;
  requestedProvider?: AiProviderId;
  actualProvider?: AiProviderId;
  actualLocalProvider?: "colibri" | "llamacpp";
  fallbackUsed?: boolean;
  fallbackFrom?: "colibri" | "llamacpp";
}

export interface ProviderFallbackRequest {
  kind: "brain" | "asr";
  failedProvider: AiProviderId | AsrProviderId;
  options: Array<AiProviderId | AsrProviderId>;
  detail: string;
  credentialRequired?: CredentialProviderId;
}

export interface ProviderRequestStatus {
  kind: "brain" | "asr";
  selectedProvider: string;
  actualProvider: string;
  actualLocalProvider?: "colibri" | "llamacpp";
  fallbackUsed: boolean;
  fallbackFrom?: string;
}

type FallbackConsentHandler = (request: ProviderFallbackRequest) => Promise<string | null>;
type ProviderStatusHandler = (status: ProviderRequestStatus) => void;
let fallbackConsentHandler: FallbackConsentHandler | null = null;
let providerStatusHandler: ProviderStatusHandler | null = null;

export function setProviderFallbackConsentHandler(handler: FallbackConsentHandler | null): void {
  fallbackConsentHandler = handler;
}

export function setProviderRequestStatusHandler(handler: ProviderStatusHandler | null): void {
  providerStatusHandler = handler;
}

// The user answers a fallback prompt once per upload session: the answer is
// remembered (null = cancelled) and reused silently until the next upload
// calls resetProviderFallbackDecisions(). Requests that fail while a prompt is
// already open share that one prompt instead of replacing it. A cancel while
// credentials are missing is not remembered -- that dialog sends the user to
// Settings, and the next request must be able to prompt again once a key exists.
const fallbackDecisions = new Map<string, string | null>();
const pendingFallbackPrompts = new Map<string, Promise<string | null>>();

export function resetProviderFallbackDecisions(): void {
  fallbackDecisions.clear();
}

function requestFallbackChoice(handler: FallbackConsentHandler, request: ProviderFallbackRequest): Promise<string | null> {
  const key = `${request.kind}:${request.failedProvider}`;
  if (fallbackDecisions.has(key)) return Promise.resolve(fallbackDecisions.get(key) ?? null);
  const pending = pendingFallbackPrompts.get(key);
  if (pending) return pending;
  const prompt = handler(request)
    .then((choice) => {
      if (choice !== null || !request.credentialRequired) fallbackDecisions.set(key, choice);
      return choice;
    })
    .finally(() => {
      pendingFallbackPrompts.delete(key);
    });
  pendingFallbackPrompts.set(key, prompt);
  return prompt;
}

interface JackApiErrorBody {
  error?: string;
  detail?: string;
  code?: string;
  provider?: string;
  fallbackOptions?: string[];
  requiresConsent?: boolean;
  credentialRequired?: CredentialProviderId;
}

export class JackApiError extends Error {
  readonly status: number;
  readonly body: JackApiErrorBody;

  constructor(status: number, body: JackApiErrorBody) {
    super(body.detail || `Jack Local AI request failed: ${status}`);
    this.status = status;
    this.body = body;
  }
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
    const detail = await res.json().catch(() => ({})) as JackApiErrorBody;
    throw new JackApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

function observeBrain(result: JackChatResult | JackIntentResult, selected: AiProviderId): void {
  const actual = result.actualProvider ?? selected;
  providerStatusHandler?.({
    kind: "brain",
    selectedProvider: selected,
    actualProvider: actual,
    actualLocalProvider: result.actualLocalProvider,
    fallbackUsed: (result.fallbackUsed ?? false) || actual !== selected,
    fallbackFrom: result.fallbackFrom ?? (actual !== selected ? selected : undefined),
  });
}

async function withBrainConsent<T extends JackChatResult | JackIntentResult>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const selected = (body.aiProvider as AiProviderId | undefined) ?? "local";
  try {
    const result = await postJson<T>(path, body, timeoutMs);
    observeBrain(result, selected);
    return result;
  } catch (error) {
    if (!(error instanceof JackApiError) || !error.body.requiresConsent || !fallbackConsentHandler) throw error;
    const choice = await requestFallbackChoice(fallbackConsentHandler, {
      kind: "brain",
      failedProvider: (error.body.provider as AiProviderId | undefined) ?? selected,
      options: (error.body.fallbackOptions ?? []) as AiProviderId[],
      detail: error.message,
      credentialRequired: error.body.credentialRequired,
    });
    if (!choice) throw error;
    const retryProvider = choice as AiProviderId;
    const result = await postJson<T>(path, { ...body, aiProvider: retryProvider }, timeoutMs);
    observeBrain(result, selected);
    return result;
  }
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
        openai: "unavailable",
        anthropic: "unavailable",
        activeLlmProvider: "llamacpp",
      };
    }
  },

  /** Runs the deterministic-command-router-then-LLM-fallback intent classifier.
   * `assistantName` is the currently selected persona (Jack or Nova) that
   * the gateway treats as the wake word -- defaults
   * server-side to "Jack" when omitted. */
  /** `inputSource`: council engineering audit fix -- lets the gateway's
   * HIGH_IMPACT_ACTIONS safety downgrade (see intent.ts) tell deliberately
   * typed text (no ambient-noise/ASR-hallucination risk at all) apart from
   * voice-captured text (where that risk is real and the check must stay).
   * Omitting it keeps the gateway's existing protected-by-default behavior. */
  /** `aiProvider`: multi-provider AI milestone -- which AI brain classifies
   * the LLM-fallback case (never consulted for a deterministic match).
   * Omitting it keeps today's "local" default. */
  detectIntent(
    text: string,
    assistantName?: string,
    inputSource?: "typed" | "voice" | "interruption",
    aiProvider?: AiProviderId,
  ): Promise<JackIntentResult> {
    return withBrainConsent<JackIntentResult>("/jack/intent", { text, assistantName, inputSource, aiProvider }, 15_000);
  },

  chat(
    messages: JackChatMessage[],
    opts?: { maxTokens?: number; temperature?: number; aiProvider?: AiProviderId },
  ): Promise<JackChatResult> {
    return withBrainConsent<JackChatResult>(
      "/jack/chat",
      {
        messages,
        max_tokens: opts?.maxTokens ?? 200,
        temperature: opts?.temperature ?? 0.4,
        aiProvider: opts?.aiProvider,
      },
      30_000,
    );
  },

  /** Transcribes browser-captured audio (a WAV blob) via the selected ASR engine -- no filesystem path ever crosses the browser boundary. `provider` defaults to "whisper" (Approved) when omitted. `assistantName` primes ASR with the active persona's wake word without changing the downstream address gate. */
  async transcribeAudio(audio: Blob, language?: string, provider?: AsrProviderId, assistantName?: string): Promise<JackTranscribeResult> {
    const params = new URLSearchParams();
    if (language) params.set("language", language);
    if (provider) params.set("provider", provider);
    if (assistantName) params.set("assistantName", assistantName);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${BASE_URL}/jack/transcribe${qs}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: audio,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as JackApiErrorBody;
      const error = new JackApiError(res.status, detail);
      if (!detail.requiresConsent || !fallbackConsentHandler) throw error;
      const choice = await requestFallbackChoice(fallbackConsentHandler, {
        kind: "asr",
        failedProvider: (detail.provider as AsrProviderId | undefined) ?? provider ?? "whisper",
        options: (detail.fallbackOptions ?? []) as AsrProviderId[],
        detail: error.message,
        credentialRequired: detail.credentialRequired,
      });
      if (!choice) throw error;
      return jackApi.transcribeAudioOnce(audio, language, choice as AsrProviderId, assistantName, provider ?? "whisper");
    }
    const result = await res.json() as JackTranscribeResult;
    providerStatusHandler?.({ kind: "asr", selectedProvider: provider ?? "whisper", actualProvider: result.actualProvider ?? result.provider, fallbackUsed: result.fallbackUsed ?? false, fallbackFrom: result.fallbackFrom });
    return result;
  },

  /** One bounded consent-authorized retry. Kept separate so it cannot recurse. */
  async transcribeAudioOnce(audio: Blob, language: string | undefined, provider: AsrProviderId, assistantName: string | undefined, selectedProvider: AsrProviderId): Promise<JackTranscribeResult> {
    const params = new URLSearchParams({ provider });
    if (language) params.set("language", language);
    if (assistantName) params.set("assistantName", assistantName);
    const res = await fetch(`${BASE_URL}/jack/transcribe?${params.toString()}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: audio, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new JackApiError(res.status, await res.json().catch(() => ({})) as JackApiErrorBody);
    const result = await res.json() as JackTranscribeResult;
    providerStatusHandler?.({ kind: "asr", selectedProvider, actualProvider: result.actualProvider ?? result.provider, fallbackUsed: true, fallbackFrom: selectedProvider });
    return result;
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

  /**
   * BYOK credential management (multi-provider AI milestone). The API key
   * is only ever sent TO the gateway (saveCredential's request body) --
   * every response from these four methods is a CredentialStatusReport,
   * which structurally cannot carry the full key (only `lastFour`). This
   * client never stores a raw key anywhere (no localStorage, no React
   * state) beyond the moment a Settings form submits it.
   */
  async getCredentialStatus(): Promise<Record<CredentialProviderId, CredentialStatusReport>> {
    const res = await fetch(`${BASE_URL}/jack/credentials`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Failed to fetch credential status: ${res.status}`);
    return res.json();
  },

  saveCredential(provider: CredentialProviderId, apiKey: string): Promise<CredentialStatusReport> {
    return postJson<CredentialStatusReport>(`/jack/credentials/${provider}`, { apiKey }, 15_000);
  },

  async removeCredential(provider: CredentialProviderId): Promise<CredentialStatusReport> {
    const res = await fetch(`${BASE_URL}/jack/credentials/${provider}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
      throw new Error(detail?.detail || `Failed to remove credential: ${res.status}`);
    }
    return res.json();
  },

  async testCredential(provider: CredentialProviderId): Promise<CredentialStatusReport> {
    const res = await fetch(`${BASE_URL}/jack/credentials/${provider}/test`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
      throw new Error(detail?.detail || `Connection test failed: ${res.status}`);
    }
    return res.json();
  },
};

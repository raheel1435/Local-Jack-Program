export type ProviderStatus = "available" | "unavailable";

export type LlmProviderName = "colibri" | "llamacpp";

/** Stable ASR engine ids. "whisper" is APPROVED (default everywhere);
 * "vibevoice" is TEST (opt-in only, never a silent fallback target). */
export type AsrProviderId = "whisper" | "vibevoice";

export interface HealthReport {
  gateway: "ok";
  colibri: ProviderStatus;
  llamacpp: ProviderStatus;
  whisper: ProviderStatus;
  vibevoice: ProviderStatus;
  kokoro: ProviderStatus;
  activeLlmProvider: LlmProviderName;
}

export interface JackChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JackChatRequest {
  messages: JackChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  /** GBNF grammar for constrained/structured output. Only honored by
   * providers that support it (e.g. llama.cpp); ignored otherwise. */
  grammar?: string;
}

export interface JackChatResponse {
  content: string;
  model: string;
  latencyMs: number;
  raw: unknown;
}

/** Structural interface implemented by every local LLM provider so routes
 * and the intent router can depend on a provider without knowing its
 * concrete runtime (Colibri, llama.cpp, ...). */
export interface LlmProvider {
  checkHealth(): Promise<ProviderStatus>;
  chat(req: JackChatRequest): Promise<JackChatResponse>;
}

/** Normalized result shape shared by every ASR provider, so callers never
 * need engine-specific handling. `metadata` carries provider-specific
 * extras (e.g. VibeVoice's raw language/code-switching info) without
 * forcing them into the common fields. */
export interface JackTranscribeResponse {
  text: string;
  provider: AsrProviderId;
  latencyMs: number;
  language?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

/** Structural interface every ASR provider implements, so routes depend on
 * this shape rather than a concrete engine (mirrors LlmProvider). */
export interface AsrProvider {
  readonly id: AsrProviderId;
  readonly name: string;
  checkHealth(): Promise<ProviderStatus>;
  transcribe(
    audioFilePath: string,
    language?: string,
    opts?: { hotwords?: string[] }
  ): Promise<JackTranscribeResponse>;
}

export interface JackSpeakRequest {
  text: string;
  voice?: string;
}

export interface JackErrorResponse {
  error: string;
  detail?: string;
}

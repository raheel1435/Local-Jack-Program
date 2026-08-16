export type ProviderStatus = "available" | "unavailable";

export type LlmProviderName = "colibri" | "llamacpp";

export interface HealthReport {
  gateway: "ok";
  colibri: ProviderStatus;
  llamacpp: ProviderStatus;
  whisper: ProviderStatus;
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

export interface JackTranscribeRequest {
  /** Absolute path to a local audio file (wav) already on disk. */
  audioFilePath: string;
  language?: string;
}

export interface JackTranscribeResponse {
  text: string;
  latencyMs: number;
}

export interface JackSpeakRequest {
  text: string;
  voice?: string;
}

export interface JackErrorResponse {
  error: string;
  detail?: string;
}

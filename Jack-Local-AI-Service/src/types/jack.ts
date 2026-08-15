export type ProviderStatus = "available" | "unavailable";

export interface HealthReport {
  gateway: "ok";
  colibri: ProviderStatus;
  whisper: ProviderStatus;
  kokoro: ProviderStatus;
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
}

export interface JackChatResponse {
  content: string;
  model: string;
  latencyMs: number;
  raw: unknown;
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

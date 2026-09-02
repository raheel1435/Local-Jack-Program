import type { LlmProviderName } from "../types/jack.js";

function readLlmProvider(): LlmProviderName {
  return process.env.JACK_LLM_PROVIDER === "colibri" ? "colibri" : "llamacpp";
}

function readPort(): number {
  const raw = process.env.JACK_LOCAL_PORT;
  if (raw === undefined || raw.trim() === "") return 43110;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `Invalid JACK_LOCAL_PORT "${raw}" -- must be an integer between 1 and 65535.`,
    );
  }
  return parsed;
}

// This gateway is a machine-local dev service: bound to loopback only by
// default (security-boundary hardening -- a prior audit confirmed the
// previous unbound app.listen() accepted connections on every network
// interface, not just this machine). Override only if you understand the
// exposure this creates.
function readHost(): string {
  const raw = process.env.JACK_LOCAL_HOST;
  return raw && raw.trim() ? raw.trim() : "127.0.0.1";
}

// CORS allowlist (security-boundary hardening): the gateway used to reflect
// ANY request Origin back in Access-Control-Allow-Origin, which let any web
// page open in the browser -- not just this app's own dev server -- drive
// local LLM/STT/TTS compute. Only origins in this list (or none, e.g. a
// same-machine CLI/test client with no Origin header) are allowed. Vite's
// default dev port (5173) on both localhost and 127.0.0.1 is included so a
// fresh checkout works with no .env changes.
function readAllowedOrigins(): string[] {
  const raw = process.env.JACK_ALLOWED_ORIGINS;
  if (raw && raw.trim()) {
    return raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  }
  return ["http://localhost:5173", "http://127.0.0.1:5173"];
}

export const config = {
  port: readPort(),
  host: readHost(),
  allowedOrigins: readAllowedOrigins(),

  // Which local LLM provider backs /jack/chat and the intent router's LLM
  // fallback. Both providers are always constructed (health-checked, and
  // selectable per-request isn't supported) -- this just picks the default.
  llmProvider: readLlmProvider(),

  colibriBaseUrl: process.env.COLIBRI_BASE_URL ?? "http://127.0.0.1:8000",
  colibriModelId: process.env.COLIBRI_MODEL_ID ?? "colibri",

  llamacppBaseUrl: process.env.LLAMACPP_BASE_URL ?? "http://127.0.0.1:8081",

  kokoroBaseUrl: process.env.KOKORO_BASE_URL ?? "http://127.0.0.1:8880",

  whisperExecutablePath: process.env.WHISPER_EXECUTABLE_PATH ?? "",
  whisperModelPath: process.env.WHISPER_MODEL_PATH ?? "",

  // VibeVoice-ASR-BitNet (TEST engine, via VibeASR.cpp's asr_infer CLI).
  // Never used unless a request explicitly asks for provider "vibevoice" --
  // see routes/transcription.ts. All three paths live outside git tracking
  // (VibeASR.cpp/build/ and the GGUF weights in llm-models/vibeasr/).
  vibeAsrExecutablePath: process.env.VIBE_ASR_EXECUTABLE_PATH ?? "",
  vibeAsrVaeModelPath: process.env.VIBE_ASR_VAE_MODEL_PATH ?? "",
  vibeAsrLmModelPath: process.env.VIBE_ASR_LM_MODEL_PATH ?? "",
  // Persistent, officially-supported streaming server build (asr_stream_server.exe,
  // "loads models once, processes audio via stdin") -- see VibeWarmServer.ts
  // and VibeVoiceTestConfig.warmRuntime. Same build directory as asr_infer.exe.
  vibeAsrStreamServerExecutablePath: process.env.VIBE_ASR_STREAM_SERVER_EXECUTABLE_PATH ?? "",

  // Multi-provider AI milestone: OpenAI/Anthropic as BYOK AI-brain
  // providers. These are model DEFAULTS only, not secrets -- the API keys
  // themselves live in CredentialStore (DPAPI-encrypted, outside git),
  // never here. gpt-4o-mini / claude-haiku-4-5 are fast/cheap tiers,
  // matching the local providers' role (short narration text, structured
  // intent-classification JSON under chat.ts's 512-token cap) rather than
  // a general-purpose "biggest model" default.
  openaiDefaultModel: process.env.OPENAI_DEFAULT_MODEL ?? "gpt-4o-mini",
  anthropicDefaultModel: process.env.ANTHROPIC_DEFAULT_MODEL ?? "claude-haiku-4-5",
  anthropicMaxTokensDefault: Number(process.env.ANTHROPIC_MAX_TOKENS_DEFAULT ?? "1024"),

  // Stage 2 (OpenAI Speech ASR): a DISTINCT model from openaiDefaultModel
  // above -- that one is the chat/completions model for the AI-brain axis,
  // this one is the /v1/audio/transcriptions model for the ASR axis. Default
  // confirmed current via the openai-node SDK source (2026-09-02): a valid
  // AudioModel value, and -- unlike whisper-1 -- fast/cheap, matching this
  // engine's role (short command/narration-adjacent utterances) rather than
  // a general-purpose "most accurate" default.
  openaiTranscriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe",
};

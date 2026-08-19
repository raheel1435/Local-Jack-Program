import type { LlmProviderName } from "../types/jack.js";

function readLlmProvider(): LlmProviderName {
  return process.env.JACK_LLM_PROVIDER === "colibri" ? "colibri" : "llamacpp";
}

export const config = {
  port: Number(process.env.JACK_LOCAL_PORT ?? 43110),

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
};

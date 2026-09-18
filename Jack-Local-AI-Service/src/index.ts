import "dotenv/config";
import express from "express";
import { config } from "./config/services.js";
import { ColibriProvider } from "./providers/colibri/ColibriProvider.js";
import { LlamaCppProvider } from "./providers/llamacpp/LlamaCppProvider.js";
import { WhisperProvider } from "./providers/whisper/WhisperProvider.js";
import { VibeAsrProvider } from "./providers/vibe/VibeAsrProvider.js";
import { KokoroProvider } from "./providers/kokoro/KokoroProvider.js";
import { OpenAiProvider } from "./providers/openai/OpenAiProvider.js";
import { OpenAiSpeechProvider } from "./providers/openai/OpenAiSpeechProvider.js";
import { AnthropicProvider } from "./providers/anthropic/AnthropicProvider.js";
import { healthRouter } from "./routes/health.js";
import { chatRouter, type LlmProviderRegistry } from "./routes/chat.js";
import { intentRouter } from "./routes/intent.js";
import { speechRouter } from "./routes/speech.js";
import { transcriptionRouter } from "./routes/transcription.js";
import { pptxConvertRouter } from "./routes/pptxConvert.js";
import { credentialsRouter } from "./routes/credentials.js";
import { CredentialStore } from "./lib/credentialStore.js";
import { AdmissionGate } from "./lib/admission.js";
import { LocalRuntimeManager } from "./lib/LocalRuntimeManager.js";
import { KokoroRuntimeManager } from "./lib/KokoroRuntimeManager.js";
import type { AiBrainSelector, LlmProvider } from "./types/jack.js";

const app = express();
app.use(express.json());
// Raw binary audio uploads for POST /jack/transcribe (browser microphone
// capture). Only activates for audio/* content types; JSON requests to the
// same route (the pre-existing audioFilePath contract) are unaffected.
app.use(express.raw({ type: ["audio/wav", "audio/wave", "audio/x-wav"], limit: "25mb" }));
// PPTX parsing is route-local and occurs only after that route's admission
// middleware accepts the request. Keeping a 100 MB raw parser here would
// buffer rejected concurrent uploads before the route could return 429.

// Minimal CORS: this gateway is a machine-local dev service consumed
// directly by the browser-based Jack-AI-Presenter-Platform frontend, which
// runs on a different origin (Vite dev server). Security-boundary hardening:
// only reflect an Origin that's actually on the configured allowlist
// (config.allowedOrigins, default the Vite dev server's own origin) --
// reflecting ANY origin previously let any web page open in the same
// browser drive local LLM/STT/TTS compute with no restriction. A request
// with no Origin header (same-machine CLI/test client) is left unrestricted,
// same as before -- CORS only governs browser-issued cross-origin requests.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Both providers are always constructed and health-checked (see /health),
// but only one backs /jack/chat and /jack/intent's LLM fallback at a time --
// selected via JACK_LLM_PROVIDER. Colibri remains available as a fallback/
// reference runtime even when llama.cpp is the active brain.
const colibri = new ColibriProvider();
const llamacpp = new LlamaCppProvider();
const activeLlm: LlmProvider = config.llmProvider === "colibri" ? colibri : llamacpp;
const fallbackLlm: LlmProvider = config.llmProvider === "colibri" ? llamacpp : colibri;

// Auto-start milestone: Local AI must be available by default, not
// something the user has to start with a manual PowerShell command first.
// This only ensures a llama-server process exists and is healthy --
// LlamaCppProvider above still does every actual chat/health request
// exactly as before, whether that server was just launched here or was
// already running. Colibri is intentionally left untouched (external-only,
// per this milestone's own scope): it stays available as the existing
// fallback/reference runtime if the user has started it separately.
const localRuntimeManager = new LocalRuntimeManager();
console.log("Starting Local AI...");
void localRuntimeManager.ensureReady().then((status) => {
  if (status.state === "ready") {
    console.log(`Local AI Ready (llama-server${status.ownedByJack ? ", started by Jack" : ", already running"}).`);
  } else {
    console.warn(`Local AI is not ready yet: ${status.detail ?? status.state}`);
  }
});

const whisper = new WhisperProvider();
// VibeAsrProvider (TEST engine) is always constructed and health-checked,
// same as the LLM providers above -- but never invoked unless a request
// explicitly asks for provider "vibevoice". Approved (Whisper) stays the
// default for every route and every UI surface.
const vibevoice = new VibeAsrProvider();
const kokoro = new KokoroProvider();

// Auto-start milestone, extended to TTS: same reasoning as
// LocalRuntimeManager above, applied to Kokoro-FastAPI. KokoroProvider still
// does every actual /jack/speak request exactly as before; this only makes
// sure something is listening at kokoroBaseUrl first.
const kokoroRuntimeManager = new KokoroRuntimeManager();
console.log("Starting Kokoro TTS...");
void kokoroRuntimeManager.ensureReady().then((status) => {
  if (status.state === "ready") {
    console.log(`Kokoro TTS Ready${status.ownedByJack ? " (started by Jack)" : " (already running)"}.`);
  } else {
    console.warn(`Kokoro TTS is not ready yet: ${status.detail ?? status.state}`);
  }
});

// Multi-provider AI milestone: OpenAI/Anthropic as BYOK AI-brain providers,
// always constructed and health-checked (same pattern as colibri/llamacpp
// above), selected per-request via `aiProvider` rather than one fixed
// choice at boot -- see LlmProviderRegistry's own doc comment in chat.ts.
const credentialStore = new CredentialStore();
const openaiProvider = new OpenAiProvider(credentialStore);
const anthropicProvider = new AnthropicProvider(credentialStore);
// Stage 2 (OpenAI Speech ASR): a THIRD ASR engine alongside whisper/vibevoice
// below, sharing the same "openai" CredentialStore entry as openaiProvider
// above -- one BYOK key, two independent uses (AI brain vs. ASR). Always
// constructed and health-checked, same pattern as every other provider here;
// never invoked unless a request explicitly asks for provider "openai" on
// /jack/transcribe.
const openaiSpeechProvider = new OpenAiSpeechProvider(credentialStore);
const llmProviders: LlmProviderRegistry = {
  local: activeLlm,
  localFallback: fallbackLlm,
  localProviderName: config.llmProvider,
  localFallbackProviderName: config.llmProvider === "colibri" ? "llamacpp" : "colibri",
  openai: openaiProvider,
  anthropic: anthropicProvider,
};
// Closes a real gap: chatRouter/intentRouter previously had zero
// concurrency bound, fine for local-only compute but not for paid APIs
// where uncontrolled fan-out means runaway billing. `local` intentionally
// keeps its current zero-gate behavior (no entry in this map).
const cloudGates: Partial<Record<AiBrainSelector, AdmissionGate>> = {
  openai: new AdmissionGate(2, 4),
  anthropic: new AdmissionGate(2, 4),
};

app.use(healthRouter(colibri, llamacpp, whisper, kokoro, vibevoice, openaiProvider, anthropicProvider));
app.use(chatRouter(llmProviders, cloudGates, credentialStore));
app.use(intentRouter(llmProviders, cloudGates, credentialStore));
app.use(credentialsRouter(credentialStore));
app.use(speechRouter(kokoro));
app.use(transcriptionRouter(whisper, vibevoice, openaiSpeechProvider, credentialStore));
app.use(pptxConvertRouter());

const server = app.listen(config.port, config.host, () => {
  console.log(
    `Jack-Local-AI-Service listening on http://${config.host}:${config.port} (llm provider: ${config.llmProvider})`
  );
});

// CLAUDE-35 fix: the gateway previously had no shutdown hook at all -- if it
// was stopped (Ctrl+C, taskkill, IDE restart) while VibeWarmServer's child
// (asr_stream_server.exe, holding ~1.58GB of loaded GGUF weights) was alive,
// nothing explicitly terminated it first.
function shutdown() {
  vibevoice.stop();
  // Only stops a llama-server process Jack itself launched -- an externally
  // started one (already running before Jack booted) is left alone, per
  // LocalRuntimeManager's own ownership rule.
  localRuntimeManager.stop();
  // Same ownership rule as llama-server above -- only a Jack-owned Kokoro
  // process is stopped here.
  kokoroRuntimeManager.stop();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

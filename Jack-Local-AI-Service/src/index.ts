import "dotenv/config";
import express from "express";
import { config } from "./config/services.js";
import { ColibriProvider } from "./providers/colibri/ColibriProvider.js";
import { LlamaCppProvider } from "./providers/llamacpp/LlamaCppProvider.js";
import { WhisperProvider } from "./providers/whisper/WhisperProvider.js";
import { KokoroProvider } from "./providers/kokoro/KokoroProvider.js";
import { healthRouter } from "./routes/health.js";
import { chatRouter } from "./routes/chat.js";
import { intentRouter } from "./routes/intent.js";
import { speechRouter } from "./routes/speech.js";
import { transcriptionRouter } from "./routes/transcription.js";
import type { LlmProvider } from "./types/jack.js";

const app = express();
app.use(express.json());
// Raw binary audio uploads for POST /jack/transcribe (browser microphone
// capture). Only activates for audio/* content types; JSON requests to the
// same route (the pre-existing audioFilePath contract) are unaffected.
app.use(express.raw({ type: ["audio/wav", "audio/wave", "audio/x-wav"], limit: "25mb" }));

// Minimal CORS: this gateway is a machine-local dev service consumed
// directly by the browser-based Jack-AI-Presenter-Platform frontend, which
// runs on a different origin (Vite dev server). Reflect the request origin
// rather than "*" so credentials/cookies remain usable if ever needed, and
// short-circuit the preflight -- no external CORS package required for this.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
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

const whisper = new WhisperProvider();
const kokoro = new KokoroProvider();

app.use(healthRouter(colibri, llamacpp, whisper, kokoro));
app.use(chatRouter(activeLlm));
app.use(intentRouter(activeLlm));
app.use(speechRouter(kokoro));
app.use(transcriptionRouter(whisper));

app.listen(config.port, () => {
  console.log(
    `Jack-Local-AI-Service listening on http://127.0.0.1:${config.port} (llm provider: ${config.llmProvider})`
  );
});

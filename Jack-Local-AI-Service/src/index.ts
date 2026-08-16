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

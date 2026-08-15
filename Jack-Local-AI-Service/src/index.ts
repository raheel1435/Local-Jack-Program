import "dotenv/config";
import express from "express";
import { config } from "./config/services.js";
import { ColibriProvider } from "./providers/colibri/ColibriProvider.js";
import { WhisperProvider } from "./providers/whisper/WhisperProvider.js";
import { KokoroProvider } from "./providers/kokoro/KokoroProvider.js";
import { healthRouter } from "./routes/health.js";
import { chatRouter } from "./routes/chat.js";
import { speechRouter } from "./routes/speech.js";
import { transcriptionRouter } from "./routes/transcription.js";

const app = express();
app.use(express.json());

const colibri = new ColibriProvider();
const whisper = new WhisperProvider();
const kokoro = new KokoroProvider();

app.use(healthRouter(colibri, whisper, kokoro));
app.use(chatRouter(colibri));
app.use(speechRouter(kokoro));
app.use(transcriptionRouter(whisper));

app.listen(config.port, () => {
  console.log(`Jack-Local-AI-Service listening on http://127.0.0.1:${config.port}`);
});

import { Router } from "express";
import { config } from "../config/services.js";
import { ColibriProvider } from "../providers/colibri/ColibriProvider.js";
import { LlamaCppProvider } from "../providers/llamacpp/LlamaCppProvider.js";
import { WhisperProvider } from "../providers/whisper/WhisperProvider.js";
import { KokoroProvider } from "../providers/kokoro/KokoroProvider.js";
import type { AsrProvider, HealthReport } from "../types/jack.js";

export function healthRouter(
  colibri: ColibriProvider,
  llamacpp: LlamaCppProvider,
  whisper: WhisperProvider,
  kokoro: KokoroProvider,
  vibevoice: AsrProvider
): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    // Each provider is checked independently and in parallel -- one being
    // down (e.g. the Test engine's model not downloaded) never marks the
    // gateway or any other provider unavailable.
    const [colibriStatus, llamacppStatus, whisperStatus, vibevoiceStatus, kokoroStatus] =
      await Promise.all([
        colibri.checkHealth(),
        llamacpp.checkHealth(),
        whisper.checkHealth(),
        vibevoice.checkHealth(),
        kokoro.checkHealth(),
      ]);

    const report: HealthReport = {
      gateway: "ok",
      colibri: colibriStatus,
      llamacpp: llamacppStatus,
      whisper: whisperStatus,
      vibevoice: vibevoiceStatus,
      kokoro: kokoroStatus,
      activeLlmProvider: config.llmProvider,
    };

    res.json(report);
  });

  return router;
}

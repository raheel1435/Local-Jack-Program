import { Router } from "express";
import { config } from "../config/services.js";
import { ColibriProvider } from "../providers/colibri/ColibriProvider.js";
import { LlamaCppProvider } from "../providers/llamacpp/LlamaCppProvider.js";
import { WhisperProvider } from "../providers/whisper/WhisperProvider.js";
import { KokoroProvider } from "../providers/kokoro/KokoroProvider.js";
import type { HealthReport } from "../types/jack.js";

export function healthRouter(
  colibri: ColibriProvider,
  llamacpp: LlamaCppProvider,
  whisper: WhisperProvider,
  kokoro: KokoroProvider
): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const [colibriStatus, llamacppStatus, whisperStatus, kokoroStatus] =
      await Promise.all([
        colibri.checkHealth(),
        llamacpp.checkHealth(),
        whisper.checkHealth(),
        kokoro.checkHealth(),
      ]);

    const report: HealthReport = {
      gateway: "ok",
      colibri: colibriStatus,
      llamacpp: llamacppStatus,
      whisper: whisperStatus,
      kokoro: kokoroStatus,
      activeLlmProvider: config.llmProvider,
    };

    res.json(report);
  });

  return router;
}

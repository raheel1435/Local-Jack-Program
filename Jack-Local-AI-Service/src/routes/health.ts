import { Router } from "express";
import { ColibriProvider } from "../providers/colibri/ColibriProvider.js";
import { WhisperProvider } from "../providers/whisper/WhisperProvider.js";
import { KokoroProvider } from "../providers/kokoro/KokoroProvider.js";
import type { HealthReport } from "../types/jack.js";

export function healthRouter(
  colibri: ColibriProvider,
  whisper: WhisperProvider,
  kokoro: KokoroProvider
): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const [colibriStatus, whisperStatus, kokoroStatus] = await Promise.all([
      colibri.checkHealth(),
      whisper.checkHealth(),
      kokoro.checkHealth(),
    ]);

    const report: HealthReport = {
      gateway: "ok",
      colibri: colibriStatus,
      whisper: whisperStatus,
      kokoro: kokoroStatus,
    };

    res.json(report);
  });

  return router;
}

import { Router } from "express";
import { config } from "../config/services.js";
import { ColibriProvider } from "../providers/colibri/ColibriProvider.js";
import { LlamaCppProvider } from "../providers/llamacpp/LlamaCppProvider.js";
import { WhisperProvider } from "../providers/whisper/WhisperProvider.js";
import { KokoroProvider } from "../providers/kokoro/KokoroProvider.js";
import type { AsrProvider, HealthReport, LlmProvider } from "../types/jack.js";

export function healthRouter(
  colibri: ColibriProvider,
  llamacpp: LlamaCppProvider,
  whisper: WhisperProvider,
  kokoro: KokoroProvider,
  vibevoice: AsrProvider,
  openai: LlmProvider,
  anthropic: LlmProvider,
): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    // Each provider is checked independently and in parallel -- one being
    // down (e.g. the Test engine's model not downloaded, or a BYOK provider
    // with no key configured) never marks the gateway or any other
    // provider unavailable.
    const [colibriStatus, llamacppStatus, whisperStatus, vibevoiceStatus, kokoroStatus, openaiStatus, anthropicStatus] =
      await Promise.all([
        colibri.checkHealth(),
        llamacpp.checkHealth(),
        whisper.checkHealth(),
        vibevoice.checkHealth(),
        kokoro.checkHealth(),
        openai.checkHealth(),
        anthropic.checkHealth(),
      ]);

    const report: HealthReport = {
      gateway: "ok",
      colibri: colibriStatus,
      llamacpp: llamacppStatus,
      whisper: whisperStatus,
      vibevoice: vibevoiceStatus,
      kokoro: kokoroStatus,
      openai: openaiStatus,
      anthropic: anthropicStatus,
      activeLlmProvider: config.llmProvider,
    };

    res.json(report);
  });

  return router;
}

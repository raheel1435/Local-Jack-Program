import { Router } from "express";
import { KokoroProvider } from "../providers/kokoro/KokoroProvider.js";
import {
  isNonEmptyStringWithinLimit,
  isOptionalStringWithinLimit,
  MAX_ASSISTANT_NAME_LENGTH,
  MAX_SPEAK_TEXT_LENGTH,
} from "../lib/requestValidation.js";
import type { JackErrorResponse, JackSpeakRequest } from "../types/jack.js";

export function speechRouter(kokoro: KokoroProvider): Router {
  const router = Router();

  router.post("/jack/speak", async (req, res) => {
    const body = req.body as Partial<JackSpeakRequest>;
    if (!isNonEmptyStringWithinLimit(body.text, MAX_SPEAK_TEXT_LENGTH)) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: `Request body must include a non-empty \`text\` string of at most ${MAX_SPEAK_TEXT_LENGTH} characters.`,
      };
      res.status(400).json(err);
      return;
    }
    if (!isOptionalStringWithinLimit(body.voice, MAX_ASSISTANT_NAME_LENGTH)) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: `\`voice\`, when provided, must be a string of at most ${MAX_ASSISTANT_NAME_LENGTH} characters.`,
      };
      res.status(400).json(err);
      return;
    }

    const status = await kokoro.checkHealth();
    if (status === "unavailable") {
      const err: JackErrorResponse = {
        error: "kokoro_unavailable",
        detail:
          "Kokoro-FastAPI is not reachable at the configured KOKORO_BASE_URL.",
      };
      res.status(503).json(err);
      return;
    }

    try {
      const result = await kokoro.speak(body.text, body.voice);
      res.setHeader("Content-Type", result.contentType);
      res.setHeader("X-Latency-Ms", String(result.latencyMs));
      res.send(result.audio);
    } catch (e) {
      const err: JackErrorResponse = {
        error: "kokoro_request_failed",
        detail: e instanceof Error ? e.message : String(e),
      };
      res.status(502).json(err);
    }
  });

  return router;
}

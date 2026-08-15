import { Router } from "express";
import { ColibriProvider } from "../providers/colibri/ColibriProvider.js";
import type { JackChatRequest, JackErrorResponse } from "../types/jack.js";

export function chatRouter(colibri: ColibriProvider): Router {
  const router = Router();

  router.post("/jack/chat", async (req, res) => {
    const body = req.body as Partial<JackChatRequest>;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: "Request body must include a non-empty `messages` array.",
      };
      res.status(400).json(err);
      return;
    }

    const status = await colibri.checkHealth();
    if (status === "unavailable") {
      const err: JackErrorResponse = {
        error: "colibri_unavailable",
        detail:
          "Colibri's OpenAI-compatible server is not reachable. Start it with `coli serve --model <model-path>`.",
      };
      res.status(503).json(err);
      return;
    }

    try {
      const result = await colibri.chat(body as JackChatRequest);
      res.json(result);
    } catch (e) {
      const err: JackErrorResponse = {
        error: "colibri_request_failed",
        detail: e instanceof Error ? e.message : String(e),
      };
      res.status(502).json(err);
    }
  });

  return router;
}

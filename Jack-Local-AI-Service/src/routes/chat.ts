import { Router } from "express";
import type {
  JackChatRequest,
  JackErrorResponse,
  LlmProvider,
} from "../types/jack.js";

export function chatRouter(llm: LlmProvider): Router {
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

    const status = await llm.checkHealth();
    if (status === "unavailable") {
      const err: JackErrorResponse = {
        error: "llm_unavailable",
        detail:
          "The configured local LLM provider is not reachable. Start Colibri (`coli serve --model <model-path>`) or llama-server, matching JACK_LLM_PROVIDER.",
      };
      res.status(503).json(err);
      return;
    }

    try {
      const result = await llm.chat(body as JackChatRequest);
      res.json(result);
    } catch (e) {
      const err: JackErrorResponse = {
        error: "llm_request_failed",
        detail: e instanceof Error ? e.message : String(e),
      };
      res.status(502).json(err);
    }
  });

  return router;
}

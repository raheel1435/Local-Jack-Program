import { Router } from "express";
import { matchDeterministicCommand } from "../intent/commandRouter.js";
import { ACTION_GRAMMAR, ACTION_SYSTEM_PROMPT } from "../intent/actionGrammar.js";
import type { JackErrorResponse, LlmProvider } from "../types/jack.js";

interface JackIntentRequest {
  text: string;
}

export function intentRouter(llm: LlmProvider): Router {
  const router = Router();

  router.post("/jack/intent", async (req, res) => {
    const body = req.body as Partial<JackIntentRequest>;
    if (!body.text || typeof body.text !== "string") {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: "Request body must include a non-empty `text` string.",
      };
      res.status(400).json(err);
      return;
    }

    const start = Date.now();
    const deterministic = matchDeterministicCommand(body.text);
    if (deterministic) {
      res.json({
        source: "deterministic",
        action: deterministic.action,
        target: deterministic.target,
        latencyMs: Date.now() - start,
      });
      return;
    }

    const status = await llm.checkHealth();
    if (status === "unavailable") {
      const err: JackErrorResponse = {
        error: "llm_unavailable",
        detail:
          "No deterministic match, and the configured local LLM provider is not reachable.",
      };
      res.status(503).json(err);
      return;
    }

    try {
      const result = await llm.chat({
        messages: [
          { role: "system", content: ACTION_SYSTEM_PROMPT },
          { role: "user", content: body.text },
        ],
        max_tokens: 40,
        temperature: 0,
        grammar: ACTION_GRAMMAR,
      });

      let action: string | undefined;
      let target: string | undefined;
      try {
        const parsed = JSON.parse(result.content.trim()) as {
          action?: string;
          target?: string;
        };
        action = parsed.action;
        target = parsed.target;
      } catch {
        // fall through with action left undefined -- caller sees raw content
      }

      res.json({
        source: "llm",
        action,
        target,
        raw: result.content,
        latencyMs: Date.now() - start,
      });
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

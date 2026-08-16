import { Router } from "express";
import { matchDeterministicCommand, type IntentType } from "../intent/commandRouter.js";
import { ACTION_GRAMMAR, ACTION_SYSTEM_PROMPT } from "../intent/actionGrammar.js";
import type { JackErrorResponse, LlmProvider } from "../types/jack.js";

interface JackIntentRequest {
  text: string;
}

const VALID_ACTIONS = new Set([
  "start_presentation",
  "next_slide",
  "previous_slide",
  "jump_to_slide",
  "pause_presentation",
  "resume_presentation",
  "explain_slide",
  "summarize_slide",
  "handoff_to_presenter",
  "stop_presentation",
]);

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
        type: deterministic.type,
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

      let type: IntentType = "unknown";
      let action: string | undefined;
      let target: string | undefined;
      try {
        const parsed = JSON.parse(result.content.trim()) as {
          type?: string;
          action?: string;
          target?: string;
        };
        // Safety boundary enforced here, not just by grammar/prompt: an
        // `action` is only ever honored when the model's own `type` is
        // "action" AND that action is one of the known ten. Anything else
        // -- including a model bug that fills `action` on a conversation/
        // unknown classification -- is discarded server-side before it
        // ever reaches a client that might act on it.
        if (parsed.type === "action" && typeof parsed.action === "string" && VALID_ACTIONS.has(parsed.action)) {
          type = "action";
          action = parsed.action;
          target = typeof parsed.target === "string" ? parsed.target : undefined;
        } else if (parsed.type === "conversation") {
          type = "conversation";
        } else {
          type = "unknown";
        }
      } catch {
        // Unparseable model output -- fail safe as "unknown", never as an action.
        type = "unknown";
      }

      res.json({
        source: "llm",
        type,
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

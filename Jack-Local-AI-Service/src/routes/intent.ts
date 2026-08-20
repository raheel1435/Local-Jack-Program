import { Router } from "express";
import { matchDeterministicCommand, type IntentType } from "../intent/commandRouter.js";
import { classifyAddress, hasSuspiciousRepetition } from "../intent/addressing.js";
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

// WHISPER SAFETY CORRECTION milestone, Part 16: presentation-state-changing
// actions the LLM fallback must not be allowed to fire on weak evidence --
// deliberately excludes explain_slide/summarize_slide, which are read-only
// and can't exit/derail a presentation the way these can. This is exactly
// Codex's reproduced incident's action (stop_presentation), reached via this
// same fallback because the hallucinated repeated-"Jack" transcript doesn't
// match any anchored commandRouter.ts pattern.
const HIGH_IMPACT_ACTIONS = new Set([
  "start_presentation",
  "next_slide",
  "previous_slide",
  "jump_to_slide",
  "pause_presentation",
  "resume_presentation",
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

      // WHISPER SAFETY CORRECTION milestone, Part 16/17: an LLM-INFERRED
      // high-impact action gets a stronger evidence bar than a deterministic
      // one -- deterministic matches above already returned early, so
      // everything reaching here came from the model's own (looser)
      // classification. Downgrade to "conversation" -- never silently drop
      // to "unknown", Jack should still be able to respond -- unless the
      // utterance both (a) genuinely addresses Jack directly, not just
      // mentions him, and (b) doesn't show the suspicious-repetition
      // hallmark of an ASR hallucination loop (his name appearing 2+ times
      // in one utterance -- see addressing.ts's hasSuspiciousRepetition
      // comment for why that specific signal, not "any repeated word",
      // distinguishes Codex's reproduced false stop from a real urgent
      // "Jack, stop, stop, stop!").
      let downgradedFrom: string | undefined;
      if (type === "action" && action && HIGH_IMPACT_ACTIONS.has(action)) {
        const address = classifyAddress(body.text);
        const suspicious = hasSuspiciousRepetition(body.text);
        if (address !== "direct" || suspicious) {
          downgradedFrom = action;
          type = "conversation";
          action = undefined;
          target = undefined;
        }
      }

      res.json({
        source: "llm",
        type,
        action,
        target,
        downgradedFrom,
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

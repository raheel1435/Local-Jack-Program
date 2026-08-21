import { Router } from "express";
import { matchDeterministicCommand, type IntentType } from "../intent/commandRouter.js";
import { classifyAddress, hasSuspiciousRepetition } from "../intent/addressing.js";
import { ACTION_GRAMMAR, buildActionSystemPrompt } from "../intent/actionGrammar.js";
import type { JackErrorResponse, LlmProvider } from "../types/jack.js";

interface JackIntentRequest {
  text: string;
  /** Multi-persona milestone: the currently selected assistant name
   * (Bella/Adam/Nova/Sarah/George/Emma/Jack/...) -- defaults to "Jack" when
   * omitted so older/typed-only clients keep working unchanged. */
  assistantName?: string;
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

// WHISPER SAFETY CORRECTION milestone, Part 16, refined by the WHISPER
// FALSE-DESTRUCTIVE-COMMAND ROOT-CAUSE milestone's Part 15: not every
// action has equal cost -- a false stop_presentation ends the whole session,
// a false next_slide is a one-word "back" away from undone. next_slide/
// previous_slide are excluded (Part 15's own LOW-IMPACT list, and genuinely
// a one-command undo). pause_presentation/resume_presentation were
// excluded too in an earlier pass of this milestone, then put back after an
// independent attack review: Jack presents autonomously and unattended, so
// an unguarded false pause -- unlike a false next_slide -- produces silent
// dead air with nobody watching to notice and correct it, which is closer
// to stop_presentation's failure mode than to next_slide's. This gate only
// runs on the LLM-fallback path (ambiguous, non-deterministic matches), so
// genuine fast "Jack, pause."/"Jack, continue." commands -- which match
// commandRouter.ts deterministically -- are completely unaffected either
// way; this only adds friction to ambiguous guesses.
const HIGH_IMPACT_ACTIONS = new Set([
  "start_presentation",
  "pause_presentation",
  "resume_presentation",
  "jump_to_slide",
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

    const assistantName = typeof body.assistantName === "string" && body.assistantName.trim() ? body.assistantName : "Jack";

    const start = Date.now();
    const deterministic = matchDeterministicCommand(body.text, assistantName);
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
          { role: "system", content: buildActionSystemPrompt(assistantName) },
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
        const address = classifyAddress(body.text, assistantName);
        const suspicious = hasSuspiciousRepetition(body.text, assistantName);
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

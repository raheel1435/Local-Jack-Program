import { Router } from "express";
import { matchDeterministicCommand, type IntentType } from "../intent/commandRouter.js";
import { classifyAddress, hasSuspiciousRepetition } from "../intent/addressing.js";
import { ACTION_GRAMMAR, buildActionSystemPrompt } from "../intent/actionGrammar.js";
import {
  isNonEmptyStringWithinLimit,
  isOptionalStringWithinLimit,
  MAX_ASSISTANT_NAME_LENGTH,
  MAX_INTENT_TEXT_LENGTH,
} from "../lib/requestValidation.js";
import { CredentialAuthError } from "../lib/providerErrors.js";
import type { AdmissionGate } from "../lib/admission.js";
import type { CredentialStore } from "../lib/credentialStore.js";
import type { LlmProviderRegistry } from "./chat.js";
import type { AiBrainSelector, JackErrorResponse } from "../types/jack.js";

const VALID_AI_PROVIDERS: ReadonlySet<AiBrainSelector> = new Set(["local", "openai", "anthropic"]);

/** How this text reached Jack. Council engineering audit finding: the
 * HIGH_IMPACT_ACTIONS direct-address downgrade below exists specifically to
 * protect against ambient noise or ASR hallucination triggering a
 * consequential action (see that const's own comment) -- neither risk
 * exists for typed input, where a presenter is deliberately typing directly
 * into a command box with no ambient-audio path at all. Without this field
 * the gateway had no way to know the difference, so "start from slide 7."
 * typed straight into that box was downgraded to a harmless conversational
 * reply exactly as if it were an unaddressed mutter picked up by the mic --
 * confirmed live: Jack summarized slide 7 instead of navigating to it. */
type IntentInputSource = "typed" | "voice" | "interruption";
const VALID_INPUT_SOURCES: ReadonlySet<string> = new Set<IntentInputSource>(["typed", "voice", "interruption"]);

interface JackIntentRequest {
  text: string;
  /** Multi-persona milestone: the currently selected assistant name
   * (Bella/Adam/Nova/Sarah/George/Emma/Jack/...) -- defaults to "Jack" when
   * omitted so older/typed-only clients keep working unchanged. */
  assistantName?: string;
  /** Optional and defaults to the SAFE (address-checked) behavior when
   * omitted or unrecognized -- any existing/future caller that doesn't send
   * this gets exactly today's protected behavior, never silently loosened. */
  inputSource?: IntentInputSource;
  /** Multi-provider AI milestone: which AI brain to use for the LLM-fallback
   * classification (never consulted for a deterministic match). Omitted ->
   * "local" (today's exact behavior). This field is independent of, and has
   * zero effect on, the HIGH_IMPACT_ACTIONS downgrade gate below -- that
   * gate only ever inspects the raw text + assistantName, never which
   * provider produced the classification. */
  aiProvider?: AiBrainSelector;
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

export function intentRouter(
  providers: LlmProviderRegistry,
  gates?: Partial<Record<AiBrainSelector, AdmissionGate>>,
  credentialStore?: CredentialStore,
): Router {
  const router = Router();

  router.post("/jack/intent", async (req, res) => {
    const body = req.body as Partial<JackIntentRequest>;
    if (!isNonEmptyStringWithinLimit(body.text, MAX_INTENT_TEXT_LENGTH)) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: `Request body must include a non-empty \`text\` string of at most ${MAX_INTENT_TEXT_LENGTH} characters.`,
      };
      res.status(400).json(err);
      return;
    }
    if (!isOptionalStringWithinLimit(body.assistantName, MAX_ASSISTANT_NAME_LENGTH)) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: `\`assistantName\`, when provided, must be a string of at most ${MAX_ASSISTANT_NAME_LENGTH} characters.`,
      };
      res.status(400).json(err);
      return;
    }

    const assistantName = typeof body.assistantName === "string" && body.assistantName.trim() ? body.assistantName : "Jack";
    const inputSource: IntentInputSource | undefined =
      typeof body.inputSource === "string" && VALID_INPUT_SOURCES.has(body.inputSource)
        ? (body.inputSource as IntentInputSource)
        : undefined;

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

    // aiProvider is only ever consulted past this point -- a deterministic
    // match above already returned early regardless of its value, and
    // nothing below feeds it into classifyAddress/hasSuspiciousRepetition
    // (see JackIntentRequest's own doc comment on this field).
    if (body.aiProvider !== undefined && (typeof body.aiProvider !== "string" || !VALID_AI_PROVIDERS.has(body.aiProvider as AiBrainSelector))) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: '`aiProvider`, when provided, must be one of "local", "openai", or "anthropic".',
      };
      res.status(400).json(err);
      return;
    }
    const selector: AiBrainSelector = (body.aiProvider as AiBrainSelector | undefined) ?? "local";
    const llm = providers[selector];

    let release: (() => void) | undefined;
    if (selector !== "local" && gates?.[selector]) {
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      req.once("aborted", abort);
      res.once("close", abort);
      const acquired = await gates[selector]!.acquire(abortController.signal);
      req.off("aborted", abort);
      res.off("close", abort);
      if (!acquired) {
        const err: JackErrorResponse = {
          error: `${selector}_busy`,
          detail: `${selector} is at capacity; retry after an in-flight request completes.`,
        };
        res.status(429).json(err);
        return;
      }
      release = acquired;
    }

    try {
      const status = await llm.checkHealth();
      if (status === "unavailable") {
        let detail = "No deterministic match, and the configured local LLM provider is not reachable.";
        if (selector !== "local") {
          const cred = await credentialStore?.status(selector);
          detail =
            !cred || cred.status === "not_configured"
              ? `No API key is configured for ${selector}. Add one in Settings before selecting this provider.`
              : cred.status === "invalid"
                ? `The stored ${selector} API key was rejected. Update it in Settings.`
                : `${selector} is not reachable right now.`;
        }
        const err: JackErrorResponse = { error: `${selector}_unavailable`, detail };
        res.status(503).json(err);
        return;
      }

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
      // inputSource === "typed": skip the address/repetition check entirely,
      // not just relax it. Both signals exist to distinguish a real command
      // from ambient noise or an ASR hallucination loop -- neither is
      // possible for text a presenter deliberately typed into a command box
      // with no microphone/ASR anywhere in its path. Any other value
      // (including the safe default when omitted) keeps today's protected
      // behavior unchanged.
      let downgradedFrom: string | undefined;
      if (type === "action" && action && HIGH_IMPACT_ACTIONS.has(action) && inputSource !== "typed") {
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
      if (e instanceof CredentialAuthError) {
        const err: JackErrorResponse = { error: `${selector}_unauthorized`, detail: e.message };
        res.status(401).json(err);
        return;
      }
      const err: JackErrorResponse = {
        error: `${selector}_request_failed`,
        detail: e instanceof Error ? e.message : String(e),
      };
      res.status(502).json(err);
    } finally {
      release?.();
    }
  });

  return router;
}

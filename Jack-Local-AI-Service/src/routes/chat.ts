import { Router } from "express";
import {
  isNonEmptyStringWithinLimit,
  MAX_CHAT_MESSAGE_CONTENT_LENGTH,
  MAX_CHAT_MESSAGES,
} from "../lib/requestValidation.js";
import { CredentialAuthError } from "../lib/providerErrors.js";
import type { AdmissionGate } from "../lib/admission.js";
import type { CredentialStore } from "../lib/credentialStore.js";
import type {
  AiBrainSelector,
  JackChatRequest,
  JackErrorResponse,
  LlmProvider,
} from "../types/jack.js";

/** Multi-provider AI milestone: chatRouter/intentRouter used to close over
 * one fixed LlmProvider chosen once at boot (JACK_LLM_PROVIDER). Users must
 * be able to switch AI brain per request/session, independent of ASR --
 * this registry holds all three, selected per-request via `aiProvider`. */
export interface LlmProviderRegistry {
  local: LlmProvider;
  openai: LlmProvider;
  anthropic: LlmProvider;
}

const VALID_AI_PROVIDERS: ReadonlySet<AiBrainSelector> = new Set(["local", "openai", "anthropic"]);

export function chatRouter(
  providers: LlmProviderRegistry,
  gates?: Partial<Record<AiBrainSelector, AdmissionGate>>,
  credentialStore?: CredentialStore,
): Router {
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
    if (body.messages.length > MAX_CHAT_MESSAGES) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: `Request body's \`messages\` array exceeds the ${MAX_CHAT_MESSAGES}-message limit.`,
      };
      res.status(400).json(err);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(body, "model") || Object.prototype.hasOwnProperty.call(body, "grammar")) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: "Public chat requests may not override `model` or `grammar`.",
      };
      res.status(400).json(err);
      return;
    }
    const invalidMessage = body.messages.find(
      (m) => !m || typeof m !== "object"
        || !["system", "user", "assistant"].includes(m.role)
        || !isNonEmptyStringWithinLimit(m.content, MAX_CHAT_MESSAGE_CONTENT_LENGTH),
    );
    if (invalidMessage) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: `Every message must have role system/user/assistant and a non-empty \`content\` string of at most ${MAX_CHAT_MESSAGE_CONTENT_LENGTH} characters.`,
      };
      res.status(400).json(err);
      return;
    }
    const totalPromptLength = body.messages.reduce((sum, message) => sum + message.content.length, 0);
    if (totalPromptLength > 32_768) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: "Combined message content exceeds the 32768-character prompt limit.",
      };
      res.status(400).json(err);
      return;
    }
    if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 512)) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: "`max_tokens` must be an integer from 1 through 512.",
      };
      res.status(400).json(err);
      return;
    }
    if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: "`temperature` must be a finite number from 0 through 2.",
      };
      res.status(400).json(err);
      return;
    }

    // aiProvider: a new, separately validated field -- NOT folded into the
    // existing model/grammar hard-reject block above. Omitted -> defaults
    // to "local" (today's exact behavior, not a fallback). Invalid -> 400,
    // never silently substituted -- see the plan's no-silent-fallback table.
    const rawAiProvider = (req.body as { aiProvider?: unknown }).aiProvider;
    if (rawAiProvider !== undefined && (typeof rawAiProvider !== "string" || !VALID_AI_PROVIDERS.has(rawAiProvider as AiBrainSelector))) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: '`aiProvider`, when provided, must be one of "local", "openai", or "anthropic".',
      };
      res.status(400).json(err);
      return;
    }
    const selector: AiBrainSelector = (rawAiProvider as AiBrainSelector | undefined) ?? "local";
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
        let detail = "The configured local LLM provider is not reachable. Start Colibri (`coli serve --model <model-path>`) or llama-server, matching JACK_LLM_PROVIDER.";
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

      const request: JackChatRequest = {
        messages: body.messages,
        ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
        ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }),
      };
      const result = await llm.chat(request);
      res.json(result);
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

import { Router } from "express";
import {
  isNonEmptyStringWithinLimit,
  MAX_CHAT_MESSAGE_CONTENT_LENGTH,
  MAX_CHAT_MESSAGES,
} from "../lib/requestValidation.js";
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
      const request: JackChatRequest = {
        messages: body.messages,
        ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
        ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }),
      };
      const result = await llm.chat(request);
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

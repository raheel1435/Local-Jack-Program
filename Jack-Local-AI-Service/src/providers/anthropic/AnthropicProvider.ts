import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config/services.js";
import { CredentialAuthError } from "../../lib/providerErrors.js";
import type { CredentialStore } from "../../lib/credentialStore.js";
import type { JackChatRequest, JackChatResponse, LlmProvider, ProviderStatus } from "../../types/jack.js";

const HEALTH_TIMEOUT_MS = 2000;
const CHAT_TIMEOUT_MS = 60_000;

/**
 * Anthropic (Claude) as an AI-brain provider (multi-provider AI milestone).
 * Same runtime-key-via-CredentialStore shape as OpenAiProvider -- see its
 * doc comment. Uses the official `@anthropic-ai/sdk` per this project's
 * SDK-first convention for third-party model APIs.
 *
 * Two structural differences from the OpenAI-compatible shape this
 * codebase already knows (LlamaCppProvider/ColibriProvider/OpenAiProvider):
 * (1) Anthropic's Messages API takes `system` as a top-level string, not a
 * role:"system" message inside the array; (2) `max_tokens` is *required* by
 * Anthropic (optional in JackChatRequest) -- defaulted from config when the
 * caller didn't send one; (3) the response `content` is an array of
 * blocks, not a single string.
 */
export class AnthropicProvider implements LlmProvider {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly defaultModel: string = config.anthropicDefaultModel,
  ) {}

  async checkHealth(): Promise<ProviderStatus> {
    const key = await this.credentials.getDecrypted("anthropic");
    if (key === null) return "unavailable";
    try {
      const client = new Anthropic({ apiKey: key, timeout: HEALTH_TIMEOUT_MS, maxRetries: 0 });
      await client.models.list();
      return "available";
    } catch {
      return "unavailable";
    }
  }

  async chat(req: JackChatRequest): Promise<JackChatResponse> {
    const key = await this.credentials.getDecrypted("anthropic");
    if (key === null) {
      throw new CredentialAuthError("anthropic");
    }

    const start = Date.now();
    const client = new Anthropic({ apiKey: key, timeout: CHAT_TIMEOUT_MS, maxRetries: 0 });

    // Hoist any role:"system" messages to Anthropic's top-level `system`
    // field. Every caller in this codebase today (narration.ts, intent.ts's
    // action-classification prompt) sends exactly one leading system
    // message, but this joins multiple defensively rather than assuming.
    const systemText = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const conversation = req.messages
      .filter((m): m is { role: "user" | "assistant"; content: string } => m.role !== "system");

    try {
      const message = await client.messages.create({
        model: this.defaultModel,
        max_tokens: req.max_tokens ?? config.anthropicMaxTokensDefault,
        ...(systemText ? { system: systemText } : {}),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        messages: conversation,
      });

      const content = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      return {
        content,
        model: message.model,
        latencyMs: Date.now() - start,
        raw: message,
      };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) {
        throw new CredentialAuthError("anthropic");
      }
      throw e;
    }
  }
}

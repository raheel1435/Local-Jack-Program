import OpenAI from "openai";
import { config } from "../../config/services.js";
import { CredentialAuthError } from "../../lib/providerErrors.js";
import type { CredentialStore } from "../../lib/credentialStore.js";
import type { JackChatRequest, JackChatResponse, LlmProvider, ProviderStatus } from "../../types/jack.js";

const HEALTH_TIMEOUT_MS = 2000;
// Same reasoning as LlamaCppProvider's CHAT_TIMEOUT_MS (CLAUDE-15 fix): the
// health check alone being bounded isn't enough, the actual work-performing
// call needs its own bound too.
const CHAT_TIMEOUT_MS = 60_000;

/**
 * OpenAI as an AI-brain provider (multi-provider AI milestone). Unlike
 * LlamaCppProvider/ColibriProvider, the API key is user-configured at
 * runtime via the BYOK CredentialStore, not a deploy-time env var -- so
 * every call re-resolves the key first rather than reading
 * process.env.OPENAI_API_KEY directly. Uses the official `openai` SDK per
 * this project's "call Claude/OpenAI through the official SDK, not raw
 * fetch" convention (raw fetch remains correct only for the local
 * OpenAI-compatible servers llama.cpp/Colibri talk to, which have no
 * official SDK of their own).
 */
export class OpenAiProvider implements LlmProvider {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly defaultModel: string = config.openaiDefaultModel,
  ) {}

  async checkHealth(): Promise<ProviderStatus> {
    const key = await this.credentials.getDecrypted("openai");
    // No key configured -- unavailable immediately, no network call. This
    // matters for test coverage and for not burning a request against a
    // key that doesn't exist.
    if (key === null) return "unavailable";
    try {
      const client = new OpenAI({ apiKey: key, timeout: HEALTH_TIMEOUT_MS, maxRetries: 0 });
      await client.models.list();
      return "available";
    } catch {
      // Must never throw -- healthRouter runs every provider's checkHealth()
      // via Promise.all, so one rejection here would break every other
      // provider's reported status too.
      return "unavailable";
    }
  }

  async chat(req: JackChatRequest): Promise<JackChatResponse> {
    const key = await this.credentials.getDecrypted("openai");
    if (key === null) {
      throw new CredentialAuthError("openai");
    }

    const start = Date.now();
    const client = new OpenAI({ apiKey: key, timeout: CHAT_TIMEOUT_MS, maxRetries: 0 });

    try {
      const completion = await client.chat.completions.create({
        model: this.defaultModel,
        messages: req.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(req.max_tokens === undefined ? {} : { max_tokens: req.max_tokens }),
      });

      return {
        content: completion.choices[0]?.message?.content ?? "",
        model: completion.model,
        latencyMs: Date.now() - start,
        raw: completion,
      };
    } catch (e) {
      if (e instanceof OpenAI.AuthenticationError) {
        throw new CredentialAuthError("openai");
      }
      throw e;
    }
  }
}

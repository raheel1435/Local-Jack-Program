import { config } from "../../config/services.js";
import type {
  JackChatRequest,
  JackChatResponse,
  LlmProvider,
  ProviderStatus,
} from "../../types/jack.js";

const HEALTH_TIMEOUT_MS = 2000;
// CLAUDE-15 fix: checkHealth() already had a bound; the actual work-performing
// call (chat()) had none at all, so a hung llama-server process could hang
// this request (and the caller waiting on it) indefinitely.
const CHAT_TIMEOUT_MS = 60_000;

/**
 * llama.cpp's built-in server (`llama-server`), OpenAI-compatible.
 * Unlike Colibri it does not validate `model` against a fixed id -- a
 * single loaded model answers any model string -- so no model-id
 * configuration is needed here.
 */
export class LlamaCppProvider implements LlmProvider {
  private readonly baseUrl: string;

  constructor(baseUrl: string = config.llamacppBaseUrl) {
    this.baseUrl = baseUrl;
  }

  async checkHealth(): Promise<ProviderStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return res.ok ? "available" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async chat(req: JackChatRequest): Promise<JackChatResponse> {
    const start = Date.now();
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model ?? "local",
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        ...(req.grammar ? { grammar: req.grammar } : {}),
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(
        `llama.cpp chat request failed: ${res.status} ${res.statusText}`
      );
    }

    const body = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
    };

    return {
      content: body.choices?.[0]?.message?.content ?? "",
      model: body.model ?? req.model ?? "local",
      latencyMs: Date.now() - start,
      raw: body,
    };
  }
}

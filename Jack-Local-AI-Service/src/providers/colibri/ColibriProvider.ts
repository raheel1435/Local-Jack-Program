import { config } from "../../config/services.js";
import type {
  JackChatRequest,
  JackChatResponse,
  ProviderStatus,
} from "../../types/jack.js";

const HEALTH_TIMEOUT_MS = 2000;

export class ColibriProvider {
  private readonly baseUrl: string;

  constructor(baseUrl: string = config.colibriBaseUrl) {
    this.baseUrl = baseUrl;
  }

  async checkHealth(): Promise<ProviderStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
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
        model: req.model ?? config.colibriModelId,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
      }),
    });

    if (!res.ok) {
      throw new Error(
        `Colibri chat request failed: ${res.status} ${res.statusText}`
      );
    }

    const body = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
    };

    return {
      content: body.choices?.[0]?.message?.content ?? "",
      model: body.model ?? req.model ?? "colibri",
      latencyMs: Date.now() - start,
      raw: body,
    };
  }
}

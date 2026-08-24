import { config } from "../../config/services.js";
import type { ProviderStatus } from "../../types/jack.js";

const HEALTH_TIMEOUT_MS = 2000;
// CLAUDE-15 fix: checkHealth() already had a bound; speak() (the actual TTS
// request) had none. 30s matches the client's own jackApi.ts /jack/speak
// timeout budget.
const SPEAK_TIMEOUT_MS = 30_000;

export interface KokoroSpeakResult {
  audio: Buffer;
  contentType: string;
  latencyMs: number;
}

export class KokoroProvider {
  private readonly baseUrl: string;

  constructor(baseUrl: string = config.kokoroBaseUrl) {
    this.baseUrl = baseUrl;
  }

  async checkHealth(): Promise<ProviderStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/audio/voices`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return res.ok ? "available" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async speak(text: string, voice = "af_bella"): Promise<KokoroSpeakResult> {
    const start = Date.now();
    const res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kokoro",
        input: text,
        voice,
        response_format: "wav",
      }),
      signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(
        `Kokoro speech request failed: ${res.status} ${res.statusText}`
      );
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      contentType: res.headers.get("content-type") ?? "audio/wav",
      latencyMs: Date.now() - start,
    };
  }
}

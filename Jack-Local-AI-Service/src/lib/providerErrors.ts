import type { CredentialProviderId } from "../types/jack.js";

/**
 * Thrown by OpenAiProvider/AnthropicProvider's chat() specifically when the
 * provider rejects the stored key (HTTP 401/403 equivalent, or the SDK's
 * own AuthenticationError). Lets the route layer surface a distinct
 * "<provider>_unauthorized" error instead of the generic
 * "<provider>_request_failed" 502 every other chat() failure gets --
 * a bad/missing BYOK key is a genuinely new failure class no local
 * provider (llama.cpp/Colibri) has ever needed to represent.
 */
export class CredentialAuthError extends Error {
  constructor(readonly providerId: CredentialProviderId, _unsafeProviderMessage?: string) {
    super(`${providerLabel(providerId)} rejected the configured API key.`);
    this.name = "CredentialAuthError";
  }
}

export function providerLabel(providerId: CredentialProviderId): string {
  return providerId === "openai" ? "OpenAI" : "Anthropic";
}

export function publicAuthFailure(providerId: CredentialProviderId): string {
  return `${providerLabel(providerId)} rejected the configured API key.`;
}

export function publicBrainFailure(providerId: CredentialProviderId): string {
  return `${providerLabel(providerId)} is currently unavailable.`;
}

export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; name?: unknown };
  return candidate.status === 429 || candidate.name === "RateLimitError";
}

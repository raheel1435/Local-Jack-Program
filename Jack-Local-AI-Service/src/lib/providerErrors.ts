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
  constructor(
    readonly providerId: CredentialProviderId,
    message: string,
  ) {
    super(message);
    this.name = "CredentialAuthError";
  }
}
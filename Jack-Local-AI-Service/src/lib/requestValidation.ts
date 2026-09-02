/**
 * Small, shared input-boundary validation for the gateway's HTTP routes
 * (security-boundary hardening milestone). This gateway has no auth layer
 * (see index.ts's CORS allowlist / loopback binding for that boundary) --
 * these length caps are defense-in-depth against a caller sending
 * pathologically large payloads into regex/prompt/cache work, not a
 * behavior change for any legitimate request. Caps are set generously
 * above real product usage (deck-grounded Ask Jack prompts, multi-sentence
 * narration) so no genuine request is ever rejected by these checks --
 * confirmed against narration.ts's own MAX_MATCH_TEXT_CHARS (600 per
 * matched section) and this app's realistic multi-section retrieval size.
 */

export const MAX_INTENT_TEXT_LENGTH = 2_000;
export const MAX_ASSISTANT_NAME_LENGTH = 100;
export const MAX_SPEAK_TEXT_LENGTH = 5_000;
export const MAX_CHAT_MESSAGE_CONTENT_LENGTH = 50_000;
export const MAX_CHAT_MESSAGES = 100;
// BYOK API keys: generous upper bound, no format assumption (provider key
// formats change over time) -- just a defense-in-depth cap consistent with
// this file's other limits, well above any real OpenAI/Anthropic key length.
export const MAX_API_KEY_LENGTH = 512;

export function isNonEmptyStringWithinLimit(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export function isOptionalStringWithinLimit(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

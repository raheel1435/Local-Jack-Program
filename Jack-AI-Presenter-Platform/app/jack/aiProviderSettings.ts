import type { AiProviderId } from "../lib/jackApi";

/**
 * Multi-provider AI milestone: the AI-brain equivalent of voiceSettings.ts's
 * VOICE_OPTIONS pattern -- a plain array of typed options plus a default id
 * and a normalize*Id() guard used on both persist and load-from-storage
 * (never trust a raw localStorage value).
 */
export interface AiProviderOption {
  id: AiProviderId;
  label: string;
  description: string;
  requiresKey: boolean;
}

export const AI_PROVIDER_OPTIONS: AiProviderOption[] = [
  { id: "local", label: "Local", description: "Runs entirely on this machine. No account or API key needed.", requiresKey: false },
  { id: "openai", label: "OpenAI", description: "Uses your own OpenAI API key. Relevant text is sent to OpenAI for this request.", requiresKey: true },
  { id: "anthropic", label: "Anthropic", description: "Uses your own Anthropic API key. Relevant text is sent to Anthropic for this request.", requiresKey: true },
];

export const DEFAULT_AI_PROVIDER_ID: AiProviderId = "local";

export function normalizeAiProviderId(value: unknown): AiProviderId {
  return typeof value === "string" && AI_PROVIDER_OPTIONS.some((option) => option.id === value)
    ? (value as AiProviderId)
    : DEFAULT_AI_PROVIDER_ID;
}
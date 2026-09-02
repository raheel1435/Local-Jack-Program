import type { AsrProviderId } from "../lib/jackApi";

/**
 * Stage 2 (OpenAI Speech ASR, multi-provider AI milestone): the ASR
 * equivalent of aiProviderSettings.ts's AI_PROVIDER_OPTIONS pattern -- a
 * plain array of typed options plus a default id and a normalize*Id() guard
 * used on both persist and load-from-storage (never trust a raw
 * localStorage value). `description` doubles as this option's privacy note
 * (rendered verbatim by AsrProviderSelector, same as AiProviderSelector
 * already does for AI_PROVIDER_OPTIONS).
 */
export interface AsrProviderOption {
  id: AsrProviderId;
  label: string;
  description: string;
  requiresKey: boolean;
}

export const ASR_PROVIDER_OPTIONS: AsrProviderOption[] = [
  { id: "whisper", label: "Approved · Whisper", description: "Audio transcription stays local.", requiresKey: false },
  { id: "vibevoice", label: "Test · VibeVoice", description: "Audio transcription stays local. Experimental engine -- switch back to Approved if it's unreliable.", requiresKey: false },
  { id: "openai", label: "OpenAI Speech", description: "Captured speech is sent to OpenAI for transcription, using your own API key.", requiresKey: true },
];

export const DEFAULT_ASR_PROVIDER_ID: AsrProviderId = "whisper";

export function normalizeAsrProviderId(value: unknown): AsrProviderId {
  return typeof value === "string" && ASR_PROVIDER_OPTIONS.some((option) => option.id === value)
    ? (value as AsrProviderId)
    : DEFAULT_ASR_PROVIDER_ID;
}

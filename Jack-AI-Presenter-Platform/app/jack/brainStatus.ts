import type { AiProviderId, JackHealth } from "../lib/jackApi";

export type BrainReadiness = "checking" | "connected" | "offline";

export interface ActiveBrainStatus {
  label: "Local AI" | "OpenAI" | "Anthropic";
  readiness: BrainReadiness;
  text: string;
}

/** Availability is not activity: only the explicitly selected provider is
 * allowed to supply the visible active-brain status. */
export function activeBrainStatus(selected: AiProviderId, health: JackHealth | null): ActiveBrainStatus {
  const label = selected === "local" ? "Local AI" : selected === "openai" ? "OpenAI" : "Anthropic";
  if (health === null) return { label, readiness: "checking", text: `${label}: Checking brain…` };

  const providerStatus = selected === "local" ? health[health.activeLlmProvider] : health[selected];
  const readiness: BrainReadiness = providerStatus === "available" ? "connected" : "offline";
  return { label, readiness, text: `${label}: ${readiness === "connected" ? "Brain ready" : "Brain offline"}` };
}

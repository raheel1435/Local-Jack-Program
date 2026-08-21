import type { JackState } from "../JackOrb";
import type { JackAttentionState } from "./types";

export interface OrbPresentation {
  orbState: JackState;
  label: string;
  description: string;
}

/**
 * Maps the 11-state Jack attention state machine onto the already-approved
 * JackOrb visual states. JackOrb.tsx itself is never modified.
 * Multi-persona milestone: `name` (default "Jack" for any caller not yet
 * updated) is the assistant's current spoken/displayed name -- see
 * JackProvider's assistantName, the single source every label/description
 * below follows instead of hardcoding "Jack".
 */
export function toOrbPresentation(state: JackAttentionState, name = "Jack"): OrbPresentation {
  switch (state) {
    case "sleeping":
      return { orbState: "idle", label: `${name} is sleeping`, description: `Tap to wake ${name}` };
    case "standby":
      return { orbState: "available", label: `${name} is available`, description: "Ready when you are" };
    case "listening":
      return { orbState: "listening", label: `${name} is listening`, description: "Actively listening" };
    case "thinking":
      return { orbState: "thinking", label: `${name} is thinking`, description: "Processing what you said" };
    case "speaking":
      return { orbState: "speaking", label: `${name} is speaking`, description: "Presenting with you" };
    case "paused":
      return { orbState: "available", label: "Paused", description: `Say "${name}, continue"` };
    case "muted":
      return { orbState: "available", label: `${name} is muted`, description: `${name} can't hear you` };
    case "acting":
      return { orbState: "acting", label: `${name} is acting`, description: "Updating the presentation" };
    case "alert":
      return { orbState: "alert", label: `${name} needs attention`, description: "Check microphone permissions" };
    case "disconnected":
      return { orbState: "idle", label: "Not connected", description: `${name} isn't connected to OpenAI` };
    case "error":
      return { orbState: "alert", label: "Connection error", description: "Something went wrong" };
  }
}

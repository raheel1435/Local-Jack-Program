import type { JackState } from "../JackOrb";
import type { JackAttentionState } from "./types";

export interface OrbPresentation {
  orbState: JackState;
  label: string;
  description: string;
}

/** Maps the 11-state Jack attention state machine onto the already-approved JackOrb visual states. JackOrb.tsx itself is never modified. */
export function toOrbPresentation(state: JackAttentionState): OrbPresentation {
  switch (state) {
    case "sleeping":
      return { orbState: "idle", label: "Jack is sleeping", description: "Tap to wake Jack" };
    case "standby":
      return { orbState: "available", label: "Jack is available", description: "Ready when you are" };
    case "listening":
      return { orbState: "listening", label: "Jack is listening", description: "Actively listening" };
    case "thinking":
      return { orbState: "thinking", label: "Jack is thinking", description: "Processing what you said" };
    case "speaking":
      return { orbState: "speaking", label: "Jack is speaking", description: "Presenting with you" };
    case "paused":
      return { orbState: "available", label: "Paused", description: "Say “Jack, continue”" };
    case "muted":
      return { orbState: "available", label: "Jack is muted", description: "Jack can't hear you" };
    case "acting":
      return { orbState: "acting", label: "Jack is acting", description: "Updating the presentation" };
    case "alert":
      return { orbState: "alert", label: "Jack needs attention", description: "Check microphone permissions" };
    case "disconnected":
      return { orbState: "idle", label: "Not connected", description: "Jack isn't connected to OpenAI" };
    case "error":
      return { orbState: "alert", label: "Connection error", description: "Something went wrong" };
  }
}

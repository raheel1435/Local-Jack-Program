import type { JackAttentionState, JackEvent } from "./types";

/**
 * Pure (state, event) -> state reducer. `state` is a single enum value, so
 * combinations the spec explicitly forbids (sleeping+listening, muted+receiving
 * audio, disconnected+speaking, paused+auto-advancing) are unrepresentable —
 * there is nowhere for a second, conflicting flag to live.
 */
export function nextAttentionState(state: JackAttentionState, event: JackEvent): JackAttentionState {
  switch (event.type) {
    case "CONNECT_REQUESTED":
      return state;
    case "CONNECTED":
      return "sleeping";
    case "CONNECT_FAILED":
      return "error";
    case "DISCONNECTED":
      return "disconnected";
    case "ERROR":
      return "error";

    case "WAKE":
      return state === "sleeping" || state === "disconnected" || state === "error" ? "standby" : state;
    case "SLEEP":
      return state === "disconnected" || state === "error" ? state : "sleeping";

    case "MIC_REQUESTING":
      return state;
    case "MIC_GRANTED":
      return state;
    case "MIC_DENIED":
    case "MIC_UNAVAILABLE":
    case "MIC_ERROR":
      return state === "sleeping" || state === "disconnected" || state === "error" ? state : "alert";

    case "USER_SPEECH_DETECTED":
      return state === "standby" || state === "speaking" ? "listening" : state;
    case "RESPONSE_REQUESTED":
      return state === "listening" ? "thinking" : state;
    case "AUDIO_START":
      return state === "sleeping" || state === "disconnected" || state === "muted" ? state : "speaking";
    case "AUDIO_STOPPED":
      return state === "speaking" ? "standby" : state;
    case "AUDIO_INTERRUPTED":
      return state === "speaking" ? "listening" : state;

    case "TOOL_START":
      return state === "sleeping" || state === "disconnected" ? state : "acting";
    case "TOOL_END":
      return state === "acting" ? "standby" : state;

    case "MUTE":
      return state === "sleeping" || state === "disconnected" || state === "error" ? state : "muted";
    case "UNMUTE":
      return state === "muted" ? "standby" : state;

    case "PAUSE":
      return state === "sleeping" || state === "disconnected" || state === "error" ? state : "paused";
    case "RESUME":
      return state === "paused" ? "standby" : state;

    // Mirrors RESPONSE_REQUESTED/TOOL_START/TOOL_END/AUDIO_STOPPED, but for
    // the local intent path: it can start from any awake, non-busy state
    // (not just "listening") since it's triggered by typed or one-shot
    // transcribed text, not a live speech turn.
    case "LOCAL_COMMAND_START":
      return state === "sleeping" || state === "disconnected" || state === "error" ? state : "thinking";
    case "LOCAL_COMMAND_ACTING":
      return state === "thinking" ? "acting" : state;
    case "LOCAL_COMMAND_DONE":
      return state === "thinking" || state === "acting" ? "standby" : state;
    case "LOCAL_MIC_START":
      return state === "sleeping" || state === "disconnected" || state === "error" ? state : "listening";

    default:
      return state;
  }
}

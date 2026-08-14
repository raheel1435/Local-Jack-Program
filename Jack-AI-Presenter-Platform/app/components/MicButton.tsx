"use client";

import type { MicState } from "../hooks/useMicrophone";

const STATE_LABEL: Record<MicState, string> = {
  off: "Turn microphone on",
  requesting: "Requesting microphone permission…",
  listening: "Mute microphone",
  muted: "Unmute microphone",
  denied: "Microphone permission denied — click for instructions",
  unavailable: "Microphone unavailable in this browser",
  error: "Microphone error — click to retry",
};

const STATE_ICON: Record<MicState, string> = {
  off: "◯",
  requesting: "…",
  listening: "●",
  muted: "⊘",
  denied: "✕",
  unavailable: "✕",
  error: "!",
};

export interface MicButtonProps {
  state: MicState;
  level: number;
  onStart: () => void;
  onStop: () => void;
  onToggleMute: () => void;
  size?: "small" | "large";
}

export function MicButton({ state, level, onStart, onStop, onToggleMute, size = "large" }: MicButtonProps) {
  const handleClick = () => {
    if (state === "off" || state === "denied" || state === "error") onStart();
    else if (state === "listening" || state === "muted") onToggleMute();
  };

  return (
    <div className={`mic-button-wrap ${size}`}>
      <button
        type="button"
        className={`mic-button state-${state}`}
        aria-label={STATE_LABEL[state]}
        aria-pressed={state === "listening" || state === "muted"}
        onClick={handleClick}
        disabled={state === "requesting" || state === "unavailable"}
      >
        <span aria-hidden="true">{STATE_ICON[state]}</span>
      </button>
      {(state === "listening" || state === "muted") && (
        <div className="mic-level" role="img" aria-label={`Microphone input level ${Math.round(level * 100)} percent`}>
          <span style={{ transform: `scaleX(${Math.max(0.04, level)})` }} />
        </div>
      )}
      {state === "listening" && (
        <button type="button" className="mic-stop-link" onClick={onStop}>
          Stop microphone
        </button>
      )}
    </div>
  );
}

"use client";

import { JACK_STATES, type JackState } from "../JackOrb";
import type { ConnectionStatus, MicPipelineStatus } from "../jack/types";

export interface JackStatusBarProps {
  jackState: JackState;
  jackLabel: string;
  jackSectionLabel: string | null;
  displayedSectionLabel: string;
  inSync: boolean;
  followMode: "auto" | "manual";
  onToggleFollowMode: () => void;
  onSync: () => void;
  connectionStatus: ConnectionStatus;
  micStatus: MicPipelineStatus;
  sendingAudioToOpenAI: boolean;
}

const MIC_LABEL: Record<MicPipelineStatus, string> = {
  off: "Mic off",
  requesting: "Requesting mic…",
  listening: "Mic active",
  muted: "Mic muted",
  denied: "Mic permission denied",
  unavailable: "Mic unavailable",
  error: "Mic error",
};

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  not_configured: "Not connected",
  connecting: "Connecting…",
  connected: "Connected to OpenAI",
  reconnecting: "Reconnecting…",
  disconnected: "Not connected",
  error: "Connection error",
};

export function JackStatusBar({
  jackState, jackLabel, jackSectionLabel, displayedSectionLabel, inSync,
  followMode, onToggleFollowMode, onSync, connectionStatus, micStatus, sendingAudioToOpenAI,
}: JackStatusBarProps) {
  return (
    <div className="sync-bar" role="status">
      <span className="sync-item">
        <i className={`sync-dot state-${jackState}`} aria-hidden="true" />
        Jack: {jackLabel || JACK_STATES[jackState].label}
      </span>
      <span className={`sync-item connection-${connectionStatus}`}>{CONNECTION_LABEL[connectionStatus]}</span>
      <span className="sync-item">
        Jack is on: <strong>{jackSectionLabel ?? "—"}</strong>
      </span>
      <span className="sync-item">
        You&rsquo;re viewing: <strong>{displayedSectionLabel}</strong>
      </span>
      <span className={`sync-item mic-${micStatus}`}>{MIC_LABEL[micStatus]}</span>
      {sendingAudioToOpenAI && <span className="sync-item sync-sending">Sending audio to OpenAI</span>}
      <button type="button" className="sync-follow-toggle" onClick={onToggleFollowMode}>
        {followMode === "auto" ? "Auto-follow: on" : "Auto-follow: off"}
      </button>
      {!inSync && (
        <button type="button" className="sync-action" onClick={onSync}>
          Sync Jack to this slide
        </button>
      )}
    </div>
  );
}

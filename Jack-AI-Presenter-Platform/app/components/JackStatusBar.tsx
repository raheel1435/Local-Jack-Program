"use client";

import { JACK_STATES, type JackState } from "../JackOrb";
import type { ControlOwner } from "../jack/types";

export type LocalHealthLabel = "checking" | "connected" | "offline";
export type PresentMicLabel = "off" | "preparing" | "listening" | "processing";

export interface JackStatusBarProps {
  jackState: JackState;
  jackLabel: string;
  /** Jack Local AI gateway health -- the ONE authoritative connection truth for
   * Present mode. Not the legacy OpenAI Realtime connection (that path isn't
   * used here and was previously shown side-by-side, contradicting this). */
  localHealth: LocalHealthLabel;
  presenterControl: ControlOwner;
  isPresentingAutonomously: boolean;
  micLabel: PresentMicLabel;
  slideText: string;
  inSync: boolean;
  followMode: "auto" | "manual";
  onToggleFollowMode: () => void;
  onSync: () => void;
}

const LOCAL_HEALTH_LABEL: Record<LocalHealthLabel, string> = {
  checking: "Checking…",
  connected: "Connected",
  offline: "Offline",
};

const LOCAL_HEALTH_TITLE: Record<LocalHealthLabel, string> = {
  checking: "Checking whether Jack Local AI is reachable…",
  connected: "Jack Local AI is connected",
  offline: "Jack Local AI is unavailable -- manual presentation controls still work",
};

const MIC_LABEL: Record<PresentMicLabel, string> = {
  off: "Off",
  preparing: "Preparing…",
  listening: "Listening",
  processing: "Processing",
};

export function JackStatusBar({
  jackState,
  jackLabel,
  localHealth,
  presenterControl,
  isPresentingAutonomously,
  micLabel,
  slideText,
  inSync,
  followMode,
  onToggleFollowMode,
  onSync,
}: JackStatusBarProps) {
  return (
    <div className="sync-bar" role="status">
      <span className="sync-item">
        <i className={`sync-dot state-${jackState}`} aria-hidden="true" />
        Jack: {jackLabel || JACK_STATES[jackState].label}
      </span>
      <span className={`sync-item connection-${localHealth}`} title={LOCAL_HEALTH_TITLE[localHealth]}>
        {LOCAL_HEALTH_LABEL[localHealth]}
      </span>
      <span className="sync-item">
        Control: <strong>{presenterControl === "jack" ? "Jack" : "Presenter"}</strong>
      </span>
      {isPresentingAutonomously && <span className="sync-item sync-autonomous">● Jack is presenting</span>}
      <span className={`sync-item mic-${micLabel}`}>Mic: {MIC_LABEL[micLabel]}</span>
      <span className="sync-item">Slide: <strong>{slideText}</strong></span>
      <button
        type="button"
        className="sync-follow-toggle"
        onClick={onToggleFollowMode}
        title={followMode === "auto" ? "Jack follows your slide navigation automatically -- click to stop" : "Jack stays on its own slide until you sync -- click to auto-follow again"}
        aria-label="Toggle whether Jack automatically follows the slide you're viewing"
      >
        {followMode === "auto" ? "Auto-follow: on" : "Auto-follow: off"}
      </button>
      {!inSync && (
        <button
          type="button"
          className="sync-action"
          onClick={onSync}
          title="Jack is following a different slide than the one you're viewing -- click to bring Jack to this slide"
          aria-label="Sync Jack to this slide"
        >
          Sync Jack to this slide
        </button>
      )}
    </div>
  );
}

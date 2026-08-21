"use client";

import { JACK_STATES, type JackState } from "../JackOrb";
import type { ControlOwner } from "../jack/types";

export type LocalHealthLabel = "checking" | "connected" | "offline";
export type PresentMicLabel = "off" | "preparing" | "listening" | "processing";

export interface JackStatusBarProps {
  /** Multi-persona milestone: the assistant's current spoken/displayed name
   * (see JackProvider's assistantName) -- every "Jack" reference in this bar
   * follows it instead of being hardcoded. */
  name: string;
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
  /** Local-pipeline activation lifecycle (Phase 1/2/22) -- independent of jackState's OpenAI-Realtime-oriented sleeping/standby. */
  jackAwake: boolean;
  onWake: () => void;
  onSleep: () => void;
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

/** Compact presence label (Phase 22): Sleeping/Ready/Listening/Presenting -- never a giant panel, just this one pill. */
function presenceLabel(jackAwake: boolean, micLabel: PresentMicLabel, isPresentingAutonomously: boolean): string {
  if (!jackAwake) return "Sleeping";
  if (isPresentingAutonomously) return "Presenting";
  if (micLabel === "listening") return "Listening";
  return "Ready";
}

/**
 * Phase 23 of the slide-sync milestone: the presence pill above already
 * says Sleeping/Ready/Listening/Presenting -- showing jackState's own label
 * for those same states too ("Jack is available", "Jack is sleeping") is
 * exactly the redundant "Jack · Presenting" + "Jack is thinking" + "Control:
 * Jack" + "● Jack is presenting" pile-up the milestone flagged. Only the
 * genuinely transient states the pill doesn't already cover (actively
 * thinking/speaking/acting, or something's wrong) get their own line.
 */
const TRANSIENT_JACK_STATES: ReadonlySet<JackState> = new Set(["thinking", "speaking", "acting", "alert"]);

export function JackStatusBar({
  name,
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
  jackAwake,
  onWake,
  onSleep,
}: JackStatusBarProps) {
  return (
    <div className="sync-bar" role="status">
      <button
        type="button"
        className={`sync-item sync-presence ${jackAwake ? "awake" : "sleeping"}`}
        onClick={jackAwake ? onSleep : onWake}
        aria-label={jackAwake ? `Put ${name} to sleep` : `Wake ${name}`}
        title={jackAwake ? `Click to put ${name} to sleep` : `Click to wake ${name} -- ${name} will greet you`}
      >
        <i className={`sync-dot state-${jackState}`} aria-hidden="true" />
        {name} &middot; {presenceLabel(jackAwake, micLabel, isPresentingAutonomously)}
      </button>
      {TRANSIENT_JACK_STATES.has(jackState) && (
        <span className="sync-item" title={jackLabel || JACK_STATES[jackState].label}>
          {jackLabel || JACK_STATES[jackState].label}
        </span>
      )}
      <span className={`sync-item connection-${localHealth}`} title={LOCAL_HEALTH_TITLE[localHealth]}>
        {LOCAL_HEALTH_LABEL[localHealth]}
      </span>
      <span className="sync-item">
        Control: <strong>{presenterControl === "jack" ? name : "Presenter"}</strong>
      </span>
      <span className={`sync-item mic-${micLabel}`}>Mic: {MIC_LABEL[micLabel]}</span>
      <span className="sync-item">Slide: <strong>{slideText}</strong></span>
      <button
        type="button"
        className="sync-follow-toggle"
        onClick={onToggleFollowMode}
        title={followMode === "auto" ? `${name} follows your slide navigation automatically -- click to stop` : `${name} stays on its own slide until you sync -- click to auto-follow again`}
        aria-label={`Toggle whether ${name} automatically follows the slide you're viewing`}
      >
        {followMode === "auto" ? "Auto-follow: on" : "Auto-follow: off"}
      </button>
      {!inSync && (
        <button
          type="button"
          className="sync-action"
          onClick={onSync}
          title={`${name} is following a different slide than the one you're viewing -- click to bring ${name} to this slide`}
          aria-label={`Sync ${name} to this slide`}
        >
          Sync {name} to this slide
        </button>
      )}
    </div>
  );
}

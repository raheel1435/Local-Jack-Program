"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocalRecorder, type CaptureCloseReason, type LocalRecorderState } from "../hooks/useLocalRecorder";
import { capturePolicyFor } from "./capturePolicy";
import { isDirectlyAddressedToJack, isSelfEcho, type RecentSpeech } from "./addressing";
import { useSpeech, type UseSpeechResult } from "../hooks/useSpeech";
import { jackApi, type AsrProviderId, type JackHealth, type JackIntentAction } from "../lib/jackApi";
import {
  abortTrace,
  finishTrace,
  getTraceHistory,
  mark,
  setTraceLabel,
  setTraceProvider,
  startTrace,
  subscribeTraces,
  type TraceRecord,
} from "./perfTrace";
import { createJackSpeechPlayer } from "./jackSpeechPlayer";
import { nextAttentionState } from "./jackStateMachine";
import {
  answerDeckQuestion,
  generateNarrationContinuation,
  generateNarrationOpening,
  isPrefetchValid,
  isRedundantContinuation,
} from "./narration";
import { toOrbPresentation, type OrbPresentation } from "./orbStateMap";
import { buildPresentationContext, formatContextForPrompt, type PresentationContext } from "./presentationContext";
import { unsupportedController, type PresentationController } from "./presentationController";
import { resolveSlideTarget } from "./slideTargetResolver";
import { createWakeWordService } from "./wakeWordService";
import { DEFAULT_VOICE_ID, VOICE_OPTIONS } from "./voiceSettings";
import { useSession } from "../session/SessionContext";
import type { ParsedDocument } from "../session/types";
import type {
  AudienceQuestionPolicy,
  ControlMode,
  ControlOwner,
  JackAttentionState,
  JackEvent,
  QueuedQuestion,
} from "./types";

const JACK_LOCAL_HEALTH_POLL_MS = 8000;

// Barge-in VAD tuning (level, sustain ticks, silence timeout, arm guard,
// calibration window, floor margin) and capture bounding (pre-roll, active
// cap, max submitted WAV) now live in capturePolicy.ts, split into
// WhisperApprovedCapturePolicy (frozen) and VibeVoiceTestCapturePolicy
// (isolated, currently identical values) -- see that file's module comment.
// The values themselves are unchanged from the pre-existing frozen Whisper
// baseline; only where they live moved, so a future Vibe-only tuning pass
// structurally cannot mutate Whisper's numbers. `capturePolicy` below is
// selected per-render from the current `asrProvider`.

export interface LocalCommandOutcome {
  source: "deterministic" | "llm";
  action?: string;
  ok: boolean;
  /** Human-readable result: the failure reason, Jack's spoken answer, or a conversational reply. */
  message?: string;
}

/** One measured transcription attempt, for the local-only Diagnostics panel
 * (dual-ASR milestone). Session-scoped, in-memory, capped -- never persisted
 * or uploaded. `downstreamOk` is omitted for transcripts that were discarded
 * before reaching intent routing (ambient noise never addressed to Jack). */
export interface AsrDiagnosticEntry {
  id: string;
  provider: AsrProviderId;
  transcript: string;
  latencyMs: number;
  success: boolean;
  downstreamOk?: boolean;
  timestamp: number;
}

/**
 * Session-persisted presentation preferences (Phase 21 of the persona/voice
 * milestone): language, voice, captions, and browser-voice-fallback opt-in.
 * localStorage only, no backend/account persistence -- deliberately out of
 * scope for this milestone.
 */
const PRESENT_SETTINGS_STORAGE_KEY = "jack:presentSettings";

interface PersistedPresentSettings {
  language: string;
  voice: string;
  captionsEnabled: boolean;
  browserFallbackEnabled: boolean;
}

const DEFAULT_PRESENT_SETTINGS: PersistedPresentSettings = {
  language: "English",
  voice: DEFAULT_VOICE_ID,
  captionsEnabled: false,
  browserFallbackEnabled: false,
};

function loadPresentSettings(): PersistedPresentSettings {
  if (typeof window === "undefined") return DEFAULT_PRESENT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(PRESENT_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_PRESENT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PersistedPresentSettings>;
    return {
      language: typeof parsed.language === "string" ? parsed.language : DEFAULT_PRESENT_SETTINGS.language,
      voice: typeof parsed.voice === "string" ? parsed.voice : DEFAULT_PRESENT_SETTINGS.voice,
      captionsEnabled: typeof parsed.captionsEnabled === "boolean" ? parsed.captionsEnabled : DEFAULT_PRESENT_SETTINGS.captionsEnabled,
      browserFallbackEnabled:
        typeof parsed.browserFallbackEnabled === "boolean" ? parsed.browserFallbackEnabled : DEFAULT_PRESENT_SETTINGS.browserFallbackEnabled,
    };
  } catch {
    return DEFAULT_PRESENT_SETTINGS;
  }
}

function savePresentSettings(settings: PersistedPresentSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PRESENT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private browsing, quota) -- settings just won't survive reload.
  }
}

// Speech-recognition engine selection (dual-ASR milestone) -- deliberately a
// separate storage key from PRESENT_SETTINGS_STORAGE_KEY/voice: this picks
// the ASR engine (speech IN), not the TTS voice (speech OUT), and lives in
// its own "Voice & Listening" settings section rather than the voice
// dropdown. Always defaults to "whisper" (Approved), never "vibevoice".
const ASR_PROVIDER_STORAGE_KEY = "jack:asrProvider";

function loadAsrProvider(): AsrProviderId {
  if (typeof window === "undefined") return "whisper";
  try {
    const raw = window.localStorage.getItem(ASR_PROVIDER_STORAGE_KEY);
    return raw === "vibevoice" ? "vibevoice" : "whisper";
  } catch {
    return "whisper";
  }
}

function saveAsrProvider(provider: AsrProviderId) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ASR_PROVIDER_STORAGE_KEY, provider);
  } catch {
    // Storage unavailable -- selection just won't survive reload.
  }
}

// Wake greetings (Phase 3/4 of the activation milestone): short, warm,
// human -- spoken through the same Kokoro voice path as everything else.
// Several variants each so back-to-back wake cycles don't repeat verbatim.
const HUMOROUS_GREETINGS = [
  "Hey, I'm here. Ready when you are.",
  "Alright, I'm awake. No coffee required -- what are we presenting?",
  "Jack reporting for duty. I promise not to steal the whole presentation.",
  "Ready. You lead, or I can take it from here.",
];
const PROFESSIONAL_GREETINGS = [
  "I'm ready. How would you like to continue?",
  "Jack is ready whenever you are.",
  "Ready to begin whenever you are.",
];

function pickGreeting(humourEnabled: boolean, assistantName = "Jack"): string {
  const bank = humourEnabled ? HUMOROUS_GREETINGS : PROFESSIONAL_GREETINGS;
  const greeting = bank[Math.floor(Math.random() * bank.length)];
  return greeting.replace(/\bJack\b/g, assistantName.trim() || "Jack");
}

// The very first thing Jack ever says to the presenter, once, for the whole
// session -- always warm and professional (not gated by humourEnabled; a
// first impression isn't the place for a joke). Falls back to an
// unaddressed greeting if no name was given on the mode-select screen.
function pickFirstContactGreeting(presenterName: string): string {
  const name = presenterName.trim();
  const hi = name ? `Hi ${name}` : "Hi there";
  const bank = [
    `${hi}, it's a pleasure to meet you. How can I help?`,
    `${hi}, welcome -- what would you like me to do?`,
    `${hi}, glad to be here. What do you need from me?`,
  ];
  return bank[Math.floor(Math.random() * bank.length)];
}

// Brief takeover acknowledgements (Phase 10) -- confirms the command landed
// before narration starts, so the user isn't left wondering whether it worked.
const TAKEOVER_ACKS = ["Got it. I'll take it from here.", "Absolutely. I'll take over.", "Sure -- I've got the next part."];
function pickTakeoverAck(): string {
  return TAKEOVER_ACKS[Math.floor(Math.random() * TAKEOVER_ACKS.length)];
}

// Short continuity lines for "Continue" after a pause (Phase 13/14) --
// explicitly NOT the presentation opening. Resuming mid-presentation should
// feel like picking a conversation back up, not restarting it.
const RESUME_LINES_HUMOROUS = [
  "Back to it -- the slides didn't run away.",
  "Alright, where were we? Ah, yes.",
  "Let's continue -- I'll behave this time.",
];
const RESUME_LINES_PROFESSIONAL = ["Alright -- let's continue.", "Okay, picking up where we left off.", "Let's continue."];
function pickResumeLine(humourEnabled: boolean): string {
  const bank = humourEnabled ? RESUME_LINES_HUMOROUS : RESUME_LINES_PROFESSIONAL;
  return bank[Math.floor(Math.random() * bank.length)];
}

// "Jack take over again" within the same session (Phase 17) -- distinct from
// the full first-takeover acknowledgement/opening.
const TAKEOVER_AGAIN_ACKS = ["Absolutely -- I've got it.", "Sure, I'm back on it.", "Got it -- taking over again."];
function pickTakeoverAgainAck(): string {
  return TAKEOVER_AGAIN_ACKS[Math.floor(Math.random() * TAKEOVER_AGAIN_ACKS.length)];
}

export interface JackContextValue {
  attentionState: JackAttentionState;
  orb: OrbPresentation;
  currentCaption: string;
  lastError: string | null;
  controlMode: ControlMode;
  /** The presenter's own name, set once on the mode-select screen -- used only for Jack's one-time first-contact greeting (see wakeJackLocal). Empty until set; never required. */
  presenterName: string;
  setPresenterName(name: string): void;
  audienceQuestionPolicy: AudienceQuestionPolicy;
  humourEnabled: boolean;
  language: string;
  /** Kokoro voice id (Phase 8) -- the single source of truth for every Jack-voiced utterance. */
  voice: string;
  /**
   * Multi-persona milestone: the assistant's spoken/displayed name, derived
   * from `voice` (see voiceSettings.ts's VOICE_OPTIONS) -- "Nova" when the
   * Nova voice is selected, "Jack" for the default/unrecognized case. This
   * is the single source of truth every UI surface should read from instead
   * of hardcoding "Jack" -- the wake-word gate, narration self-introduction,
   * and Q&A prompts already do (see JackProvider's own `assistantName`).
   * Deliberately does NOT rename the product/app name ("Jack AI" in the
   * header) -- only the persona the presenter is actually talking to.
   */
  assistantName: string;
  /** Default OFF (Phase 3/26): narration/Q&A/acknowledgement text is heard, not shown, unless explicitly enabled. */
  captionsEnabled: boolean;
  /** Default OFF (Phase 10): browser speechSynthesis may only ever be used when explicitly enabled AND Kokoro is unreachable -- never a silent substitute for Jack's real voice. */
  browserFallbackEnabled: boolean;
  /**
   * Which ASR engine transcribes every mic capture across the whole app
   * (ambient listening, push-to-talk, Ask Jack, Practice) -- there is no
   * per-screen override. Defaults to "whisper" (Approved). "vibevoice"
   * (Test) is opt-in only and never used as a silent fallback target if it
   * fails; see runLocalCommand's transcription call sites.
   */
  asrProvider: AsrProviderId;
  /** Last few measured transcriptions (both engines), newest first -- see AsrDiagnosticEntry. */
  asrDiagnostics: AsrDiagnosticEntry[];
  /** Last few end-to-end latency traces (voice commands, typed commands, narration steps, wake greetings), newest first -- see perfTrace.ts. */
  perfTraces: TraceRecord[];
  setVoice(voice: string): void;
  setCaptionsEnabled(enabled: boolean): void;
  setBrowserFallbackEnabled(enabled: boolean): void;
  setAsrProvider(provider: AsrProviderId): void;
  /**
   * The ONE authoritative "Read this slide" path (Phase 9/11/17): Kokoro with
   * the selected voice, falling back to the browser's speechSynthesis only if
   * browserFallbackEnabled is on AND the Kokoro request itself fails. Reads
   * once and stops -- no auto-advance, no persona change.
   */
  readCurrentSlide(text: string): Promise<void>;
  /**
   * Unlocks Jack's audio (resumes the shared AudioContext) with NO other
   * side effect -- call synchronously from inside a real user gesture that
   * will trigger Jack speech later in the same async chain (see
   * jackSpeechPlayer.ts's class comment) when that later speech shouldn't
   * ALSO be preceded by a greeting. wakeJackLocal() itself does this same
   * unlock as its first statement, but also plays the greeting and sets
   * jackAwake -- calling it just to unlock, then having something else
   * immediately trigger the real start_presentation flow (which itself
   * calls wakeJackLocal()), raced the greeting against the takeover
   * acknowledgment for the SAME speechPlayer slot.
   */
  unlockSpeech(): void;
  /** True once Jack has been explicitly activated for this local-pipeline session (Phase 1/2). */
  jackAwake: boolean;
  /** The ONE authoritative activation function (Phase 2) -- idempotent, greets once per sleeping->awake transition (Phase 5). */
  wakeJackLocal(): Promise<void>;
  /** Explicit local sleep -- stops any current speech/narration and resets the wake guard so the next wake greets again. */
  sleepJackLocal(): void;
  /** Marks the presentation-opening intro not-yet-delivered (Phase 18) -- call when a presentation session genuinely ends (leaving Present mode), not on every sleep. */
  resetPresentationOpening(): void;
  questions: QueuedQuestion[];
  wakeWordMode: "local-wake-word" | "push-to-talk";
  wakeWordAvailable: boolean;

  /** Who currently owns slide navigation. Set by start_presentation (-> jack) and handoff_to_presenter (-> human) via runLocalCommand, or explicitly. */
  presenterControl: ControlOwner;
  setPresenterControl(owner: ControlOwner): void;
  /** Jack-Local-AI-Service reachability -- polled independently, so every mode can always report an honest status even when Jack is fully offline. */
  jackLocalHealth: JackHealth | null;
  /** True once BOTH local LLM providers (llama.cpp and Colibri) are confirmed unavailable -- the one computation every mode's "Jack Local AI is unavailable" warning needs, centralized here instead of copied per-stage. */
  localUnavailable: boolean;

  pause(): void;
  resume(): void;
  interrupt(): void;
  /**
   * Restarts Jack's autonomous narration at the given slide index (used by
   * the "Sync Jack to this slide" control when the presenter has manually
   * navigated away from wherever Jack is currently narrating). A no-op if
   * Jack doesn't currently hold presentation control -- there's nothing to
   * resync when the presenter is the one driving.
   */
  syncNarrationToSlide(slideIndex: number): void;
  setControlMode(mode: ControlMode): void;
  setAudienceQuestionPolicy(policy: AudienceQuestionPolicy): void;
  setHumourEnabled(enabled: boolean): void;
  setLanguage(language: string): void;
  registerController(modeName: string, controller: PresentationController): void;
  unregisterController(): void;
  endSession(): void;

  /**
   * Routes typed or transcribed presenter text through the local gateway's
   * /jack/intent (deterministic router, then llama.cpp fallback) and applies
   * the result to whichever PresentationController is currently registered.
   * This is the local-brain equivalent of the OpenAI tool-calling path --
   * both ultimately drive the same controller, never raw UI state.
   */
  runLocalCommand(text: string, kind?: "typed" | "voice" | "interruption"): Promise<LocalCommandOutcome>;

  /**
   * Generates every slide's opening (and, where there's more to say,
   * continuation) narration text + synthesized audio up front, right after a
   * document finishes parsing -- instead of only the next slide, generated
   * just-in-time while the current one plays (see prefetchNextSlideOpening/
   * runNarrationStep, which still exist as the fallback for anything this
   * step didn't cover). Meant to be awaited by AnalysisStage before it lets
   * a file count as fully ready, so the wait happens once during upload
   * instead of being spread out, one slide at a time, across the live
   * presentation. `onProgress` reports slides completed so far (1-based) out
   * of the total, for a live progress indicator during that wait. Best-
   * effort per slide: a slide whose generation fails is simply left out of
   * the cache and falls back to runNarrationStep's existing live path when
   * it's actually reached.
   */
  pregenerateDeckNarration(doc: ParsedDocument, onProgress?: (done: number, total: number) => void): Promise<void>;

  /** Shared local-recorder state -- reflects whichever of the two arm reasons
   * below is currently holding it (see the arm/disarm effect's comment). */
  localMicState: LocalRecorderState;
  localMicLevel: number;
  localMicError: string | null;
  /**
   * Manual ambient-listening override (Phase 26): true once the user has
   * turned the mic on via the mic button. Persists regardless of who holds
   * presentation control or what Jack is doing, until explicitly turned
   * off -- capture -> whisper.cpp -> runLocalCommand happens automatically
   * through the same barge-in pipeline, gated by isAddressedToJack so only
   * remarks that actually name Jack ever reach a command.
   */
  ambientListeningEnabled: boolean;
  setAmbientListeningEnabled(enabled: boolean): void;

  /** True while Jack's autonomous narrate-then-advance loop is running (presenterControl === "jack" and not paused/interrupted). */
  isPresentingAutonomously: boolean;

  /**
   * The single most recent local-command result, regardless of whether it
   * came from a typed command, push-to-talk, or a barge-in interruption --
   * all three ultimately go through runLocalCommand, which is the only place
   * that sets these. Deliberately NOT split into per-source state: an
   * earlier design tracked barge-in and typed/voice outcomes separately and
   * let the UI prioritize barge-in unconditionally, which meant one stray
   * interruption could permanently shadow every later command's feedback
   * with a stale message, no matter how much more recently the later command
   * ran. A single source of truth, updated at the one place that handles
   * every call, cannot go stale like that.
   */
  lastCommandTranscript: string | null;
  lastCommandOutcome: LocalCommandOutcome | null;
  lastCommandKind: "typed" | "voice" | "interruption" | null;

  /** Barge-in ambient-listening phase -- for a subtle dev/status indicator only (Phase 13), not part of the main presentation UI. */
  bargeInPhase: "idle" | "guarding" | "calibrating" | "armed" | "capturing" | "processing";
  /** Calibrated ambient level and effective trigger threshold for the current/last utterance -- dev diagnostics only. */
  bargeInNoiseFloor: number;
  bargeInThreshold: number;
}

const JackContext = createContext<JackContextValue | null>(null);

export function useJack(): JackContextValue {
  const ctx = useContext(JackContext);
  if (!ctx) throw new Error("useJack must be used within JackProvider");
  return ctx;
}

export function JackProvider({ children }: { children: ReactNode }) {
  const { session: appSession } = useSession();

  // "standby": attentionState represents Jack's own activity
  // (idle/listening/thinking/speaking) for the local pipeline -- the
  // dormant OpenAI Realtime path that used to also drive this state (via a
  // separate connectionStatus) was removed; every local-only transition
  // (LOCAL_COMMAND_*, AUDIO_START, USER_SPEECH_DETECTED) needs a starting
  // value other than "disconnected", which used to block them until the
  // never-called wake() ran.
  const [attentionState, setAttentionState] = useState<JackAttentionState>("standby");
  const [currentCaption, setCurrentCaption] = useState("");
  // Self-echo guard history (WHISPER FALSE-DESTRUCTIVE-COMMAND ROOT-CAUSE
  // milestone): every real thing Jack has spoken recently, so an incoming
  // barge-in transcript that's substantially HIS OWN speech leaking back
  // through the mic (imperfect echo cancellation) can be told apart from a
  // real independent command -- see addressing.ts's isSelfEcho. Capped by
  // both count and age; a ref (not state) because finishBargeInCapture needs
  // a synchronous read at the moment a transcript arrives, not a value that
  // might still be mid-render.
  const recentJackSpeechRef = useRef<RecentSpeech[]>([]);
  const SELF_ECHO_HISTORY_MS = 90_000;
  const setCurrentCaptionTracked = useCallback((text: string) => {
    setCurrentCaption(text);
    if (text.trim()) {
      const now = Date.now();
      recentJackSpeechRef.current = [
        ...recentJackSpeechRef.current.filter((e) => now - e.at < SELF_ECHO_HISTORY_MS),
        { text, at: now },
      ].slice(-5);
    }
  }, []);
  // Independent-review fix: the write-time filter above only prunes stale
  // entries when Jack next speaks -- if he goes quiet for a while, a
  // transcript arriving well past SELF_ECHO_HISTORY_MS was still being
  // checked against speech from outside that window (and, equivalently,
  // against a just-ended session's leftover history, since nothing ever
  // explicitly clears this ref). Reading through this getter instead of the
  // ref directly re-filters by age at the actual moment of use.
  const getRecentJackSpeech = useCallback((): RecentSpeech[] => {
    const now = Date.now();
    return recentJackSpeechRef.current.filter((e) => now - e.at < SELF_ECHO_HISTORY_MS);
  }, []);
  const [lastCommandOutcome, setLastCommandOutcome] = useState<LocalCommandOutcome | null>(null);
  const [lastCommandTranscript, setLastCommandTranscript] = useState<string | null>(null);
  const [lastCommandKind, setLastCommandKind] = useState<"typed" | "voice" | "interruption" | null>(null);
  const recordCommandOutcome = useCallback(
    (transcript: string, outcome: LocalCommandOutcome, kind: "typed" | "voice" | "interruption") => {
      setLastCommandTranscript(transcript || null);
      setLastCommandOutcome(outcome);
      setLastCommandKind(kind);
    },
    [],
  );
  // Local-only, session-scoped ASR diagnostics (dual-ASR milestone, Phase
  // 24-26): every real transcription attempt through finishBargeInCapture,
  // capped so this never grows unbounded. In-memory React state only -- no
  // upload, no disk persistence, no raw audio retained; cleared on reload.
  // Feeds the dev-only Diagnostics panel in Settings, nothing else.
  const [asrDiagnostics, setAsrDiagnostics] = useState<AsrDiagnosticEntry[]>([]);
  const MAX_ASR_DIAGNOSTICS = 20;
  const recordAsrDiagnostic = useCallback((entry: Omit<AsrDiagnosticEntry, "id" | "timestamp">) => {
    setAsrDiagnostics((prev) => [
      { ...entry, id: crypto.randomUUID(), timestamp: Date.now() },
      ...prev,
    ].slice(0, MAX_ASR_DIAGNOSTICS));
  }, []);
  // End-to-end latency traces (latency-observatory milestone): mirrors
  // perfTrace.ts's module-level history into React state via its
  // subscription so the Diagnostics panel re-renders when a trace finishes.
  // Same local-only/session-scoped/no-raw-audio guarantees as asrDiagnostics
  // above -- see perfTrace.ts's module doc comment.
  // useSyncExternalStore, not useState+useEffect (react-hooks/set-state-in-effect
  // lint fix): perfTrace.ts's `history` is a genuine external store (a
  // module-level array reassigned, never mutated in place, on every
  // change -- see getTraceHistory/subscribeTraces), which is exactly what
  // this hook exists for; no behavior change versus the previous
  // subscribe-in-an-effect pattern.
  // Third argument (getServerSnapshot) is required for a component that can
  // be server-rendered (this app uses vinext/RSC SSR) -- getTraceHistory()
  // itself is a safe, valid server snapshot too: real traces are only ever
  // recorded client-side (voice/narration/wake events), so it's always []
  // during SSR either way.
  const perfTraces = useSyncExternalStore(subscribeTraces, getTraceHistory, getTraceHistory);
  const [lastError, setLastError] = useState<string | null>(null);
  const [controlMode, setControlModeState] = useState<ControlMode>("presenterLeads");
  // Set once, up front (ModeSelectStage), reused for the first-contact
  // greeting below -- not persisted, this is a per-session identity, not a
  // saved preference like language/voice/captions.
  const [presenterName, setPresenterNameState] = useState("");
  const [audienceQuestionPolicy, setAudienceQuestionPolicyState] = useState<AudienceQuestionPolicy>("askPresenterFirst");
  const [humourEnabled, setHumourEnabledState] = useState(true);
  // Bug fix (multi-persona milestone): these four used to lazy-initialize
  // straight from loadPresentSettings(), which reads localStorage -- on the
  // server (SSR, no `window`) that always returns DEFAULT_PRESENT_SETTINGS,
  // but the CLIENT's very first render (the hydration render, not a later
  // one) already has `window` and reads the REAL persisted value. Nothing
  // rendered text derived from any of these into the server-rendered markup
  // before, so the divergence was silent; once assistantName (below) started
  // being rendered on the very first screen (UploadStage), this became a
  // real, visible React hydration-mismatch error ("server rendered text
  // didn't match the client") -- e.g. the orb saying "Bella" for one frame
  // server-side while the client immediately re-renders "Nova". Both the
  // server AND the client's first render must now produce the exact same
  // (default) output; the real persisted values are synced in afterward, in
  // the effect below, which only ever runs post-hydration.
  const [language, setLanguageState] = useState(DEFAULT_PRESENT_SETTINGS.language);
  const [voice, setVoiceState] = useState(DEFAULT_PRESENT_SETTINGS.voice);
  const [captionsEnabled, setCaptionsEnabledState] = useState(DEFAULT_PRESENT_SETTINGS.captionsEnabled);
  const [browserFallbackEnabled, setBrowserFallbackEnabledState] = useState(DEFAULT_PRESENT_SETTINGS.browserFallbackEnabled);
  // Multi-persona milestone: the assistant answers to whichever name goes
  // with the currently selected voice (Bella/Adam/Nova/Sarah/George/Emma/
  // Jack/...) -- see voiceSettings.ts's VOICE_OPTIONS. This is the single
  // source of that name for the whole provider: the wake-word gate, wake
  // greeting, narration self-introduction, and Q&A prompts all read it from
  // here so renaming the voice renames every part of Jack's spoken identity
  // consistently. Falls back to "Jack" for any persisted voice id that isn't
  // (or isn't yet) in VOICE_OPTIONS.
  const assistantName = useMemo(() => VOICE_OPTIONS.find((v) => v.id === voice)?.label ?? "Jack", [voice]);
  const persistPresentSettings = useCallback((partial: Partial<PersistedPresentSettings>) => {
    const next = { ...loadPresentSettings(), ...partial };
    savePresentSettings(next);
  }, []);
  const setLanguage = useCallback(
    (next: string) => {
      setLanguageState(next);
      persistPresentSettings({ language: next });
    },
    [persistPresentSettings],
  );
  const setVoice = useCallback(
    (next: string) => {
      setVoiceState(next);
      persistPresentSettings({ voice: next });
    },
    [persistPresentSettings],
  );
  const setCaptionsEnabled = useCallback(
    (next: boolean) => {
      setCaptionsEnabledState(next);
      persistPresentSettings({ captionsEnabled: next });
    },
    [persistPresentSettings],
  );
  const setBrowserFallbackEnabled = useCallback(
    (next: boolean) => {
      setBrowserFallbackEnabledState(next);
      persistPresentSettings({ browserFallbackEnabled: next });
    },
    [persistPresentSettings],
  );
  // Same SSR/localStorage hydration hazard as language/voice/captions/
  // browserFallbackEnabled above -- starts at the fixed default on every
  // render (server and client's first render alike), synced to the real
  // persisted value post-hydration in the effect below.
  const [asrProvider, setAsrProviderState] = useState<AsrProviderId>("whisper");
  const setAsrProvider = useCallback((next: AsrProviderId) => {
    setAsrProviderState(next);
    saveAsrProvider(next);
  }, []);
  // Runs exactly once, after mount -- i.e. strictly after hydration, when
  // `window`/localStorage are safely available and there's no server-
  // rendered markup left to mismatch against. Pulls in whatever was
  // actually persisted from a previous session; a fresh session (nothing
  // persisted yet) leaves every value at the same default it already
  // rendered, so this is a genuine no-op for first-time visitors.
  // Deliberate exception to react-hooks/set-state-in-effect: this isn't
  // deriving state that could be computed during render -- it's a one-time
  // post-hydration sync from localStorage, which genuinely differs between
  // the server render (no `window`) and the client's own first render, and
  // MUST happen in an effect (after commit) rather than during render to
  // avoid exactly the hydration-mismatch bug documented above this block.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const saved = loadPresentSettings();
    setLanguageState(saved.language);
    setVoiceState(saved.voice);
    setCaptionsEnabledState(saved.captionsEnabled);
    setBrowserFallbackEnabledState(saved.browserFallbackEnabled);
    setAsrProviderState(loadAsrProvider());
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  const [questions, setQuestions] = useState<QueuedQuestion[]>([]);
  const queueQuestion = useCallback((text: string) => {
    setQuestions((qs) => [...qs, { id: crypto.randomUUID(), text, status: "pending", timestamp: Date.now() }]);
  }, []);
  const [presenterControl, setPresenterControl] = useState<ControlOwner>("presenter");
  // Manual override for ambient listening (Phase 26): the mic button used to
  // be push-to-talk (one click, one utterance, auto-stop on silence).
  // Confirmed live that reads as "the mic keeps turning itself off" -- users
  // expect a mic they turned on to STAY on until they turn it off, no matter
  // who currently holds presentation control. Turning this on arms the exact
  // same ambient VAD/name-gate pipeline barge-in already uses (see the arm
  // effect's shouldArm below and isAddressedToJack in finishBargeInCapture)
  // continuously, regardless of presenterControl/attentionState, until
  // turned off again. It's additive, not a replacement for the existing
  // automatic arm-while-Jack-presents behavior -- that keeps working
  // unchanged even when this is off.
  const [ambientListeningEnabled, setAmbientListeningEnabledState] = useState(false);
  const [jackLocalHealth, setJackLocalHealth] = useState<JackHealth | null>(null);
  const [isPresentingAutonomously, setIsPresentingAutonomously] = useState(false);
  // Local-pipeline activation lifecycle (Phase 1/2 of the activation
  // milestone) -- deliberately separate from attentionState's
  // sleeping/standby (the dormant OpenAI Realtime path's states, unused
  // since the Realtime implementation was removed -- see PROGRESS.md).
  // jackAwakeRef is the authoritative synchronous guard against a double
  // greeting; jackAwake is its reactive mirror for the UI.
  const jackAwakeRef = useRef(false);
  const [jackAwake, setJackAwake] = useState(false);
  // Separate from jackAwakeRef on purpose: jackAwake/asleep resets on every
  // mode transition (Present/Practice/Ask Jack each sleep Jack on unmount),
  // so a wake genuinely does re-greet each time -- but the personalized
  // first-contact greeting (name + "what do you need") must happen exactly
  // once for the whole session, the very first time the presenter calls
  // Jack anywhere, never again afterward regardless of how many times he
  // sleeps/wakes or which mode that first call happens in.
  const presenterGreetedRef = useRef(false);
  // Structurally isolated per provider (Part 9/24 of the WHISPER SAFETY
  // CORRECTION milestone) -- see capturePolicy.ts. Recomputed whenever
  // asrProvider changes; useLocalRecorder reads the latest value on every
  // frame via its own ref, so switching providers mid-session takes effect
  // on the next start() without needing to remount the hook.
  const capturePolicy = useMemo(() => capturePolicyFor(asrProvider), [asrProvider]);
  const localRecorder = useLocalRecorder(capturePolicy);
  const offlineSpeech: UseSpeechResult = useSpeech();
  // Destructured (not accessed as offlineSpeech.foo inline) so useCallback
  // deps below can name exactly what they use, per this codebase's stricter
  // react-hooks lint rules.
  const { speak: speakOffline, supported: offlineSpeechSupported } = offlineSpeech;
  const presenterControlRef = useRef(presenterControl);
  useEffect(() => {
    presenterControlRef.current = presenterControl;
  }, [presenterControl]);

  const [speechPlayer] = useState(() => createJackSpeechPlayer());
  const narrationGenerationRef = useRef(0);
  const narrationActiveRef = useRef(false);
  // Next-slide narration-opening prefetch (latency-fix milestone): started
  // while the CURRENT slide's clip is playing, so slide N+1's opening
  // sentence (text + synthesized audio) is often already available the
  // instant slide N+1 becomes current. Keyed by (generation, slideIndex) --
  // narrationGenerationRef already increments on every pause/interrupt/jump/
  // handoff/stop (see cancelAutonomousPresenting), so a stale prefetch from
  // before any of those can never match a later runNarrationStep call's
  // generation and is simply discarded, never spoken.
  const narrationPrefetchRef = useRef<{
    generation: number;
    slideIndex: number;
    promise: Promise<{ text: string; audio: Blob } | null>;
  } | null>(null);
  // Whole-deck narration pre-generation (upload-time milestone): fileId ->
  // slideIndex -> its opening/continuation, generated up front by
  // pregenerateDeckNarration instead of one slide ahead during presenting.
  // A ref (not state) since it's read imperatively inside runNarrationStep
  // and never needs to trigger a re-render on its own. A slide missing from
  // the map (generation failed, or this file was never pregenerated) simply
  // falls through to runNarrationStep's existing live-generation path.
  const pregeneratedNarrationRef = useRef<
    Map<string, Map<number, { openingText: string; openingAudio: Blob; continuationText: string | null; continuationAudio: Blob | null }>>
  >(new Map());
  // Distinct from jackAwake (Phase 8): waking Jack up is a private moment
  // with the presenter; delivering the audience-facing opening happens once
  // per presentation session, the first time Jack actually starts
  // presenting. Pause -> Continue, Q&A -> Continue, a temporary human
  // handoff -> "Jack take over again", next/previous slide -- none of these
  // reset it. Only endSession() (Exit presentation) and leaving Present mode
  // entirely reset it, since those are the closest thing this app has to "a
  // genuinely new session" (see resetPresentationOpening below).
  const presentationOpeningDeliveredRef = useRef(false);
  // "idle": not listening. "guarding": mic recording started but Jack just
  // began speaking -- too early to trust levels (playback-start transient).
  // "calibrating": sampling ambient level to set an effective threshold for
  // this utterance. "armed": watching for a sustained burst above that
  // threshold. "capturing": interruption detected, recording the utterance.
  // "processing": recording stopped, transcribing + (if addressed) routing
  // the command -- see finishBargeInCapture's comment for why this exists.
  type BargeInPhase = "idle" | "guarding" | "calibrating" | "armed" | "capturing" | "processing";
  const bargeInPhaseRef = useRef<BargeInPhase>("idle");
  // Reactive mirror of bargeInPhaseRef, for the dev status indicator only --
  // all logic reads/writes the ref (see the capture-silence-poll comment for
  // why refs+timers, not state+effects, drive the actual barge-in machinery).
  const [bargeInPhase, setBargeInPhase] = useState<BargeInPhase>("idle");
  const setBargeInPhaseBoth = useCallback((phase: BargeInPhase) => {
    bargeInPhaseRef.current = phase;
    setBargeInPhase(phase);
  }, []);
  const bargeInLoudTicksRef = useRef(0);
  // Perf trace id for the in-progress capture (dual-ASR-latency milestone):
  // started the moment barge-in is detected (T0), used by both the silence
  // poller (T1/T2) and finishBargeInCapture (T3-T9) below.
  const bargeInTraceIdRef = useRef<string | undefined>(undefined);
  // Perf trace id for whichever speak+play cycle is CURRENTLY audible (dual-
  // ASR-latency milestone). speechPlayer.stop() deliberately never invokes
  // its pending onEnded callback (see jackSpeechPlayer.ts's stop() doc
  // comment -- that's how callers tell "finished" from "cut off"), which
  // means the finishTrace() call that normally lives inside onEnded would
  // never run for an interrupted utterance, leaking that trace forever.
  // stopJackAudio reads this ref to finish it explicitly, with ok=false.
  const activeSpeechTraceIdRef = useRef<string | undefined>(undefined);
  const bargeInSilenceStartRef = useRef<number | null>(null);
  const bargeInCaptureTimeoutRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bargeInArmGuardTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bargeInCalibrationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bargeInCalibrationSamplesRef = useRef<number[]>([]);
  // Effective trigger threshold for the CURRENT utterance -- capturePolicy's
  // bargeInLevel floor, raised if the calibrated ambient level is already
  // elevated.
  const bargeInEffectiveThresholdRef = useRef(capturePolicy.bargeInLevel);
  // Reactive mirrors of the calibrated floor/threshold, for the dev status
  // indicator only (Phase 2 of the real-hardware milestone) -- lets a real
  // tester see exactly what the mic measured and what it was compared
  // against, not just the pass/fail outcome.
  const [bargeInNoiseFloor, setBargeInNoiseFloor] = useState(0);
  const [bargeInThreshold, setBargeInThreshold] = useState(capturePolicy.bargeInLevel);
  // Kept in sync with localRecorder.level so the interval-based silence
  // poll below can read the CURRENT level without depending on a React
  // effect re-running -- level settling at an exactly-constant value (e.g.
  // true digital silence, 0) never re-fires a useEffect keyed on it, since
  // React skips updates that don't change by Object.is. An interval sidesteps that.
  const localMicLevelRef = useRef(0);
  // Lets finishBargeInCapture (defined before runLocalCommand, since
  // runLocalCommand itself needs the barge-in machinery) call the latest
  // runLocalCommand without a circular useCallback dependency.
  const runLocalCommandRef = useRef<
    (text: string, kind?: "typed" | "voice" | "interruption", traceId?: string) => Promise<LocalCommandOutcome>
  >(async () => ({ source: "deterministic", ok: false, message: "Jack isn't ready yet." }));
  // Same forward-reference pattern for pause()/resume() (defined earlier,
  // for the manual Pause/Resume buttons) to reach the autonomy controls
  // (defined later, since they depend on the speech player/narration deps).
  const cancelAutonomousPresentingRef = useRef<() => void>(() => {});
  const startAutonomousPresentingRef = useRef<(slideIndex?: number) => void>(() => {});
  // Same forward-reference pattern (react-hooks/immutability lint fix): the
  // auto-advance-to-next-slide closure inside runNarrationStep itself needs
  // to call the LATEST runNarrationStep recursively, which can't reference
  // the `const` it's declared inside of before that declaration finishes.
  const runNarrationStepRef = useRef<(generation: number, slideIndex?: number) => Promise<void>>(async () => {});
  // Same forward-reference pattern, for pause()/interrupt()'s short spoken
  // acknowledgement (Phase 14) -- speakThroughPlayer is defined later since
  // it depends on speechPlayer/voice. Optional traceId (perf tracing,
  // dual-ASR-latency milestone): callers that started a trace pass it
  // through so this call can mark/finish its T15-T19 stages.
  const speakThroughPlayerRef = useRef<(text: string, traceId?: string) => Promise<void>>(async () => {});
  // Same pattern, for resume()'s short continuity line (Phase 13/14) --
  // speakAndWait is defined later since it depends on speechPlayer/voice.
  const speakAndWaitRef = useRef<(text: string, traceId?: string) => Promise<void>>(async () => {});

  const controllerRef = useRef<{ name: string; controller: PresentationController }>({
    name: "idle",
    controller: unsupportedController("no active mode"),
  });
  const [wakeWordService] = useState(() => createWakeWordService());
  const appSessionRef = useRef(appSession);
  useEffect(() => {
    appSessionRef.current = appSession;
  }, [appSession]);

  // Independent of the OpenAI Realtime connection -- this is what lets the UI
  // honestly report "Jack Local AI is unavailable" instead of silently
  // failing the next local command.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      void jackApi.health().then((h) => {
        if (!cancelled) setJackLocalHealth(h);
      });
    };
    poll();
    const interval = setInterval(poll, JACK_LOCAL_HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const dispatchEvent = useCallback((event: JackEvent) => {
    setAttentionState((prev) => nextAttentionState(prev, event));
    if (event.type === "ERROR" || event.type === "CONNECT_FAILED" || event.type === "MIC_ERROR") {
      setLastError(event.message);
    }
  }, []);

  const pause = useCallback(() => {
    speechPlayer.unlock(); // must run synchronously inside this click -- see jackSpeechPlayer.ts
    controllerRef.current.controller.pausePresentation();
    cancelAutonomousPresentingRef.current(); // manual Pause button must also stop Jack's own narration loop -- audio is already cancelled before the line below fires
    dispatchEvent({ type: "PAUSE" });
    void speakThroughPlayerRef.current("Of course. I'll pause here.");
  }, [dispatchEvent, speechPlayer]);

  const resume = useCallback(() => {
    speechPlayer.unlock();
    const resumeResult = controllerRef.current.controller.resumePresentation();
    dispatchEvent({ type: "RESUME" });
    if (resumeResult.success && presenterControlRef.current === "jack") {
      // Short continuity line, not the full opening (Phase 13/14) -- narration
      // only starts once it's actually finished, so they never overlap.
      // The slide index is captured now, before that await, and threaded
      // through -- see startAutonomousPresenting's param comment for why
      // re-reading "current" after the await would be a race.
      const resumedIndex = resumeResult.data.index;
      // See the matching comment in runLocalCommand's "start_presentation"
      // case: a newer command arriving while this resume line is still
      // being spoken must supersede it, not have this stale request
      // restart narration once its own ack finally finishes.
      const requestGeneration = narrationGenerationRef.current;
      void (async () => {
        await speakAndWaitRef.current(pickResumeLine(humourEnabled));
        if (narrationGenerationRef.current !== requestGeneration) return;
        startAutonomousPresentingRef.current(resumedIndex);
      })();
    }
  }, [dispatchEvent, speechPlayer, humourEnabled]);

  const interrupt = useCallback(() => {
    speechPlayer.unlock();
    cancelAutonomousPresentingRef.current(); // manual Stop must also cancel local narration + pending advance -- audio is already cancelled before the acknowledgement below fires
    void speakThroughPlayerRef.current("Sure. I'll stop here.");
  }, [speechPlayer]);

  /** See JackContextValue's doc comment -- backs the "Sync Jack to this
   * slide" control. A no-op when Jack isn't presenting (nothing to resync). */
  const syncNarrationToSlide = useCallback((slideIndex: number) => {
    if (presenterControlRef.current !== "jack") return;
    startAutonomousPresentingRef.current(slideIndex);
  }, []);

  const registerController = useCallback((modeName: string, controller: PresentationController) => {
    controllerRef.current = { name: modeName, controller };
  }, []);

  const unregisterController = useCallback(() => {
    controllerRef.current = { name: "idle", controller: unsupportedController("no active mode") };
  }, []);

  const endSession = useCallback(() => {
    wakeWordService.stop();
    cancelAutonomousPresentingRef.current();
    setCurrentCaptionTracked("");
    presentationOpeningDeliveredRef.current = false; // Phase 18: ending the presentation is a genuinely new session next time
    // Confirmed live via MCP testing: without this, exiting and starting a
    // brand-new presentation still showed "Control: Jack" left over from the
    // previous session, even though nothing in the new session had asked
    // Jack to take over yet -- cosmetic, but a genuinely new session should
    // start with the presenter in control, same as the very first one does.
    setPresenterControl("presenter");
    // "Queue for moderated Q&A" audience questions belong to THIS
    // presentation session -- without this, exiting one presentation and
    // starting a different, unrelated one still showed the previous
    // session's queued questions in the notes panel.
    setQuestions([]);
  }, [wakeWordService, setCurrentCaptionTracked]);

  // --- Controlled Jack speech (Phase 6) ---------------------------------
  const stopJackAudio = useCallback(() => {
    speechPlayer.stop();
    // See activeSpeechTraceIdRef's comment -- stop() never fires onEnded, so
    // this is the only place an interrupted trace ever gets recorded.
    finishTrace(activeSpeechTraceIdRef.current, false);
    activeSpeechTraceIdRef.current = undefined;
  }, [speechPlayer]);

  /**
   * The ONE authoritative path for every Kokoro-voiced Jack utterance --
   * narration, Q&A, explain/summarize, and acknowledgements all funnel
   * through this (Phase 9). Always uses the currently selected voice.
   * Sets currentCaption to exactly what's being spoken, so the optional
   * captions toggle (default off, Phase 3) never drifts from actual audio.
   * Fetches Kokoro audio and plays it through the single shared player, with
   * real completion (not a timer) driving AUDIO_START/AUDIO_STOPPED.
   * Failures are swallowed -- the caller's text response already landed via
   * currentCaption, and this is not the "Read this slide" path (which needs
   * to distinguish failure for its own explicit fallback -- see
   * readCurrentSlide below).
   */
  const speakThroughPlayer = useCallback(
    // traceId is optional (perf tracing, dual-ASR-latency milestone): when
    // given, this call owns marking/finishing T15-T19 -- it's the last
    // stage for every branch that calls it (Q&A answers, explain/summarize,
    // the unknown-command fallback), so it's the only place that actually
    // knows when audio starts/finishes playing.
    async (text: string, traceId?: string) => {
      setCurrentCaptionTracked(text);
      mark(traceId, "ttsRequestStart"); // T15 -- ttsFirstAudio (T16) not measurable, non-streaming
      try {
        const audio = await jackApi.speak(text, voice);
        mark(traceId, "ttsResponseReady");
        dispatchEvent({ type: "AUDIO_START" });
        mark(traceId, "playbackStart"); // T17
        activeSpeechTraceIdRef.current = traceId;
        speechPlayer.play(audio, () => {
          activeSpeechTraceIdRef.current = undefined;
          mark(traceId, "playbackComplete"); // T19
          finishTrace(traceId);
          dispatchEvent({ type: "AUDIO_STOPPED" });
        });
      } catch {
        // Kokoro unavailable -- text already shown via currentCaption; speech is best-effort.
        finishTrace(traceId, false);
      }
    },
    [dispatchEvent, speechPlayer, voice, setCurrentCaptionTracked],
  );

  useEffect(() => {
    speakThroughPlayerRef.current = speakThroughPlayer;
  }, [speakThroughPlayer]);

  /**
   * Like speakThroughPlayer, but resolves only once playback has actually
   * FINISHED (or failed) -- not just once it started. Used wherever a caller
   * needs to sequence something after Jack finishes talking, so two
   * utterances never talk over each other (Phase 21): waking with a
   * greeting, then acknowledging a takeover, then only THEN starting slide
   * narration.
   */
  const speakAndWait = useCallback(
    (text: string, traceId?: string): Promise<void> =>
      new Promise((resolve) => {
        setCurrentCaptionTracked(text);
        mark(traceId, "ttsRequestStart"); // T15
        jackApi
          .speak(text, voice)
          .then((audio) => {
            mark(traceId, "ttsResponseReady");
            dispatchEvent({ type: "AUDIO_START" });
            mark(traceId, "playbackStart"); // T17
            activeSpeechTraceIdRef.current = traceId;
            speechPlayer.play(audio, () => {
              activeSpeechTraceIdRef.current = undefined;
              mark(traceId, "playbackComplete"); // T19
              finishTrace(traceId);
              dispatchEvent({ type: "AUDIO_STOPPED" });
              resolve();
            });
          })
          .catch(() => {
            finishTrace(traceId, false);
            resolve(); // Kokoro unavailable -- don't block the caller's continuation
          });
      }),
    [dispatchEvent, speechPlayer, voice, setCurrentCaptionTracked],
  );

  useEffect(() => {
    speakAndWaitRef.current = speakAndWait;
  }, [speakAndWait]);

  /**
   * The ONE authoritative "Read this slide" path (Phase 9/11/17): same
   * Kokoro voice as everything else, reads once and stops -- no auto-advance,
   * no persona change. Browser speechSynthesis is used ONLY if
   * browserFallbackEnabled is on AND the Kokoro request itself fails (Phase
   * 10) -- never a silent substitute for Jack's real voice.
   */
  const readCurrentSlide = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      speechPlayer.unlock(); // must run synchronously inside this click -- see jackSpeechPlayer.ts
      cancelAutonomousPresentingRef.current(); // stop whatever Jack was doing; reading a slide takes over cleanly, no resume-after
      setCurrentCaptionTracked(trimmed);
      try {
        const audio = await jackApi.speak(trimmed, voice);
        dispatchEvent({ type: "AUDIO_START" });
        speechPlayer.play(audio, () => dispatchEvent({ type: "AUDIO_STOPPED" }));
      } catch (err) {
        if (browserFallbackEnabled && offlineSpeechSupported) {
          speakOffline(trimmed);
        } else {
          setLastError(
            err instanceof Error ? `Jack's voice is unavailable right now (${err.message}).` : "Jack's voice is unavailable right now.",
          );
        }
      }
    },
    [dispatchEvent, speechPlayer, voice, browserFallbackEnabled, offlineSpeechSupported, speakOffline, setCurrentCaptionTracked],
  );

  /**
   * The ONE authoritative activation function (Phase 2). Idempotent: calling
   * it while already awake just re-unlocks audio and does nothing else --
   * no duplicate greeting (Phase 5). Greets once per sleeping->awake
   * transition, through the same Kokoro voice as everything else (Phase 6),
   * varying by humourEnabled (Phase 3/4). jackAwakeRef (not just the state)
   * guards the check so two rapid wake calls in the same tick can't both
   * observe "not yet awake" and both greet.
   */
  const wakeJackLocal = useCallback(async () => {
    speechPlayer.unlock(); // must run synchronously inside the originating gesture
    if (jackAwakeRef.current) return;
    jackAwakeRef.current = true;
    setJackAwake(true);
    const traceId = startTrace("wake_greeting");
    // The very first wake of the whole session gets the personalized
    // greeting-by-name instead of the generic rotation -- see
    // presenterGreetedRef's comment.
    const isFirstEverContact = !presenterGreetedRef.current;
    presenterGreetedRef.current = true;
    const greeting = isFirstEverContact ? pickFirstContactGreeting(presenterName) : pickGreeting(humourEnabled, assistantName);
    await speakAndWait(greeting, traceId);
  }, [speechPlayer, speakAndWait, humourEnabled, presenterName, assistantName]);

  const unlockSpeech = useCallback(() => {
    speechPlayer.unlock();
  }, [speechPlayer]);

  /** Sleep is explicit and local -- stops any current speech/narration and resets the wake guard so the next wake greets again. */
  const sleepJackLocal = useCallback(() => {
    cancelAutonomousPresentingRef.current();
    jackAwakeRef.current = false;
    setJackAwake(false);
  }, []);

  /**
   * Marks the presentation-opening intro as not-yet-delivered (Phase 18) --
   * a genuinely new presentation session may hear it again. Deliberately NOT
   * called from sleepJackLocal(): putting Jack to sleep mid-presentation and
   * waking him again later is still the SAME session (Phase 17), so the
   * opening must not replay just because Jack briefly slept.
   */
  const resetPresentationOpening = useCallback(() => {
    presentationOpeningDeliveredRef.current = false;
  }, []);

  // --- Barge-in capture teardown ------------------------------------------
  const clearBargeInCaptureTimeout = useCallback(() => {
    if (bargeInCaptureTimeoutRef.current !== null) {
      clearInterval(bargeInCaptureTimeoutRef.current);
      bargeInCaptureTimeoutRef.current = null;
    }
  }, []);

  const clearBargeInArmTimers = useCallback(() => {
    if (bargeInArmGuardTimeoutRef.current !== null) {
      clearTimeout(bargeInArmGuardTimeoutRef.current);
      bargeInArmGuardTimeoutRef.current = null;
    }
    if (bargeInCalibrationIntervalRef.current !== null) {
      clearInterval(bargeInCalibrationIntervalRef.current);
      bargeInCalibrationIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    localMicLevelRef.current = localRecorder.level;
  }, [localRecorder.level]);

  // Upload-time milestone: generates every slide's opening + continuation
  // narration (text and synthesized audio) up front, right after parsing,
  // instead of one slide ahead while presenting. Sequential (one slide's
  // LLM+TTS round trip after another), matching the same one-at-a-time
  // pattern prefetchNextSlideOpening already uses -- the local LLM/TTS
  // providers this app talks to are not built for concurrent requests.
  // Best-effort per slide: a failure just leaves that slide out of the
  // cache, so it falls back to runNarrationStep's live-generation path
  // exactly as it always has.
  const pregenerateDeckNarration = useCallback(
    async (doc: ParsedDocument, onProgress?: (done: number, total: number) => void) => {
      const sections = doc.sections;
      const total = sections.length;
      const slideMap = new Map<
        number,
        { openingText: string; openingAudio: Blob; continuationText: string | null; continuationAudio: Blob | null }
      >();
      for (let i = 0; i < total; i++) {
        const section = sections[i];
        const prev = i > 0 ? sections[i - 1] : null;
        const next = i < total - 1 ? sections[i + 1] : null;
        const context: PresentationContext = {
          deckTitle: doc.title,
          currentSlideNumber: i + 1,
          totalSlides: total,
          currentSlideTitle: section.title,
          currentSlideText: section.text,
          currentSlideNotes: section.speakerNotes ?? null,
          previousSlideTitle: prev?.title,
          previousSlideText: prev?.text,
          nextSlideTitle: next?.title,
        };
        try {
          // Slide 0 is the only slide that ever gets the self-introduction --
          // matches runNarrationStep's own presentationOpeningDeliveredRef
          // logic, which likewise only opens on the very first slide spoken.
          const openingText = await generateNarrationOpening(context, i === 0, humourEnabled, assistantName);
          const openingAudio = await jackApi.speak(openingText, voice);
          let continuationText: string | null = null;
          let continuationAudio: Blob | null = null;
          const rawContinuation = await generateNarrationContinuation(context, openingText, humourEnabled, assistantName);
          if (rawContinuation && !isRedundantContinuation(openingText, rawContinuation)) {
            continuationText = rawContinuation;
            continuationAudio = await jackApi.speak(rawContinuation, voice);
          }
          slideMap.set(i, { openingText, openingAudio, continuationText, continuationAudio });
        } catch {
          // Best-effort -- see this function's own comment above.
        }
        onProgress?.(i + 1, total);
      }
      pregeneratedNarrationRef.current.set(doc.fileId, slideMap);
    },
    [humourEnabled, assistantName, voice],
  );

  // --- Autonomous narration loop (Phase 2-5) ------------------------------
  /** Stops Jack's autonomy safely: audio, pending advance, and any in-flight capture. Does NOT change presenterControl -- callers decide that separately. Safe to call even when nothing is running. */
  const cancelAutonomousPresenting = useCallback(() => {
    narrationGenerationRef.current += 1;
    narrationActiveRef.current = false;
    setIsPresentingAutonomously(false);
    stopJackAudio();
    // Phase 22: a caption left over from whatever Jack last said (a
    // different slide, possibly) must not linger once that narration/audio
    // is cancelled -- callers that immediately speak something new (pause's
    // acknowledgement, readCurrentSlide, etc.) set their own caption right
    // after this runs, so this only ever clears a caption nothing replaces.
    setCurrentCaptionTracked("");
    if (bargeInPhaseRef.current !== "idle" && bargeInPhaseRef.current !== "processing") {
      setBargeInPhaseBoth("idle");
      clearBargeInArmTimers();
      clearBargeInCaptureTimeout();
      console.log("[mic] stop() called from: cancelAutonomousPresenting");
      // .catch here: fire-and-forget by design (nothing awaits the discarded
      // audio), but an uncaught rejection would otherwise surface as a
      // stray unhandled-promise-rejection error with nothing to act on it.
      void localRecorder.stop("cancel").catch(() => {}); // discard whatever was captured -- cancellation, not a command
    }
  }, [stopJackAudio, clearBargeInArmTimers, clearBargeInCaptureTimeout, localRecorder, setBargeInPhaseBoth, setCurrentCaptionTracked]);

  // Speculatively generates + synthesizes the NEXT slide's opening sentence
  // now, so it's (often) already sitting ready by the time that slide
  // actually becomes current. Never used for slide 0's own opening (nothing
  // precedes it to prefetch during) -- runNarrationStep's isOpening check
  // already gates that. Best-effort: any failure just means the next step
  // falls back to generating fresh, exactly as before this milestone.
  const prefetchNextSlideOpening = useCallback(
    (generation: number, slideIndex: number) => {
      const controller = controllerRef.current.controller;
      const context = buildPresentationContext(controller, slideIndex);
      if (!context) {
        narrationPrefetchRef.current = null;
        return;
      }
      const promise = (async () => {
        try {
          const text = await generateNarrationOpening(context, false, humourEnabled, assistantName);
          const audio = await jackApi.speak(text, voice);
          return { text, audio };
        } catch {
          return null;
        }
      })();
      narrationPrefetchRef.current = { generation, slideIndex, promise };
    },
    [humourEnabled, voice, assistantName],
  );

  const runNarrationStep = useCallback(
    // slideIndex (0-based), when given, is the AUTHORITATIVE slide to
    // narrate -- required for the auto-advance call below, which just moved
    // the slide forward and must not re-query "current" a moment later (see
    // buildPresentationContext's doc comment for why that's a real race,
    // confirmed live as the cause of Jack narrating "slide 2" on slide 3).
    // Omitted only for the very first step of a takeover, where reading
    // "current" is safe -- nothing just changed it in this same tick.
    async (generation: number, slideIndex?: number) => {
      const stillCurrent = () => narrationGenerationRef.current === generation && narrationActiveRef.current;
      if (!stillCurrent()) return;

      // One trace per narration step (per slide), covering T9 (this slide
      // becoming current -- the earliest point in code where it's known,
      // essentially concurrent with React committing the slide change) all
      // the way through T17/T19 (audible speech start/playback end). This is
      // the headline "slide change -> Jack speaking" metric the Diagnostics
      // panel surfaces -- see perfTrace.ts's rateSlideToSpeech.
      const traceId = startTrace("slide_narration");
      mark(traceId, "slideMutationDone"); // T9

      const controller = controllerRef.current.controller;
      mark(traceId, "contextBuildStart"); // T10
      const context: PresentationContext | null = buildPresentationContext(controller, slideIndex);
      mark(traceId, "contextBuildReady"); // T11
      if (!context) {
        cancelAutonomousPresenting();
        finishTrace(traceId, false);
        return;
      }
      const resolvedSlideIndex = context.currentSlideNumber - 1;

      dispatchEvent({ type: "LOCAL_COMMAND_START" }); // -> thinking
      // Decided (not just checked) here, before generation: the model is
      // about to be told "this is the opening" or "you already opened" one
      // way or the other, so the flag must reflect that choice from this
      // point on, even if this specific narration attempt later fails.
      const isOpening = !presentationOpeningDeliveredRef.current;
      presentationOpeningDeliveredRef.current = true;

      // Progressive narration (latency-fix milestone): speak a short,
      // slide-grounded OPENING sentence the moment it's ready, instead of
      // waiting for the model to finish the entire narration first. A
      // matching prefetch (started while the PREVIOUS slide's clip was
      // playing -- see prefetchNextSlideOpening) skips this opening's
      // LLM+TTS round trip entirely; it's consumed here either way (used or
      // discarded), so a slide is never narrated from a stale prefetch.
      const prefetch = narrationPrefetchRef.current;
      const prefetchHit = isPrefetchValid(prefetch, { isOpening, generation, slideIndex: resolvedSlideIndex });
      narrationPrefetchRef.current = null;

      // Upload-time milestone: a whole-deck pregeneration (see
      // pregenerateDeckNarration) beats even a prefetch hit -- it costs
      // exactly 0ms of THIS narration step's latency, same reasoning as the
      // prefetch case below, just covering every slide instead of one.
      const pregenDeck = pregeneratedNarrationRef.current.get(appSessionRef.current.activeFileId ?? "");
      const pregenSlide = pregenDeck?.get(resolvedSlideIndex);

      let opening: { text: string; audio: Blob } | null = null;
      mark(traceId, "llmRequestStart"); // T12
      if (pregenSlide) {
        mark(traceId, "llmFirstToken"); // T13 -- opening text was ready via upload-time pregeneration
        mark(traceId, "ttsRequestStart"); // T15
        mark(traceId, "ttsResponseReady");
        opening = { text: pregenSlide.openingText, audio: pregenSlide.openingAudio };
        setTraceLabel(traceId, `[pregenerated] ${pregenSlide.openingText}`);
      } else if (prefetchHit && prefetch) {
        const result = await prefetch.promise;
        if (!stillCurrent()) {
          finishTrace(traceId, false);
          return;
        }
        if (result) {
          // These stages genuinely cost ~0ms of THIS narration step's
          // latency -- the work already happened during the previous
          // slide's playback. setTraceLabel below marks the trace as a
          // prefetch hit so the Diagnostics panel never misrepresents this
          // as suspiciously-fast fresh generation.
          mark(traceId, "llmFirstToken"); // T13 -- opening text was ready via prefetch
          mark(traceId, "ttsRequestStart"); // T15
          mark(traceId, "ttsResponseReady");
          opening = result;
          setTraceLabel(traceId, `[prefetched] ${result.text}`);
        }
      }
      if (!opening) {
        try {
          const text = await generateNarrationOpening(context, isOpening, humourEnabled, assistantName);
          mark(traceId, "llmFirstToken"); // T13 -- opening sentence text ready (genuinely measurable now, unlike the old single-shot call)
          if (!stillCurrent()) {
            finishTrace(traceId, false);
            return;
          }
          mark(traceId, "ttsRequestStart"); // T15
          const audio = await jackApi.speak(text, voice);
          mark(traceId, "ttsResponseReady");
          opening = { text, audio };
          setTraceLabel(traceId, text);
        } catch (err) {
          // Phase 17: LLM/TTS failure during autonomy -- stop, don't guess, stay put.
          cancelAutonomousPresenting();
          setLastError(err instanceof Error ? err.message : "Jack couldn't prepare narration for this slide.");
          finishTrace(traceId, false);
          return;
        }
      }
      if (!stillCurrent()) {
        finishTrace(traceId, false);
        return;
      }

      setCurrentCaptionTracked(opening.text);
      dispatchEvent({ type: "AUDIO_START" });
      mark(traceId, "playbackStart"); // T17 -- closest available proxy for first audible sample (no lower-level playback-started callback exists)
      activeSpeechTraceIdRef.current = traceId;

      // Fired alongside the opening's playback, not after it: the rest of
      // this slide's narration (if any) and the NEXT slide's opening
      // prefetch both happen concurrently with what the audience is
      // currently hearing, never blocking it.
      const continuationPromise: Promise<{ text: string; audio: Blob } | null> = pregenSlide
        ? Promise.resolve(
            pregenSlide.continuationText && pregenSlide.continuationAudio
              ? { text: pregenSlide.continuationText, audio: pregenSlide.continuationAudio }
              : null,
          )
        : (async () => {
            try {
              const text = await generateNarrationContinuation(context, opening!.text, humourEnabled, assistantName);
              // Empty (model judged the opening already complete) or a
              // near-duplicate of the opening (the model didn't reliably follow
              // that instruction -- see isRedundantContinuation's comment) are
              // both treated the same way: no continuation, opening alone is a
              // complete, honest utterance.
              if (!text || isRedundantContinuation(opening!.text, text)) return null;
              const audio = await jackApi.speak(text, voice);
              return { text, audio };
            } catch {
              return null; // best-effort -- losing the continuation still leaves a real (if shorter) narration
            }
          })();
      // No need to speculatively prefetch the next slide when it's already
      // sitting in the whole-deck pregeneration cache -- would just be a
      // wasted LLM+TTS round trip nothing will ever consume, since the
      // pregen check above always takes priority over a prefetch hit anyway.
      if (!pregenDeck?.has(resolvedSlideIndex + 1)) {
        prefetchNextSlideOpening(generation, resolvedSlideIndex + 1);
      }

      const advanceToNextSlide = () => {
        if (!stillCurrent()) return;
        const advance = controller.goToNextSlide();
        if (!advance.success) {
          // Phase 5: end of deck -- finish cleanly, do not wrap to slide 1.
          controller.pausePresentation();
          cancelAutonomousPresenting();
          return;
        }
        // Pass the index goToNextSlide() just returned, not "whatever
        // current looks like now" -- see runNarrationStep's param comment.
        void runNarrationStepRef.current(generation, advance.data.index);
      };

      speechPlayer.play(opening.audio, () => {
        void (async () => {
          if (!stillCurrent()) {
            activeSpeechTraceIdRef.current = undefined;
            finishTrace(traceId, false);
            dispatchEvent({ type: "AUDIO_STOPPED" });
            return;
          }
          const continuation = await continuationPromise;
          if (!stillCurrent()) {
            activeSpeechTraceIdRef.current = undefined;
            finishTrace(traceId, false);
            dispatchEvent({ type: "AUDIO_STOPPED" });
            return;
          }
          if (!continuation) {
            activeSpeechTraceIdRef.current = undefined;
            mark(traceId, "playbackComplete"); // T19
            finishTrace(traceId);
            dispatchEvent({ type: "AUDIO_STOPPED" });
            advanceToNextSlide();
            return;
          }
          setCurrentCaptionTracked(`${opening!.text} ${continuation.text}`);
          activeSpeechTraceIdRef.current = traceId;
          speechPlayer.play(continuation.audio, () => {
            activeSpeechTraceIdRef.current = undefined;
            mark(traceId, "playbackComplete"); // T19
            finishTrace(traceId);
            dispatchEvent({ type: "AUDIO_STOPPED" });
            advanceToNextSlide();
          });
        })();
      });
    },
    [cancelAutonomousPresenting, dispatchEvent, speechPlayer, voice, humourEnabled, prefetchNextSlideOpening, assistantName, setCurrentCaptionTracked],
  );

  useEffect(() => {
    runNarrationStepRef.current = runNarrationStep;
  }, [runNarrationStep]);

  // `slideIndex`, when given, is the AUTHORITATIVE slide to resume/start
  // narrating on -- required by any caller whose own action already knows
  // the target slide but reaches this call after an await (e.g. speaking an
  // acknowledgement line first). Omitting it falls back to runNarrationStep's
  // own "current" read, which is only safe when nothing could have changed
  // the slide since this same tick started.
  const startAutonomousPresenting = useCallback(
    (slideIndex?: number) => {
      narrationGenerationRef.current += 1;
      const generation = narrationGenerationRef.current;
      narrationActiveRef.current = true;
      setIsPresentingAutonomously(true);
      void runNarrationStep(generation, slideIndex);
    },
    [runNarrationStep],
  );

  useEffect(() => {
    cancelAutonomousPresentingRef.current = cancelAutonomousPresenting;
    startAutonomousPresentingRef.current = startAutonomousPresenting;
  }, [cancelAutonomousPresenting, startAutonomousPresenting]);

  // Ambient barge-in picks up EVERY sustained sound over threshold -- room
  // noise, someone else talking, a cough -- not just remarks actually meant
  // for Jack. Unlike push-to-talk (an explicit button press, always meant
  // for Jack) or typed text, a barge-in transcript must actually ADDRESS
  // Jack (not just mention him) before it's treated as a command/question;
  // otherwise it's silently discarded here, before ever reaching
  // runLocalCommand or the UI. WHISPER SAFETY CORRECTION milestone: this was
  // a bare `/\bjack\b/i` test -- an independent Codex review found that let
  // an incidental MENTION of "Jack" (not an address) through exactly like a
  // real command; see addressing.ts's module comment for the live false-stop
  // it reproduced. classifyJackAddress distinguishes "Jack, stop." (direct)
  // from "the slide explains why Jack stopped" (mention) structurally.
  // Multi-persona milestone: the wake word is whichever assistant name is
  // currently selected (see assistantName above), not always "Jack".
  const isAddressedToJack = useCallback(
    (transcript: string) => isDirectlyAddressedToJack(transcript, assistantName),
    [assistantName],
  );

  // --- Barge-in: capture finished (silence/timeout) -> transcribe -> route ---
  //
  // Real bug fixed here: this used to set the phase straight to "idle"
  // BEFORE transcribing, which let the arm/disarm effect below re-arm the
  // mic (bargeInPhaseRef.current === "idle" is its re-arm condition) and
  // start a SECOND overlapping capture while the first one's transcription
  // was still in flight. With Whisper (~1s) that race window was narrow
  // enough to rarely matter; with VibeVoice (~10s on this machine) it was
  // wide open, and two (or more) concurrent transcribe->intent->action
  // cycles genuinely interleaving explains exactly what was reported live:
  // commands executing incorrectly and Jack's speech cutting off mid-
  // sentence from a second, unrelated cancelAutonomousPresenting() firing
  // moments after the first. The mic now stays disarmed (phase "processing",
  // not "idle") for this whole function's duration, on every exit path --
  // one capture is always fully resolved before the next one can start,
  // regardless of which ASR engine is selected.
  const finishBargeInCapture = useCallback(async (closeReason: CaptureCloseReason) => {
    const traceId = bargeInTraceIdRef.current;
    setBargeInPhaseBoth("processing");
    clearBargeInCaptureTimeout();
    console.log("[mic] stop() called from: finishBargeInCapture", { closeReason });
    // Bug fix: localRecorder.stop() used to be awaited outside any try/catch
    // here. useLocalRecorder's teardown() is now hardened not to throw (see
    // its own comment), but this is defense in depth for the same failure
    // mode either way -- a rejection here used to propagate as an unhandled
    // promise rejection AND permanently strand bargeInPhase at "processing"
    // (every reset lives below this line), since nothing ever called it
    // fresh again. The mic UI would show "Processing" forever with no
    // recovery short of a page reload.
    let audio: Blob | null;
    try {
      audio = await localRecorder.stop(closeReason);
    } catch (err) {
      abortTrace(traceId);
      bargeInTraceIdRef.current = undefined;
      setBargeInPhaseBoth("idle");
      dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
      setLastError(err instanceof Error ? err.message : "Microphone capture failed.");
      return;
    }
    mark(traceId, "captureFinalized"); // T3
    if (!audio) {
      abortTrace(traceId);
      bargeInTraceIdRef.current = undefined;
      setBargeInPhaseBoth("idle");
      dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
      return;
    }
    dispatchEvent({ type: "LOCAL_COMMAND_START" });
    try {
      mark(traceId, "asrRequestStart"); // T4
      const result = await jackApi.transcribeAudio(audio, undefined, asrProvider);
      mark(traceId, "asrTranscriptReady"); // T5
      if (traceId) setTraceProvider(traceId, result.provider);
      const transcript = result.text.trim();
      if (traceId) setTraceLabel(traceId, transcript);
      // Self-echo guard (WHISPER FALSE-DESTRUCTIVE-COMMAND ROOT-CAUSE
      // milestone): checked alongside the address gate, same fail-safe
      // treatment as an unaddressed transcript -- see addressing.ts's
      // isSelfEcho for why (a well-captured self-echo of Jack's own recent
      // TTS is genuinely high-confidence/well-formed, so it would otherwise
      // sail through both the address gate AND commandRouter.ts's
      // deterministic patterns exactly like a real command).
      const selfEcho = transcript ? isSelfEcho(transcript, getRecentJackSpeech(), assistantName) : false;
      if (!transcript || !isAddressedToJack(transcript) || selfEcho) {
        // Ambient noise / background speech that never named Jack, or
        // Jack's own voice leaking back into the mic -- ignore it entirely
        // rather than surfacing it as a failed "Interruption".
        recordAsrDiagnostic({ provider: result.provider, transcript, latencyMs: result.latencyMs, success: true });
        finishTrace(traceId, false);
        bargeInTraceIdRef.current = undefined;
        setBargeInPhaseBoth("idle");
        dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
        return;
      }
      // Reuses the exact same intent-routing path as typed/push-to-talk
      // input -- interruption is just another way text reaches Jack. Hands
      // off the same traceId so intent/action/response stages (T6 onward)
      // land on this trace instead of starting a new one. runLocalCommand
      // itself records the outcome (kind: "interruption") into the single
      // shared lastCommand* state -- no separate tracking needed here, and
      // nothing about to become stale later.
      const outcome = await runLocalCommandRef.current(transcript, "interruption", traceId);
      bargeInTraceIdRef.current = undefined;
      setBargeInPhaseBoth("idle");
      recordAsrDiagnostic({
        provider: result.provider,
        transcript,
        latencyMs: result.latencyMs,
        success: true,
        downstreamOk: outcome.ok,
      });
    } catch (err) {
      finishTrace(traceId, false);
      bargeInTraceIdRef.current = undefined;
      setBargeInPhaseBoth("idle");
      dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
      setLastError(err instanceof Error ? err.message : "Transcription failed.");
      recordAsrDiagnostic({ provider: asrProvider, transcript: "", latencyMs: 0, success: false });
    }
  }, [clearBargeInCaptureTimeout, localRecorder, dispatchEvent, setBargeInPhaseBoth, isAddressedToJack, getRecentJackSpeech, asrProvider, recordAsrDiagnostic, assistantName]);

  // Safe-interruption fix (latency-fix milestone): detecting sound crossing
  // the barge-in threshold must NOT touch Jack's in-progress narration --
  // any ambient noise/background speech would otherwise cut Jack off before
  // we even know whether it named him (confirmed live: real background
  // audio in a noisy room repeatedly stopped narration this way, discarding
  // it every time as "not addressed"). Capturing/transcribing happens
  // silently in the background; only finishBargeInCapture, once
  // isAddressedToJack(transcript) is confirmed true, is allowed to
  // interrupt -- and it already does, via cancelAutonomousPresenting()
  // inside every runLocalCommand branch a real command reaches.
  const handleBargeInDetected = useCallback(() => {
    setBargeInPhaseBoth("capturing");
    bargeInSilenceStartRef.current = null;
    dispatchEvent({ type: "USER_SPEECH_DETECTED" }); // speaking -> listening (existing transition) -- UI only, does not touch audio/narration
    clearBargeInArmTimers();
    clearBargeInCaptureTimeout();
    // Freezes the bounded pre-roll ring buffer NOW, at the real VAD trigger
    // instant -- not at localRecorder.start() (arm time), which is what let
    // pre-trigger idle-listening audio accumulate unboundedly into the
    // final WAV before this fix (see capturePolicy.ts's module comment /
    // WHISPER SAFETY CORRECTION milestone, Part 6).
    localRecorder.markCaptureTriggered();
    const traceId = startTrace("voice_command");
    bargeInTraceIdRef.current = traceId;
    mark(traceId, "speechStart"); // T0 -- VAD crossing the barge-in threshold is the earliest signal available
    const captureStarted = Date.now();
    let finished = false;
    // Polling interval, not a level-keyed effect: true silence can hold at
    // an exactly-constant level (e.g. 0) for the whole capture, which would
    // never re-fire a useEffect dependency on that value. This runs on its
    // own clock regardless of whether the level state technically "changes".
    bargeInCaptureTimeoutRef.current = setInterval(() => {
      const now = Date.now();
      const level = localMicLevelRef.current;
      if (level < capturePolicy.bargeInLevel) {
        if (bargeInSilenceStartRef.current === null) bargeInSilenceStartRef.current = now;
      } else {
        bargeInSilenceStartRef.current = null;
      }
      const sustainedSilence =
        bargeInSilenceStartRef.current !== null && now - bargeInSilenceStartRef.current > capturePolicy.silenceMs;
      const hardCap = now - captureStarted > capturePolicy.activeCaptureMaxMs;
      if ((sustainedSilence || hardCap) && !finished) {
        finished = true;
        // T1: the moment silence actually started (sustainedSilence case),
        // not the moment this poll noticed it BARGE_IN_SILENCE_MS later --
        // falls back to "now" for the hardCap case, where there's no clean
        // end-of-speech signal at all.
        mark(bargeInTraceIdRef.current, "speechEnd", sustainedSilence ? (bargeInSilenceStartRef.current ?? now) : now);
        mark(bargeInTraceIdRef.current, "vadEndOfTurn"); // T2
        clearBargeInCaptureTimeout();
        void finishBargeInCapture(sustainedSilence ? "silence" : "hard_cap");
      }
    }, 150);
  }, [dispatchEvent, clearBargeInArmTimers, clearBargeInCaptureTimeout, finishBargeInCapture, localRecorder, capturePolicy, setBargeInPhaseBoth]);

  // Arm/disarm ambient listening. Two independent reasons to be armed:
  // (1) automatic -- Jack holds the floor (presenterControl === "jack") and
  //     is speaking or idle-but-in-control ("standby"); unchanged default
  //     behavior so barge-in during Jack's own narration keeps working with
  //     no button press needed.
  // (2) manual -- ambientListeningEnabled is on (the mic button toggle).
  //     This one is deliberately independent of presenterControl and of
  //     attentionState's speaking/standby split: once the user turns the
  //     mic on, it stays on regardless of who's presenting or what Jack is
  //     doing at that instant, until they turn it off again. Confirmed live
  //     that gating this the same way as (1) meant the mic still "turned
  //     itself off" the moment control returned to the presenter.
  // Either way, EVERY captured utterance still has to pass isAddressedToJack
  // in finishBargeInCapture before it's treated as a command -- staying
  // armed longer/wider never means Jack reacts to more ambient noise, only
  // that he's still listening for his own name.
  //
  // Deliberately NOT gated on attentionState's sleeping/disconnected/muted/
  // error (an earlier version of this effect was) -- those only ever get
  // set by the OpenAI-Realtime-specific wake()/sleep()/mute() calls, and
  // Present mode's own unmount cleanup calls sleep() unconditionally to tear
  // down any lingering OpenAI resources. Confirmed live: visit Present mode
  // once, leave it, and attentionState is stuck at "sleeping" for the rest
  // of the session -- nothing in the local-only pipeline ever dispatches
  // WAKE to undo it. With that guard here, ambientListeningEnabled would
  // still flip on and the UI would still claim "Jack is listening", but
  // localRecorder.start() would silently never run again anywhere in the
  // app. attentionState genuinely does track real local speaking/standby
  // transitions correctly (LOCAL_COMMAND_*/AUDIO_* are dispatched by this
  // same local pipeline), which is why autoArmWhileJackPresents below still
  // reads it directly -- only the extra blanket reachability gate was wrong.
  //
  // Sequence once armed: start the recorder immediately (so there's no audio
  // gap), but hold off actually watching for a burst for
  // BARGE_IN_ARM_GUARD_MS (skips the playback-start transient), then spend
  // BARGE_IN_CALIBRATION_MS sampling the level to set an effective threshold
  // for this utterance, THEN arm. All timers are on their own clock (not a
  // level-keyed effect) for the same reason the capture-silence poll is --
  // see its comment.
  useEffect(() => {
    let cancelled = false;
    const autoArmWhileJackPresents = presenterControl === "jack" && (attentionState === "speaking" || attentionState === "standby");
    const shouldArm = ambientListeningEnabled || autoArmWhileJackPresents;
    if (shouldArm && bargeInPhaseRef.current === "idle") {
      setBargeInPhaseBoth("guarding");
      bargeInLoudTicksRef.current = 0;
      console.log("[mic] start() called from: arm effect (armed)", { attentionState, presenterControl });
      void localRecorder.start().then((started) => {
        if (cancelled || !started || bargeInPhaseRef.current !== "guarding") {
          clearBargeInArmTimers();
          if (bargeInPhaseRef.current === "guarding") setBargeInPhaseBoth("idle");
          if (!started) setAmbientListeningEnabledState(false);
          if (cancelled && started) void localRecorder.stop("route_change").catch(() => {});
          return;
        }
        bargeInArmGuardTimeoutRef.current = setTimeout(() => {
        if (bargeInPhaseRef.current !== "guarding") return; // disarmed/interrupted during the guard window
        setBargeInPhaseBoth("calibrating");
        bargeInCalibrationSamplesRef.current = [];
        bargeInCalibrationIntervalRef.current = setInterval(() => {
          bargeInCalibrationSamplesRef.current.push(localMicLevelRef.current);
        }, 50);
        bargeInArmGuardTimeoutRef.current = setTimeout(() => {
          if (bargeInPhaseRef.current !== "calibrating") return;
          clearBargeInArmTimers();
          const samples = bargeInCalibrationSamplesRef.current;
          const floor = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
          const threshold = Math.max(capturePolicy.bargeInLevel, floor + capturePolicy.floorMargin);
          bargeInEffectiveThresholdRef.current = threshold;
          setBargeInNoiseFloor(floor);
          setBargeInThreshold(threshold);
          bargeInLoudTicksRef.current = 0;
          setBargeInPhaseBoth("armed");
        }, capturePolicy.calibrationMs);
        }, capturePolicy.armGuardMs);
      });
    } else if (
      !shouldArm &&
      bargeInPhaseRef.current !== "idle" &&
      bargeInPhaseRef.current !== "capturing" &&
      bargeInPhaseRef.current !== "processing"
    ) {
      // Jack finished/was stopped before completing calibration or without a
      // detected interruption -- disarm and discard. "processing" is left
      // alone here too, same as "capturing" -- finishBargeInCapture owns
      // that transition (back to "idle") once transcription+routing for the
      // CURRENT capture is fully done, not before.
      setBargeInPhaseBoth("idle");
      clearBargeInArmTimers();
      console.log("[mic] stop() called from: disarm effect", { attentionState, presenterControl });
      void localRecorder.stop("route_change").catch(() => {}); // fire-and-forget -- see cancelAutonomousPresenting's matching comment
    }
    return () => {
      cancelled = true;
    };
    // "capturing" and "processing" are left alone here; handleBargeInDetected/finishBargeInCapture own those transitions.
    // Deliberately localRecorder.start/localRecorder.stop, not the whole
    // localRecorder object: useLocalRecorder() returns a brand-new object
    // literal every render (its `level` field updates ~60x/sec via rAF while
    // listening), but start/stop are individually useCallback-stable. Depending
    // on the whole object made this effect's cleanup fire on every level-driven
    // re-render -- cancelling an in-flight start() before its first-PCM-frame
    // promise resolved, which then called stop("route_change") on a genuinely
    // successful mic activation and immediately re-armed, producing a runaway
    // start()/stop("route_change") loop (confirmed live via Chrome DevTools:
    // dozens of start()/stop("route_change") calls per second while sitting in
    // Present mode with no actual route/mode change). exhaustive-deps can't
    // see that localRecorder.stop (used only inside the nested start().then()
    // closure above) is covered by the same narrowing as localRecorder.start,
    // and asks for the whole object back -- doing that reintroduces the bug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attentionState, presenterControl, ambientListeningEnabled, localRecorder.start, localRecorder.stop, clearBargeInArmTimers, setBargeInPhaseBoth, capturePolicy]);

  // Watches mic level while armed for a sustained loud burst -> real
  // interruption, against this utterance's calibrated effective threshold
  // (see the arm/disarm effect above), not the bare capturePolicy.bargeInLevel default.
  // (Silence detection during "capturing" is handled by the interval started
  // in handleBargeInDetected, not here -- see its comment.) First-pass
  // level-threshold VAD, not perfect acoustic echo cancellation -- see the
  // "Real-Hardware Limitation" section of the milestone report.
  useEffect(() => {
    if (bargeInPhaseRef.current !== "armed") return;
    if (localRecorder.level > bargeInEffectiveThresholdRef.current) {
      bargeInLoudTicksRef.current += 1;
      if (bargeInLoudTicksRef.current >= capturePolicy.sustainTicks) {
        bargeInLoudTicksRef.current = 0;
        handleBargeInDetected();
      }
    } else {
      bargeInLoudTicksRef.current = 0;
    }
  }, [localRecorder.level, handleBargeInDetected, capturePolicy]);

  const runLocalCommand = useCallback(
    async (
      text: string,
      kind: "typed" | "voice" | "interruption" = "typed",
      incomingTraceId?: string,
    ): Promise<LocalCommandOutcome> => {
      // Every exit path funnels through here so lastCommand* always reflects
      // whichever call to runLocalCommand most recently finished -- see the
      // comment on lastCommandOutcome in the context interface above.
      const finish = (outcome: LocalCommandOutcome) => {
        recordCommandOutcome(text, outcome, kind);
        return outcome;
      };

      // Perf tracing (dual-ASR-latency milestone): voice/interruption calls
      // arrive with a trace already started back in finishBargeInCapture
      // (covering T0-T5); typed calls have no ASR stage, so a fresh trace
      // starts here at T6. `traceHandedOff` tracks whether some downstream
      // speakThroughPlayer/speakAndWait call now owns finishing this trace
      // (T15-T19) -- if nothing ends up speaking, this function finishes it
      // itself right before returning.
      const traceId = incomingTraceId ?? startTrace(kind === "typed" ? "typed_command" : "voice_command", text);
      let traceHandedOff = false;

      // Typed submission is a real user gesture -- must unlock synchronously
      // within it (see jackSpeechPlayer.ts). Voice-triggered calls are
      // already covered by the mic button's own unlock(), so this is
      // harmless, idempotent reinforcement there.
      speechPlayer.unlock();
      dispatchEvent({ type: "LOCAL_COMMAND_START" });
      const controller = controllerRef.current.controller;
      try {
        // Jack stays silent until the presenter actually calls him -- this
        // is that first call, in any mode/stage (presentation, Q&A,
        // wherever), and covers every subsequent one too since
        // wakeJackLocal() is a no-op once already awake. "Jack leads" is
        // deliberately excluded: it auto-narrates the instant the session
        // starts, unprompted, by design -- that flow wakes Jack itself, from
        // inside the start_presentation case below.
        if (controlMode !== "jackLeads") {
          await wakeJackLocal();
        }
        mark(traceId, "intentRequestStart"); // T6
        const intent = await jackApi.detectIntent(text, assistantName);
        mark(traceId, "intentResultReady"); // T7
        dispatchEvent({ type: "LOCAL_COMMAND_ACTING" });

        // Phase 1 safety gate: the presentation may ONLY change for
        // type === "action". Conversation/unknown never reach the switch
        // below, no matter what the model happened to put in `action`.
        if (intent.type === "unknown") {
          dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
          const message = "I only heard part of that. Please try again.";
          traceHandedOff = true;
          void speakThroughPlayer(message, traceId);
          return finish({ source: intent.source, ok: false, message });
        }

        // Ask Jack has no slide concept at all -- an "action" classification
        // there (explain_slide, next_slide, jump_to_slide, ...) is always a
        // router/LLM misreading of what was actually an open question typed
        // in a Q&A box ("tell me everything about pricing and the team" was
        // getting classified as "explain_slide" and then handed a literally
        // empty slide, producing "This slide is empty" instead of a real
        // answer -- confirmed live). Every non-unknown intent goes through
        // the Q&A path in this mode instead of ever trying to act on slides
        // that don't exist.
        //
        // Checked via the controller's own reported `mode` (the structural
        // identifier every controller already returns from
        // getPresentationContext(), e.g. "askJack"), not
        // controllerRef.current.name -- that name is only ever meant as
        // display/prompt text (it's literally what tells the LLM "You are
        // currently in ___ mode"), so branching on it would silently break
        // this whole fix the moment someone reworded that display string.
        const presentationInfo = controller.getPresentationContext();
        const inAskJackMode = presentationInfo.success && presentationInfo.data.mode === "askJack";

        if (intent.type === "conversation" || inAskJackMode) {
          // Any conversational turn pauses autonomy first -- Phase 12: after
          // an answer, Jack stays paused until an explicit "Continue.".
          cancelAutonomousPresenting();

          // Audience question policy applies only when ALL of these hold:
          // (1) outside Ask Jack -- that mode's entire purpose is Jack
          //     answering questions directly, so "stays quiet"/"queue for
          //     later" would defeat it entirely;
          // (2) not typed input -- there's no way to tell audience speech
          //     from the presenter's own voice through the mic, but typed
          //     input can ONLY be the presenter (they're the one at the
          //     keyboard), so it must always get a real answer regardless
          //     of what policy is set for the audience;
          // (3) it actually looks like a question -- intent.type
          //     "conversation" also covers plain remarks ("Thanks.", "Hi
          //     Jack.", "Nice job.", see commandRouter.ts's
          //     CONVERSATION_RULES), and silencing Jack on "thanks" or
          //     queuing "hi jack" as an unanswered audience question would
          //     be actively wrong.
          // The question check is a heuristic, not a real classifier --
          // deliberately narrow (wh-words and clear "tell me"/"explain"-
          // style info-requests only, not bare modal verbs like "can"/
          // "is"/"will", which matched far too many plain reactive remarks
          // -- "Is that so.", "Will do." -- as if they were questions) since
          // ASR transcripts rarely carry punctuation either.
          const trimmedText = text.trim();
          const looksLikeQuestion =
            /\?\s*$/.test(trimmedText) ||
            /^(what|why|how|who|when|where|which)\b/i.test(trimmedText) ||
            /^(tell me|explain|describe|walk me through|elaborate on|give me)\b/i.test(trimmedText);
          const audiencePolicyApplies = !inAskJackMode && kind !== "typed" && looksLikeQuestion;
          if (audiencePolicyApplies && audienceQuestionPolicy === "presenterAnswers") {
            // Genuinely silent -- no speakThroughPlayer call -- per "I
            // answer, Jack stays quiet". The outcome message is text-only
            // (shown in the feedback line/captions if visible) so the
            // presenter isn't left wondering whether the command landed.
            dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
            finishTrace(traceId);
            return finish({ source: intent.source, ok: true, message: "Jack is staying quiet -- audience questions go to you." });
          }
          if (audiencePolicyApplies && audienceQuestionPolicy === "moderatedQueue") {
            queueQuestion(text);
            dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
            const ack = "Noted -- I'll leave that one for you to address.";
            void speakThroughPlayer(ack, traceId);
            return finish({ source: intent.source, ok: true, message: ack });
          }

          mark(traceId, "contextBuildStart"); // T10
          const ctx = buildPresentationContext(controller);
          mark(traceId, "contextBuildReady"); // T11
          const { parsedDocs, activeFileId } = appSessionRef.current;
          // Ask Jack has no live narration to keep pace with and exists
          // specifically for deep material knowledge -- give it a much wider
          // slice of the deck than Present/Practice's lean, real-time
          // narration-context Q&A (see retrieveForQuestion's comment).
          mark(traceId, "llmRequestStart"); // T12 -- covers answerDeckQuestion's internal LLM call; T13 not measurable (non-streaming)
          const { answer } = await answerDeckQuestion(
            text,
            ctx ?? { deckTitle: "", currentSlideNumber: 0, totalSlides: 0, currentSlideText: "" },
            Object.values(parsedDocs),
            activeFileId,
            inAskJackMode,
            assistantName,
          );
          mark(traceId, "llmResponseReady"); // T14
          dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
          void speakThroughPlayer(answer, traceId); // sets currentCaption itself
          return finish({ source: intent.source, ok: true, message: answer });
        }

        const action = intent.action as JackIntentAction | undefined;

        if (action === "explain_slide" || action === "summarize_slide") {
          cancelAutonomousPresenting();
          mark(traceId, "contextBuildStart"); // T10
          const ctx = buildPresentationContext(controller);
          mark(traceId, "contextBuildReady"); // T11
          const instruction =
            action === "explain_slide"
              ? "Explain this slide to the audience in 2-3 concise sentences."
              : "Summarize this slide in one or two sentences.";
          const prompt = ctx ? `${formatContextForPrompt(ctx)}\n\n${instruction}` : instruction;
          mark(traceId, "llmRequestStart"); // T12 -- T13 not measurable (non-streaming)
          const chat = await jackApi.chat([{ role: "user", content: prompt }], { maxTokens: 150 });
          mark(traceId, "llmResponseReady"); // T14
          dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
          void speakThroughPlayer(chat.content, traceId); // sets currentCaption itself
          return finish({ source: intent.source, action, ok: true, message: chat.content });
        }

        let result: { success: boolean; error?: string } | null = null;
        mark(traceId, "slideMutationStart"); // T8 -- covers every controller.xxx() call below, action-mutating or not
        switch (action) {
          case "start_presentation": {
            const startResult = controller.startPresentation();
            result = startResult;
            mark(traceId, "slideMutationDone"); // T9
            if (startResult.success) {
              setPresenterControl("jack");
              // Wake (with greeting) first if Jack was still asleep -- Phase
              // 2's "starting Jack presentation if currently sleeping" wake
              // trigger -- then a brief takeover acknowledgement (Phase 10),
              // and only once THAT finishes does narration begin (Phase 21:
              // never talk over the previous utterance). Already-awake is
              // the common case and skips straight to the acknowledgement.
              // Phase 17: a repeat takeover in the SAME session (opening
              // already delivered at some earlier point) gets the short
              // "taking over again" ack, never the first-takeover one --
              // the opening flag itself is what runNarrationStep uses to
              // decide whether to actually deliver the audience intro.
              const ack = presentationOpeningDeliveredRef.current ? pickTakeoverAgainAck() : pickTakeoverAck();
              traceHandedOff = true; // this trace now measures voice-command -> spoken acknowledgement latency
              // Captured now, before the awaits below -- see
              // startAutonomousPresenting's param comment.
              const startedIndex = startResult.data.index;
              // Snapshot of the generation counter at request time: if a
              // jump/pause/another start-or-resume arrives while the
              // wake/ack lines are still being spoken, cancelAutonomousPresenting
              // (or a fresh startAutonomousPresenting) bumps this counter,
              // and this request must NOT go on to restart narration on the
              // now-superseded slide once its own ack finally finishes --
              // the exact mechanism behind Jack narrating a slide the
              // display had already moved past.
              const requestGeneration = narrationGenerationRef.current;
              void (async () => {
                if (!jackAwakeRef.current) await wakeJackLocal();
                await speakAndWait(ack, traceId);
                if (narrationGenerationRef.current !== requestGeneration) return;
                startAutonomousPresenting(startedIndex); // starts its own separate slide_narration trace
              })();
            }
            break;
          }
          case "next_slide":
            cancelAutonomousPresenting();
            result = controller.goToNextSlide();
            mark(traceId, "slideMutationDone"); // T9
            break;
          case "previous_slide":
            cancelAutonomousPresenting();
            result = controller.goToPreviousSlide();
            mark(traceId, "slideMutationDone"); // T9
            break;
          case "jump_to_slide": {
            cancelAutonomousPresenting();
            const { parsedDocs, activeFileId } = appSessionRef.current;
            const sections = (activeFileId && parsedDocs[activeFileId]?.sections) || [];
            const resolution = resolveSlideTarget(text, intent.target, sections);
            if (resolution.status === "resolved") {
              result = controller.goToSlide(resolution.slideIndex);
            } else if (resolution.status === "ambiguous") {
              const names = resolution.candidates.map((c) => `"${c.title ?? `slide ${c.index + 1}`}"`).join(", ");
              result = { success: false, error: `That could mean ${names} -- which one did you mean?` };
            } else {
              result = { success: false, error: `Couldn't find a slide matching "${intent.target || text}".` };
            }
            mark(traceId, "slideMutationDone"); // T9
            break;
          }
          case "pause_presentation":
            cancelAutonomousPresenting(); // stops current audio/narration before the acknowledgement below fires
            result = controller.pausePresentation();
            mark(traceId, "slideMutationDone"); // T9
            if (result.success) {
              traceHandedOff = true;
              void speakThroughPlayer("Of course. I'll pause here.", traceId);
            }
            break;
          case "resume_presentation": {
            const resumeResult = controller.resumePresentation();
            result = resumeResult;
            mark(traceId, "slideMutationDone"); // T9
            if (resumeResult.success && presenterControlRef.current === "jack") {
              // Phase 13/14: short continuity line, NOT the full opening --
              // narration only starts once it's actually finished speaking,
              // so they never overlap. Regenerates for the CURRENT slide,
              // never skips ahead.
              traceHandedOff = true;
              // Captured now, before the await below -- see
              // startAutonomousPresenting's param comment.
              const resumedIndex = resumeResult.data.index;
              // See the matching comment in "start_presentation": a newer
              // command arriving while this resume line is still being
              // spoken must supersede it, not have this stale request
              // restart narration once its own ack finally finishes.
              const requestGeneration = narrationGenerationRef.current;
              void (async () => {
                await speakAndWait(pickResumeLine(humourEnabled), traceId);
                if (narrationGenerationRef.current !== requestGeneration) return;
                startAutonomousPresenting(resumedIndex); // starts its own separate slide_narration trace
              })();
            }
            break;
          }
          case "handoff_to_presenter":
            cancelAutonomousPresenting(); // stops current audio/narration before the acknowledgement below fires
            result = controller.handControlToPresenter();
            mark(traceId, "slideMutationDone"); // T9
            if (result.success) {
              setPresenterControl("presenter");
              traceHandedOff = true;
              void speakThroughPlayer("Absolutely. It's yours.", traceId);
            }
            break;
          case "stop_presentation":
            cancelAutonomousPresenting();
            result = controller.endPresentation();
            mark(traceId, "slideMutationDone"); // T9
            setPresenterControl("presenter");
            break;
          default:
            result = { success: false, error: `Jack didn't recognize "${text}" as a presentation command.` };
            mark(traceId, "slideMutationDone"); // T9 -- no real mutation, but keeps the pair balanced
        }

        dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
        // Success paths above already speak their own acknowledgement/answer
        // through speakThroughPlayer/speakAndWait -- this only covers the
        // ones that fall through to here with a failure, which previously
        // left Jack completely silent (the failure only ever reached the
        // UI as text), e.g. "Couldn't find a slide matching ...".
        if (!(result?.success ?? false) && result?.error) {
          traceHandedOff = true;
          void speakThroughPlayer(result.error, traceId);
        }
        if (!traceHandedOff) {
          // A silent success (next_slide, previous_slide, stop_presentation,
          // ...) -- nothing downstream will ever mark T15-T19 or finish this
          // trace, so it ends here, right after slideMutationDone (T9).
          finishTrace(traceId);
        }
        return finish({
          source: intent.source,
          action,
          ok: result?.success ?? false,
          message: result?.success ? undefined : result?.error,
        });
      } catch (err) {
        dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
        const message = err instanceof Error ? err.message : "Local Jack request failed.";
        void speakThroughPlayer(message, traceId);
        return finish({
          source: "llm",
          ok: false,
          message,
        });
      }
    },
    [
      dispatchEvent,
      cancelAutonomousPresenting,
      startAutonomousPresenting,
      speakThroughPlayer,
      recordCommandOutcome,
      speechPlayer,
      wakeJackLocal,
      speakAndWait,
      humourEnabled,
      audienceQuestionPolicy,
      queueQuestion,
      controlMode,
      assistantName,
    ],
  );

  useEffect(() => {
    runLocalCommandRef.current = runLocalCommand;
  }, [runLocalCommand]);

  /**
   * The mic button's ONE job now (Phase 26 -- replaced push-to-talk's
   * single-shot-with-silence-cutoff semantics): flip the persistent ambient-
   * listening toggle. All the actual capture/VAD/name-gate machinery is the
   * arm/disarm effect and finishBargeInCapture above -- this function does
   * not touch localRecorder directly at all, so there's no recorder-
   * ownership race to manage here (unlike the old push-to-talk, which had to
   * forcibly wrestle the shared recorder away from barge-in). Turning this
   * on when Jack is already auto-armed (presenting) is a no-op arm-wise --
   * shouldArm was already true; turning it off while Jack is still
   * presenting is also a no-op -- the automatic reason to stay armed is
   * untouched. It only matters at the moments those two reasons disagree.
   */
  const setAmbientListeningEnabled = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        setLastError(null);
        speechPlayer.unlock(); // real user gesture -- covers any Jack speech triggered by a resulting command
      }
      setAmbientListeningEnabledState(enabled);
    },
    [speechPlayer],
  );

  // Unmount cleanup: the barge-in arm/disarm effect's own timer chain
  // (arm-guard -> calibration -> the capture-silence poll) is normally
  // cleared from within that effect's disarm branch or from
  // finishBargeInCapture/handleBargeInDetected -- but if the whole provider
  // unmounts while barge-in is mid-flight (a route change unmounting the
  // app tree, or React Strict Mode's dev double-invoke), none of those ever
  // run, and the pending timers keep firing against a torn-down closure.
  useEffect(() => {
    return () => {
      clearBargeInArmTimers();
      clearBargeInCaptureTimeout();
      void localRecorder.stop("session_end").catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const localUnavailable =
    jackLocalHealth !== null && jackLocalHealth.llamacpp === "unavailable" && jackLocalHealth.colibri === "unavailable";

  const value: JackContextValue = {
    attentionState,
    orb: toOrbPresentation(attentionState, assistantName),
    currentCaption,
    lastError,
    controlMode,
    presenterName,
    audienceQuestionPolicy,
    humourEnabled,
    language,
    voice,
    captionsEnabled,
    browserFallbackEnabled,
    asrProvider,
    asrDiagnostics,
    perfTraces,
    setVoice,
    setCaptionsEnabled,
    setBrowserFallbackEnabled,
    setAsrProvider,
    readCurrentSlide,
    unlockSpeech,
    jackAwake,
    wakeJackLocal,
    sleepJackLocal,
    resetPresentationOpening,
    questions,
    wakeWordMode: wakeWordService.mode,
    wakeWordAvailable: wakeWordService.available,
    presenterControl,
    setPresenterControl,
    jackLocalHealth,
    localUnavailable,
    pause,
    resume,
    interrupt,
    syncNarrationToSlide,
    setControlMode: setControlModeState,
    setPresenterName: setPresenterNameState,
    setAudienceQuestionPolicy: setAudienceQuestionPolicyState,
    setHumourEnabled: setHumourEnabledState,
    setLanguage,
    registerController,
    unregisterController,
    endSession,
    runLocalCommand,
    pregenerateDeckNarration,
    assistantName,
    localMicState: localRecorder.state,
    localMicLevel: localRecorder.level,
    localMicError: localRecorder.error,
    ambientListeningEnabled,
    setAmbientListeningEnabled,
    isPresentingAutonomously,
    lastCommandTranscript,
    lastCommandOutcome,
    lastCommandKind,
    bargeInPhase,
    bargeInNoiseFloor,
    bargeInThreshold,
  };

  return <JackContext.Provider value={value}>{children}</JackContext.Provider>;
}

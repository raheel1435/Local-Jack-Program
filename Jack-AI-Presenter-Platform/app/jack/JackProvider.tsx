"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, type RealtimeItem } from "@openai/agents-realtime";
import { useLocalRecorder, type LocalRecorderState } from "../hooks/useLocalRecorder";
import { useSpeech, type UseSpeechResult } from "../hooks/useSpeech";
import { jackApi, type AsrProviderId, type JackHealth, type JackIntentAction } from "../lib/jackApi";
import { summarizeDocuments } from "./documentContext";
import { buildInstructions } from "./instructions";
import { createJackSpeechPlayer } from "./jackSpeechPlayer";
import { nextAttentionState } from "./jackStateMachine";
import { answerDeckQuestion, generateSlideNarration } from "./narration";
import { toOrbPresentation, type OrbPresentation } from "./orbStateMap";
import { buildPresentationContext, formatContextForPrompt, type PresentationContext } from "./presentationContext";
import { unsupportedController, type PresentationController } from "./presentationController";
import { resolveSlideTarget } from "./slideTargetResolver";
import { createPresentationTools } from "./tools";
import { createWakeWordService } from "./wakeWordService";
import { DEFAULT_VOICE_ID } from "./voiceSettings";
import { useSession } from "../session/SessionContext";
import type {
  AudienceQuestionPolicy,
  ConnectionStatus,
  ControlMode,
  ControlOwner,
  JackAttentionState,
  JackEvent,
  MicPipelineStatus,
  QueuedQuestion,
  TranscriptEntry,
} from "./types";

const JACK_LOCAL_HEALTH_POLL_MS = 8000;

// Barge-in tuning: level is a 0..1 RMS-derived value from the existing mic
// meter code. These are first-pass thresholds (see the "Real-Hardware
// Limitation" section of the milestone report) -- algorithmic hardening
// against OBVIOUS self-triggering (the loudest, most predictable false-
// positive source: Jack's own TTS output starting up), not a substitute for
// real acoustic verification with real speaker/mic hardware.
const BARGE_IN_LEVEL = 0.12;
// 4 ticks (~64ms at the level-loop's ~60fps) was long enough for a brief
// transient (a click, a cough onset, a chair creak) to trip a full
// interruption -- confirmed live as Jack's own narration getting cut off
// mid-sentence ("I can hear only part of his sentence") from things that
// were never a real attempt to talk to him. 10 ticks (~160ms) still catches
// genuine speech onset quickly but requires it to actually sustain.
const BARGE_IN_SUSTAIN_TICKS = 10;
// 900ms of quiet was tight enough to cut off a real utterance during an
// ordinary mid-sentence thinking pause -- confirmed live as Jack only
// hearing a fragment ("Jack?" instead of the rest of the question). 1500ms
// gives a real pause room without making a finished utterance feel slow to
// send.
const BARGE_IN_SILENCE_MS = 1500;
const BARGE_IN_MAX_CAPTURE_MS = 8000; // hard cap so a stuck capture can't hang forever
// Jack's TTS output has the loudest, least-adapted transient in the first
// instant of playback (volume ramp-up, echo-cancellation filter not yet
// converged) -- arming the mic for interruption detection immediately at
// AUDIO_START made that transient itself the single likeliest false trigger.
// This guard simply doesn't START WATCHING for a burst until Jack has been
// speaking for a moment; it does not silence or gate the mic itself.
const BARGE_IN_ARM_GUARD_MS = 350;
// After the guard, sample the mic level for a short window while Jack is
// already speaking to estimate a per-utterance noise floor (room noise +
// whatever of Jack's own voice leaks through despite echoCancellation). The
// trigger threshold is raised above this floor by a margin, so a merely
// elevated baseline (echo cancellation working imperfectly, a noisy room)
// needs a real spike on top of it to count as an interruption, rather than
// arming exactly at the fixed BARGE_IN_LEVEL regardless of conditions.
const BARGE_IN_CALIBRATION_MS = 250;
// Raised from .06 alongside the sustain-tick increase above -- the same
// false-triggering-on-Jack's-own-narration reports motivated both: a wider
// margin above the calibrated floor means moderate background noise/echo
// bleed-through needs a real spike, not just a slightly-elevated baseline,
// to count as a genuine interruption.
const BARGE_IN_FLOOR_MARGIN = 0.09;

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

const REALTIME_MODEL = "gpt-realtime-2";

interface WebkitAudioContextWindow {
  webkitAudioContext?: typeof AudioContext;
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

function pickGreeting(humourEnabled: boolean): string {
  const bank = humourEnabled ? HUMOROUS_GREETINGS : PROFESSIONAL_GREETINGS;
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

function transportEventType(event: unknown): string | undefined {
  if (event && typeof event === "object" && "type" in event) {
    const value = (event as { type: unknown }).type;
    if (typeof value === "string") return value;
  }
  return undefined;
}

function textFromHistory(history: RealtimeItem[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const item of history) {
    if (item.type !== "message" || item.role === "system") continue;
    const role = item.role === "user" ? "presenter" : "jack";
    const text = item.content
      .map((part) => {
        if (part.type === "input_text" || part.type === "output_text") return part.text;
        if (part.type === "input_audio" || part.type === "output_audio") return part.transcript ?? "";
        return "";
      })
      .join(" ")
      .trim();
    if (!text) continue;
    entries.push({ id: item.itemId, role, text, final: item.status === "completed", timestamp: Date.now() });
  }
  return entries;
}

export interface JackContextValue {
  attentionState: JackAttentionState;
  orb: OrbPresentation;
  connectionStatus: ConnectionStatus;
  micStatus: MicPipelineStatus;
  micLevel: number;
  sendingAudioToOpenAI: boolean;
  transcript: TranscriptEntry[];
  currentCaption: string;
  lastError: string | null;
  controlMode: ControlMode;
  audienceQuestionPolicy: AudienceQuestionPolicy;
  humourEnabled: boolean;
  language: string;
  /** Kokoro voice id (Phase 8) -- the single source of truth for every Jack-voiced utterance. */
  voice: string;
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
  /** True once Jack has been explicitly activated for this local-pipeline session (Phase 1/2) -- independent of attentionState's sleeping/standby, which belongs to the unused OpenAI Realtime path in Present mode. */
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
  /** Jack-Local-AI-Service reachability -- polled independently of the OpenAI Realtime connection, so manual mode can always report an honest status even when Jack is fully offline. */
  jackLocalHealth: JackHealth | null;
  /** True once BOTH local LLM providers (llama.cpp and Colibri) are confirmed unavailable -- the one computation every mode's "Jack Local AI is unavailable" warning needs, centralized here instead of copied per-stage. */
  localUnavailable: boolean;

  wake(): Promise<void>;
  sleep(): void;
  mute(): void;
  unmute(): void;
  pause(): void;
  resume(): void;
  interrupt(): void;
  retryConnection(): Promise<void>;
  sendText(text: string): void;
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
  bargeInPhase: "idle" | "guarding" | "calibrating" | "armed" | "capturing";
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

  // "standby", not "disconnected": attentionState represents Jack's own
  // activity (idle/listening/thinking/speaking), not the OpenAI Realtime
  // link -- that's the separate `connectionStatus` state below. Starting at
  // "disconnected" blocked every local-only transition (LOCAL_COMMAND_*,
  // AUDIO_START, USER_SPEECH_DETECTED all guard against it), which silently
  // froze the orb and made barge-in impossible to arm for any session that
  // never calls wake(). The OpenAI flow already converges on "standby" once
  // connected+awake (CONNECTED -> "sleeping", then wake()'s own WAKE ->
  // "standby"), so this doesn't change that path's eventual behavior.
  const [attentionState, setAttentionState] = useState<JackAttentionState>("standby");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [micStatus, setMicStatus] = useState<MicPipelineStatus>("off");
  const [micLevel, setMicLevel] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [currentCaption, setCurrentCaption] = useState("");
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
  const [lastError, setLastError] = useState<string | null>(null);
  const [controlMode, setControlModeState] = useState<ControlMode>("presenterLeads");
  const [audienceQuestionPolicy, setAudienceQuestionPolicyState] = useState<AudienceQuestionPolicy>("askPresenterFirst");
  const [humourEnabled, setHumourEnabledState] = useState(true);
  // Each lazy initializer runs loadPresentSettings() once, only on mount --
  // cheap (a tiny localStorage JSON.parse), and avoids the ref-during-render
  // pattern React's rules disallow.
  const [language, setLanguageState] = useState(() => loadPresentSettings().language);
  const [voice, setVoiceState] = useState(() => loadPresentSettings().voice);
  const [captionsEnabled, setCaptionsEnabledState] = useState(() => loadPresentSettings().captionsEnabled);
  const [browserFallbackEnabled, setBrowserFallbackEnabledState] = useState(() => loadPresentSettings().browserFallbackEnabled);
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
  const [asrProvider, setAsrProviderState] = useState<AsrProviderId>(() => loadAsrProvider());
  const setAsrProvider = useCallback((next: AsrProviderId) => {
    setAsrProviderState(next);
    saveAsrProvider(next);
  }, []);
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
  // sleeping/standby, which is wired to the OpenAI Realtime connection this
  // mode never uses (Present mode's typed/voice commands go through the
  // local gateway, not wake()/RealtimeSession). jackAwakeRef is the
  // authoritative synchronous guard against a double greeting; jackAwake is
  // its reactive mirror for the UI.
  const jackAwakeRef = useRef(false);
  const [jackAwake, setJackAwake] = useState(false);
  const localRecorder = useLocalRecorder();
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
  type BargeInPhase = "idle" | "guarding" | "calibrating" | "armed" | "capturing";
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
  const bargeInSilenceStartRef = useRef<number | null>(null);
  const bargeInCaptureTimeoutRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bargeInArmGuardTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bargeInCalibrationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bargeInCalibrationSamplesRef = useRef<number[]>([]);
  // Effective trigger threshold for the CURRENT utterance -- BARGE_IN_LEVEL
  // floor, raised if the calibrated ambient level is already elevated.
  const bargeInEffectiveThresholdRef = useRef(BARGE_IN_LEVEL);
  // Reactive mirrors of the calibrated floor/threshold, for the dev status
  // indicator only (Phase 2 of the real-hardware milestone) -- lets a real
  // tester see exactly what the mic measured and what it was compared
  // against, not just the pass/fail outcome.
  const [bargeInNoiseFloor, setBargeInNoiseFloor] = useState(0);
  const [bargeInThreshold, setBargeInThreshold] = useState(BARGE_IN_LEVEL);
  // Kept in sync with localRecorder.level so the interval-based silence
  // poll below can read the CURRENT level without depending on a React
  // effect re-running -- level settling at an exactly-constant value (e.g.
  // true digital silence, 0) never re-fires a useEffect keyed on it, since
  // React skips updates that don't change by Object.is. An interval sidesteps that.
  const localMicLevelRef = useRef(0);
  // Lets finishBargeInCapture (defined before runLocalCommand, since
  // runLocalCommand itself needs the barge-in machinery) call the latest
  // runLocalCommand without a circular useCallback dependency.
  const runLocalCommandRef = useRef<(text: string, kind?: "typed" | "voice" | "interruption") => Promise<LocalCommandOutcome>>(
    async () => ({ source: "deterministic", ok: false, message: "Jack isn't ready yet." }),
  );
  // Same forward-reference pattern for pause()/resume() (defined earlier,
  // for the manual Pause/Resume buttons) to reach the autonomy controls
  // (defined later, since they depend on the speech player/narration deps).
  const cancelAutonomousPresentingRef = useRef<() => void>(() => {});
  const startAutonomousPresentingRef = useRef<() => void>(() => {});
  // Same forward-reference pattern, for pause()/interrupt()'s short spoken
  // acknowledgement (Phase 14) -- speakThroughPlayer is defined later since
  // it depends on speechPlayer/voice.
  const speakThroughPlayerRef = useRef<(text: string) => Promise<void>>(async () => {});
  // Same pattern, for resume()'s short continuity line (Phase 13/14) --
  // speakAndWait is defined later since it depends on speechPlayer/voice.
  const speakAndWaitRef = useRef<(text: string) => Promise<void>>(async () => {});

  const realtimeSessionRef = useRef<RealtimeSession | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const humourUsedRef = useRef(false);
  const openingPendingRef = useRef(false);
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

  const buildCurrentInstructions = useCallback(() => {
    return buildInstructions({
      documentSummary: summarizeDocuments(Object.values(appSessionRef.current.parsedDocs)),
      controlMode,
      audienceQuestionPolicy,
      language,
      humourEnabled,
      humourUsed: humourUsedRef.current,
      modeName: controllerRef.current.name,
    });
  }, [controlMode, audienceQuestionPolicy, language, humourEnabled]);

  const stopLevelLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const runLevelLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const normalized = (data[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      setMicLevel(Math.min(1, Math.sqrt(sumSquares / data.length) * 4));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const teardownMic = useCallback(() => {
    stopLevelLoop();
    setMicLevel(0);
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  }, [stopLevelLoop]);

  const fetchEphemeralKey = useCallback(async (): Promise<string> => {
    const response = await fetch("/api/realtime/session", { method: "POST" });
    const body = (await response.json().catch(() => null)) as
      | { ok: true; clientSecret: string }
      | { ok: false; message: string }
      | null;
    if (!response.ok || !body || !body.ok) {
      throw new Error(body && "message" in body ? body.message : "Couldn't connect to OpenAI.");
    }
    return body.clientSecret;
  }, []);

  const updateTranscriptFromHistory = useCallback((history: RealtimeItem[]) => {
    const entries = textFromHistory(history);
    setTranscript(entries);
    const lastJack = [...entries].reverse().find((e) => e.role === "jack");
    setCurrentCaption(lastJack?.text ?? "");
  }, []);

  const wireSessionEvents = useCallback(
    (session: RealtimeSession) => {
      session.on("audio_start", () => dispatchEvent({ type: "AUDIO_START" }));
      session.on("audio_stopped", () => {
        dispatchEvent({ type: "AUDIO_STOPPED" });
        if (openingPendingRef.current) {
          openingPendingRef.current = false;
          humourUsedRef.current = true;
          realtimeSessionRef.current?.transport.updateSessionConfig({ instructions: buildCurrentInstructions() });
        }
      });
      session.on("audio_interrupted", () => dispatchEvent({ type: "AUDIO_INTERRUPTED" }));
      session.on("agent_tool_start", () => dispatchEvent({ type: "TOOL_START" }));
      session.on("agent_tool_end", () => dispatchEvent({ type: "TOOL_END" }));
      session.on("error", () => {
        dispatchEvent({ type: "ERROR", message: "Jack ran into a connection problem." });
      });
      session.on("history_updated", (history) => updateTranscriptFromHistory(history));
      session.on("transport_event", (event) => {
        const type = transportEventType(event);
        if (type === "input_audio_buffer.speech_started") dispatchEvent({ type: "USER_SPEECH_DETECTED" });
        if (type === "response.created") dispatchEvent({ type: "RESPONSE_REQUESTED" });
      });
    },
    [dispatchEvent, updateTranscriptFromHistory, buildCurrentInstructions],
  );

  const wake = useCallback(async () => {
    if (realtimeSessionRef.current) {
      dispatchEvent({ type: "WAKE" });
      return;
    }

    dispatchEvent({ type: "WAKE" });
    dispatchEvent({ type: "CONNECT_REQUESTED" });
    setConnectionStatus("connecting");
    setLastError(null);

    // Confirm OpenAI is actually reachable before asking the user for microphone access —
    // no point prompting for a permission we can't use.
    let ephemeralKey: string;
    try {
      ephemeralKey = await fetchEphemeralKey();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't connect to OpenAI.";
      setConnectionStatus("error");
      dispatchEvent({ type: "CONNECT_FAILED", message });
      return;
    }

    setMicStatus("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const AudioContextCtor = window.AudioContext ?? (window as unknown as WebkitAudioContextWindow).webkitAudioContext;
      if (AudioContextCtor) {
        const audioContext = new AudioContextCtor();
        audioContextRef.current = audioContext;
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analyserRef.current = analyser;
        runLevelLoop();
      }
      setMicStatus("listening");

      openingPendingRef.current = humourEnabled;
      const tools = createPresentationTools(() => controllerRef.current.controller);
      const agent = new RealtimeAgent({
        name: "jack",
        instructions: buildCurrentInstructions(),
        tools,
        voice: "marin",
      });
      const transport = new OpenAIRealtimeWebRTC({ mediaStream: stream });
      const session = new RealtimeSession(agent, {
        apiKey: ephemeralKey,
        transport,
        model: REALTIME_MODEL,
      });
      wireSessionEvents(session);
      realtimeSessionRef.current = session;

      await session.connect({ apiKey: ephemeralKey });
      setConnectionStatus("connected");
      dispatchEvent({ type: "CONNECTED" });
      dispatchEvent({ type: "WAKE" });
    } catch (err) {
      realtimeSessionRef.current = null;
      teardownMic();
      const message = err instanceof Error ? err.message : "Couldn't connect to OpenAI.";
      const isPermissionDenied = err instanceof DOMException && err.name === "NotAllowedError";
      const isNoDevice = err instanceof DOMException && err.name === "NotFoundError";
      setConnectionStatus("error");
      if (isPermissionDenied) {
        setMicStatus("denied");
        setLastError("Microphone permission was denied. Allow access in your browser's site settings to use Jack.");
        dispatchEvent({ type: "MIC_DENIED" });
      } else if (isNoDevice) {
        setMicStatus("unavailable");
        setLastError("No microphone was found on this device.");
        dispatchEvent({ type: "MIC_UNAVAILABLE" });
      } else {
        setMicStatus("error");
        dispatchEvent({ type: "CONNECT_FAILED", message });
      }
    }
  }, [dispatchEvent, teardownMic, runLevelLoop, humourEnabled, buildCurrentInstructions, fetchEphemeralKey, wireSessionEvents]);

  const sleep = useCallback(() => {
    // Only dispatch SLEEP (which sets the SHARED attentionState to
    // "sleeping") if there was an actual OpenAI Realtime session to tear
    // down. Present mode's unmount cleanup calls sleep() unconditionally as
    // defensive teardown regardless of whether OpenAI was ever connected --
    // and since nothing in the current UI ever calls wake() to establish
    // that connection in the first place, every real call here used to be a
    // no-op session teardown that nonetheless permanently poisoned
    // attentionState to "sleeping" for the rest of the browser session (no
    // local-only code path ever dispatches WAKE to undo it). Confirmed live
    // as captions silently never rendering again after a single visit to
    // Present mode, and (before a separate fix) the local ambient mic
    // refusing to arm anywhere afterward.
    const hadSession = realtimeSessionRef.current !== null;
    realtimeSessionRef.current?.close();
    realtimeSessionRef.current = null;
    teardownMic();
    setMicStatus("off");
    setConnectionStatus("disconnected");
    if (hadSession) dispatchEvent({ type: "SLEEP" });
  }, [teardownMic, dispatchEvent]);

  const mute = useCallback(() => {
    realtimeSessionRef.current?.mute(true);
    setMicStatus("muted");
    dispatchEvent({ type: "MUTE" });
  }, [dispatchEvent]);

  const unmute = useCallback(() => {
    realtimeSessionRef.current?.mute(false);
    setMicStatus("listening");
    dispatchEvent({ type: "UNMUTE" });
  }, [dispatchEvent]);

  const pause = useCallback(() => {
    speechPlayer.unlock(); // must run synchronously inside this click -- see jackSpeechPlayer.ts
    realtimeSessionRef.current?.interrupt();
    controllerRef.current.controller.pausePresentation();
    cancelAutonomousPresentingRef.current(); // manual Pause button must also stop Jack's own narration loop -- audio is already cancelled before the line below fires
    dispatchEvent({ type: "PAUSE" });
    void speakThroughPlayerRef.current("Of course. I'll pause here.");
  }, [dispatchEvent, speechPlayer]);

  const resume = useCallback(() => {
    speechPlayer.unlock();
    controllerRef.current.controller.resumePresentation();
    dispatchEvent({ type: "RESUME" });
    if (presenterControlRef.current === "jack") {
      // Short continuity line, not the full opening (Phase 13/14) -- narration
      // only starts once it's actually finished, so they never overlap.
      void (async () => {
        await speakAndWaitRef.current(pickResumeLine(humourEnabled));
        startAutonomousPresentingRef.current();
      })();
    }
  }, [dispatchEvent, speechPlayer, humourEnabled]);

  const interrupt = useCallback(() => {
    speechPlayer.unlock();
    realtimeSessionRef.current?.interrupt();
    cancelAutonomousPresentingRef.current(); // manual Stop must also cancel local narration + pending advance -- audio is already cancelled before the acknowledgement below fires
    void speakThroughPlayerRef.current("Sure. I'll stop here.");
  }, [speechPlayer]);

  const sendText = useCallback((text: string) => {
    realtimeSessionRef.current?.sendMessage(text);
  }, []);

  const retryConnection = useCallback(async () => {
    setLastError(null);
    await wake();
  }, [wake]);

  const registerController = useCallback(
    (modeName: string, controller: PresentationController) => {
      controllerRef.current = { name: modeName, controller };
      realtimeSessionRef.current?.transport.updateSessionConfig({ instructions: buildCurrentInstructions() });
    },
    [buildCurrentInstructions],
  );

  const unregisterController = useCallback(() => {
    controllerRef.current = { name: "idle", controller: unsupportedController("no active mode") };
  }, []);

  const endSession = useCallback(() => {
    // Same fix as sleep() above and for the same reason: only dispatch
    // DISCONNECTED (-> attentionState "disconnected", permanently, since
    // nothing local-only ever dispatches WAKE/CONNECTED to undo it) if there
    // was a real OpenAI Realtime session to disconnect from. endSession()
    // runs on every single "Exit presentation" click -- far more often than
    // sleep()'s unmount-only path -- so this was the MORE common real-world
    // trigger for attentionState getting stuck, confirmed live as captions
    // silently never rendering again after simply exiting a presentation
    // once via the Exit button.
    const hadSession = realtimeSessionRef.current !== null;
    realtimeSessionRef.current?.close();
    realtimeSessionRef.current = null;
    teardownMic();
    wakeWordService.stop();
    cancelAutonomousPresentingRef.current();
    setMicStatus("off");
    setConnectionStatus("disconnected");
    setTranscript([]);
    setCurrentCaption("");
    humourUsedRef.current = false;
    openingPendingRef.current = false;
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
    if (hadSession) dispatchEvent({ type: "DISCONNECTED" });
  }, [teardownMic, dispatchEvent, wakeWordService]);

  // --- Controlled Jack speech (Phase 6) ---------------------------------
  const stopJackAudio = useCallback(() => {
    speechPlayer.stop();
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
    async (text: string) => {
      setCurrentCaption(text);
      try {
        const audio = await jackApi.speak(text, voice);
        dispatchEvent({ type: "AUDIO_START" });
        speechPlayer.play(audio, () => dispatchEvent({ type: "AUDIO_STOPPED" }));
      } catch {
        // Kokoro unavailable -- text already shown via currentCaption; speech is best-effort.
      }
    },
    [dispatchEvent, speechPlayer, voice],
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
    (text: string): Promise<void> =>
      new Promise((resolve) => {
        setCurrentCaption(text);
        jackApi
          .speak(text, voice)
          .then((audio) => {
            dispatchEvent({ type: "AUDIO_START" });
            speechPlayer.play(audio, () => {
              dispatchEvent({ type: "AUDIO_STOPPED" });
              resolve();
            });
          })
          .catch(() => resolve()); // Kokoro unavailable -- don't block the caller's continuation
      }),
    [dispatchEvent, speechPlayer, voice],
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
      setCurrentCaption(trimmed);
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
    [dispatchEvent, speechPlayer, voice, browserFallbackEnabled, offlineSpeechSupported, speakOffline],
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
    await speakAndWait(pickGreeting(humourEnabled));
  }, [speechPlayer, speakAndWait, humourEnabled]);

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
    setCurrentCaption("");
    if (bargeInPhaseRef.current !== "idle") {
      setBargeInPhaseBoth("idle");
      clearBargeInArmTimers();
      clearBargeInCaptureTimeout();
      console.log("[mic] stop() called from: cancelAutonomousPresenting");
      void localRecorder.stop(); // discard whatever was captured -- cancellation, not a command
    }
  }, [stopJackAudio, clearBargeInArmTimers, clearBargeInCaptureTimeout, localRecorder, setBargeInPhaseBoth]);

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

      const controller = controllerRef.current.controller;
      const context: PresentationContext | null = buildPresentationContext(controller, slideIndex);
      if (!context) {
        cancelAutonomousPresenting();
        return;
      }

      dispatchEvent({ type: "LOCAL_COMMAND_START" }); // -> thinking
      // Decided (not just checked) here, before generation: the model is
      // about to be told "this is the opening" or "you already opened" one
      // way or the other, so the flag must reflect that choice from this
      // point on, even if this specific narration attempt later fails.
      const isOpening = !presentationOpeningDeliveredRef.current;
      presentationOpeningDeliveredRef.current = true;
      let narrationText: string;
      try {
        narrationText = await generateSlideNarration(context, isOpening, humourEnabled);
      } catch (err) {
        // Phase 17: LLM failure during autonomy -- stop, don't guess, stay put.
        cancelAutonomousPresenting();
        setLastError(err instanceof Error ? err.message : "Jack couldn't prepare narration for this slide.");
        return;
      }
      if (!stillCurrent()) return;

      let audio: Blob;
      try {
        audio = await jackApi.speak(narrationText, voice);
      } catch (err) {
        // Phase 17: Kokoro failure -- show the text, stop autonomy, hand control back safely.
        setCurrentCaption(narrationText);
        cancelAutonomousPresenting();
        setLastError(err instanceof Error ? err.message : "Jack's voice is unavailable right now.");
        return;
      }
      if (!stillCurrent()) return;

      setCurrentCaption(narrationText);
      dispatchEvent({ type: "AUDIO_START" });
      speechPlayer.play(audio, () => {
        dispatchEvent({ type: "AUDIO_STOPPED" });
        if (!stillCurrent()) return; // cancelled/interrupted during playback -- do NOT advance
        const advance = controller.goToNextSlide();
        if (!advance.success) {
          // Phase 5: end of deck -- finish cleanly, do not wrap to slide 1.
          controller.pausePresentation();
          cancelAutonomousPresenting();
          return;
        }
        // Pass the index goToNextSlide() just returned, not "whatever
        // current looks like now" -- see runNarrationStep's param comment.
        void runNarrationStep(generation, advance.data.index);
      });
    },
    [cancelAutonomousPresenting, dispatchEvent, speechPlayer, voice, humourEnabled],
  );

  const startAutonomousPresenting = useCallback(() => {
    narrationGenerationRef.current += 1;
    const generation = narrationGenerationRef.current;
    narrationActiveRef.current = true;
    setIsPresentingAutonomously(true);
    void runNarrationStep(generation);
  }, [runNarrationStep]);

  useEffect(() => {
    cancelAutonomousPresentingRef.current = cancelAutonomousPresenting;
    startAutonomousPresentingRef.current = startAutonomousPresenting;
  }, [cancelAutonomousPresenting, startAutonomousPresenting]);

  // Ambient barge-in picks up EVERY sustained sound over threshold -- room
  // noise, someone else talking, a cough -- not just remarks actually meant
  // for Jack. Unlike push-to-talk (an explicit button press, always meant
  // for Jack) or typed text, a barge-in transcript must actually name Jack
  // before it's treated as a command/question; otherwise it's silently
  // discarded here, before ever reaching runLocalCommand or the UI.
  const isAddressedToJack = useCallback((transcript: string) => /\bjack\b/i.test(transcript), []);

  // --- Barge-in: capture finished (silence/timeout) -> transcribe -> route ---
  const finishBargeInCapture = useCallback(async () => {
    setBargeInPhaseBoth("idle");
    clearBargeInCaptureTimeout();
    console.log("[mic] stop() called from: finishBargeInCapture");
    const audio = await localRecorder.stop();
    if (!audio) {
      dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
      return;
    }
    dispatchEvent({ type: "LOCAL_COMMAND_START" });
    try {
      const result = await jackApi.transcribeAudio(audio, undefined, asrProvider);
      const transcript = result.text.trim();
      if (!transcript || !isAddressedToJack(transcript)) {
        // Ambient noise / background speech that never named Jack -- ignore
        // it entirely rather than surfacing it as a failed "Interruption".
        recordAsrDiagnostic({ provider: result.provider, transcript, latencyMs: result.latencyMs, success: true });
        dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
        return;
      }
      // Reuses the exact same intent-routing path as typed/push-to-talk
      // input -- interruption is just another way text reaches Jack.
      // runLocalCommand itself records the outcome (kind: "interruption")
      // into the single shared lastCommand* state -- no separate tracking
      // needed here, and nothing about to become stale later.
      const outcome = await runLocalCommandRef.current(transcript, "interruption");
      recordAsrDiagnostic({
        provider: result.provider,
        transcript,
        latencyMs: result.latencyMs,
        success: true,
        downstreamOk: outcome.ok,
      });
    } catch (err) {
      dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
      setLastError(err instanceof Error ? err.message : "Transcription failed.");
      recordAsrDiagnostic({ provider: asrProvider, transcript: "", latencyMs: 0, success: false });
    }
  }, [clearBargeInCaptureTimeout, localRecorder, dispatchEvent, setBargeInPhaseBoth, isAddressedToJack, asrProvider, recordAsrDiagnostic]);

  const handleBargeInDetected = useCallback(() => {
    setBargeInPhaseBoth("capturing");
    bargeInSilenceStartRef.current = null;
    narrationGenerationRef.current += 1; // invalidate the in-flight narration step
    narrationActiveRef.current = false;
    setIsPresentingAutonomously(false);
    stopJackAudio(); // cancel, not natural completion -- no auto-advance
    dispatchEvent({ type: "USER_SPEECH_DETECTED" }); // speaking -> listening (existing transition)
    clearBargeInArmTimers();
    clearBargeInCaptureTimeout();
    const captureStarted = Date.now();
    let finished = false;
    // Polling interval, not a level-keyed effect: true silence can hold at
    // an exactly-constant level (e.g. 0) for the whole capture, which would
    // never re-fire a useEffect dependency on that value. This runs on its
    // own clock regardless of whether the level state technically "changes".
    bargeInCaptureTimeoutRef.current = setInterval(() => {
      const now = Date.now();
      const level = localMicLevelRef.current;
      if (level < BARGE_IN_LEVEL) {
        if (bargeInSilenceStartRef.current === null) bargeInSilenceStartRef.current = now;
      } else {
        bargeInSilenceStartRef.current = null;
      }
      const sustainedSilence =
        bargeInSilenceStartRef.current !== null && now - bargeInSilenceStartRef.current > BARGE_IN_SILENCE_MS;
      const hardCap = now - captureStarted > BARGE_IN_MAX_CAPTURE_MS;
      if ((sustainedSilence || hardCap) && !finished) {
        finished = true;
        clearBargeInCaptureTimeout();
        void finishBargeInCapture();
      }
    }, 150);
  }, [stopJackAudio, dispatchEvent, clearBargeInArmTimers, clearBargeInCaptureTimeout, finishBargeInCapture]);

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
    const autoArmWhileJackPresents = presenterControl === "jack" && (attentionState === "speaking" || attentionState === "standby");
    const shouldArm = ambientListeningEnabled || autoArmWhileJackPresents;
    if (shouldArm && bargeInPhaseRef.current === "idle") {
      setBargeInPhaseBoth("guarding");
      bargeInLoudTicksRef.current = 0;
      console.log("[mic] start() called from: arm effect (armed)", { attentionState, presenterControl });
      void localRecorder.start();
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
          const threshold = Math.max(BARGE_IN_LEVEL, floor + BARGE_IN_FLOOR_MARGIN);
          bargeInEffectiveThresholdRef.current = threshold;
          setBargeInNoiseFloor(floor);
          setBargeInThreshold(threshold);
          bargeInLoudTicksRef.current = 0;
          setBargeInPhaseBoth("armed");
        }, BARGE_IN_CALIBRATION_MS);
      }, BARGE_IN_ARM_GUARD_MS);
    } else if (!shouldArm && bargeInPhaseRef.current !== "idle" && bargeInPhaseRef.current !== "capturing") {
      // Jack finished/was stopped before completing calibration or without a
      // detected interruption -- disarm and discard.
      setBargeInPhaseBoth("idle");
      clearBargeInArmTimers();
      console.log("[mic] stop() called from: disarm effect", { attentionState, presenterControl });
      void localRecorder.stop();
    }
    // "capturing" is left alone here; handleBargeInDetected/finishBargeInCapture own that transition.
  }, [attentionState, presenterControl, ambientListeningEnabled, localRecorder, clearBargeInArmTimers, setBargeInPhaseBoth]);

  // Watches mic level while armed for a sustained loud burst -> real
  // interruption, against this utterance's calibrated effective threshold
  // (see the arm/disarm effect above), not the bare BARGE_IN_LEVEL constant.
  // (Silence detection during "capturing" is handled by the interval started
  // in handleBargeInDetected, not here -- see its comment.) First-pass
  // level-threshold VAD, not perfect acoustic echo cancellation -- see the
  // "Real-Hardware Limitation" section of the milestone report.
  useEffect(() => {
    if (bargeInPhaseRef.current !== "armed") return;
    if (localRecorder.level > bargeInEffectiveThresholdRef.current) {
      bargeInLoudTicksRef.current += 1;
      if (bargeInLoudTicksRef.current >= BARGE_IN_SUSTAIN_TICKS) {
        bargeInLoudTicksRef.current = 0;
        handleBargeInDetected();
      }
    } else {
      bargeInLoudTicksRef.current = 0;
    }
  }, [localRecorder.level, handleBargeInDetected]);

  const runLocalCommand = useCallback(
    async (text: string, kind: "typed" | "voice" | "interruption" = "typed"): Promise<LocalCommandOutcome> => {
      // Every exit path funnels through here so lastCommand* always reflects
      // whichever call to runLocalCommand most recently finished -- see the
      // comment on lastCommandOutcome in the context interface above.
      const finish = (outcome: LocalCommandOutcome) => {
        recordCommandOutcome(text, outcome, kind);
        return outcome;
      };

      // Typed submission is a real user gesture -- must unlock synchronously
      // within it (see jackSpeechPlayer.ts). Voice-triggered calls are
      // already covered by the mic button's own unlock(), so this is
      // harmless, idempotent reinforcement there.
      speechPlayer.unlock();
      dispatchEvent({ type: "LOCAL_COMMAND_START" });
      const controller = controllerRef.current.controller;
      try {
        const intent = await jackApi.detectIntent(text);
        dispatchEvent({ type: "LOCAL_COMMAND_ACTING" });

        // Phase 1 safety gate: the presentation may ONLY change for
        // type === "action". Conversation/unknown never reach the switch
        // below, no matter what the model happened to put in `action`.
        if (intent.type === "unknown") {
          dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
          const message = "I only heard part of that. Please try again.";
          void speakThroughPlayer(message);
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
            return finish({ source: intent.source, ok: true, message: "Jack is staying quiet -- audience questions go to you." });
          }
          if (audiencePolicyApplies && audienceQuestionPolicy === "moderatedQueue") {
            queueQuestion(text);
            dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
            const ack = "Noted -- I'll leave that one for you to address.";
            void speakThroughPlayer(ack);
            return finish({ source: intent.source, ok: true, message: ack });
          }

          const ctx = buildPresentationContext(controller);
          const { parsedDocs, activeFileId } = appSessionRef.current;
          // Ask Jack has no live narration to keep pace with and exists
          // specifically for deep material knowledge -- give it a much wider
          // slice of the deck than Present/Practice's lean, real-time
          // narration-context Q&A (see retrieveForQuestion's comment).
          const { answer } = await answerDeckQuestion(
            text,
            ctx ?? { deckTitle: "", currentSlideNumber: 0, totalSlides: 0, currentSlideText: "" },
            Object.values(parsedDocs),
            activeFileId,
            inAskJackMode,
          );
          dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
          void speakThroughPlayer(answer); // sets currentCaption itself
          return finish({ source: intent.source, ok: true, message: answer });
        }

        const action = intent.action as JackIntentAction | undefined;

        if (action === "explain_slide" || action === "summarize_slide") {
          cancelAutonomousPresenting();
          const ctx = buildPresentationContext(controller);
          const instruction =
            action === "explain_slide"
              ? "Explain this slide to the audience in 2-3 concise sentences."
              : "Summarize this slide in one or two sentences.";
          const prompt = ctx ? `${formatContextForPrompt(ctx)}\n\n${instruction}` : instruction;
          const chat = await jackApi.chat([{ role: "user", content: prompt }], { maxTokens: 150 });
          dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
          void speakThroughPlayer(chat.content); // sets currentCaption itself
          return finish({ source: intent.source, action, ok: true, message: chat.content });
        }

        let result: { success: boolean; error?: string } | null = null;
        switch (action) {
          case "start_presentation":
            result = controller.startPresentation();
            if (result.success) {
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
              void (async () => {
                if (!jackAwakeRef.current) await wakeJackLocal();
                await speakAndWait(ack);
                startAutonomousPresenting();
              })();
            }
            break;
          case "next_slide":
            cancelAutonomousPresenting();
            result = controller.goToNextSlide();
            break;
          case "previous_slide":
            cancelAutonomousPresenting();
            result = controller.goToPreviousSlide();
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
            break;
          }
          case "pause_presentation":
            cancelAutonomousPresenting(); // stops current audio/narration before the acknowledgement below fires
            result = controller.pausePresentation();
            if (result.success) void speakThroughPlayer("Of course. I'll pause here.");
            break;
          case "resume_presentation":
            result = controller.resumePresentation();
            if (result.success && presenterControlRef.current === "jack") {
              // Phase 13/14: short continuity line, NOT the full opening --
              // narration only starts once it's actually finished speaking,
              // so they never overlap. Regenerates for the CURRENT slide,
              // never skips ahead.
              void (async () => {
                await speakAndWait(pickResumeLine(humourEnabled));
                startAutonomousPresenting();
              })();
            }
            break;
          case "handoff_to_presenter":
            cancelAutonomousPresenting(); // stops current audio/narration before the acknowledgement below fires
            result = controller.handControlToPresenter();
            if (result.success) {
              setPresenterControl("presenter");
              void speakThroughPlayer("Absolutely. It's yours.");
            }
            break;
          case "stop_presentation":
            cancelAutonomousPresenting();
            result = controller.endPresentation();
            setPresenterControl("presenter");
            break;
          default:
            result = { success: false, error: `Jack didn't recognize "${text}" as a presentation command.` };
        }

        dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
        // Success paths above already speak their own acknowledgement/answer
        // through speakThroughPlayer/speakAndWait -- this only covers the
        // ones that fall through to here with a failure, which previously
        // left Jack completely silent (the failure only ever reached the
        // UI as text), e.g. "Couldn't find a slide matching ...".
        if (!(result?.success ?? false) && result?.error) {
          void speakThroughPlayer(result.error);
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
        void speakThroughPlayer(message);
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

  // Push updated instructions to a live session whenever behavior-affecting settings change.
  useEffect(() => {
    if (realtimeSessionRef.current && connectionStatus === "connected") {
      realtimeSessionRef.current.transport.updateSessionConfig({ instructions: buildCurrentInstructions() });
    }
  }, [buildCurrentInstructions, connectionStatus]);

  useEffect(() => {
    return () => {
      realtimeSessionRef.current?.close();
      teardownMic();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendingAudioToOpenAI =
    connectionStatus === "connected" &&
    micStatus === "listening" &&
    attentionState !== "sleeping" &&
    attentionState !== "muted" &&
    attentionState !== "disconnected";

  const localUnavailable =
    jackLocalHealth !== null && jackLocalHealth.llamacpp === "unavailable" && jackLocalHealth.colibri === "unavailable";

  const value: JackContextValue = {
    attentionState,
    orb: toOrbPresentation(attentionState),
    connectionStatus,
    micStatus,
    micLevel,
    sendingAudioToOpenAI,
    transcript,
    currentCaption,
    lastError,
    controlMode,
    audienceQuestionPolicy,
    humourEnabled,
    language,
    voice,
    captionsEnabled,
    browserFallbackEnabled,
    asrProvider,
    asrDiagnostics,
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
    wake,
    sleep,
    mute,
    unmute,
    pause,
    resume,
    interrupt,
    retryConnection,
    sendText,
    setControlMode: setControlModeState,
    setAudienceQuestionPolicy: setAudienceQuestionPolicyState,
    setHumourEnabled: setHumourEnabledState,
    setLanguage,
    registerController,
    unregisterController,
    endSession,
    runLocalCommand,
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

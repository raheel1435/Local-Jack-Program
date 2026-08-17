"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, type RealtimeItem } from "@openai/agents-realtime";
import { useLocalRecorder, type LocalRecorderState } from "../hooks/useLocalRecorder";
import { useSpeech, type UseSpeechResult } from "../hooks/useSpeech";
import { jackApi, type JackHealth, type JackIntentAction } from "../lib/jackApi";
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
const BARGE_IN_SUSTAIN_TICKS = 4; // consecutive over-threshold rAF ticks before it counts as real speech
const BARGE_IN_SILENCE_MS = 900; // sustained quiet before auto-ending the captured utterance
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
const BARGE_IN_FLOOR_MARGIN = 0.06;

export interface LocalCommandOutcome {
  source: "deterministic" | "llm";
  action?: string;
  ok: boolean;
  /** Human-readable result: the failure reason, Jack's spoken answer, or a conversational reply. */
  message?: string;
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
  setVoice(voice: string): void;
  setCaptionsEnabled(enabled: boolean): void;
  setBrowserFallbackEnabled(enabled: boolean): void;
  /**
   * The ONE authoritative "Read this slide" path (Phase 9/11/17): Kokoro with
   * the selected voice, falling back to the browser's speechSynthesis only if
   * browserFallbackEnabled is on AND the Kokoro request itself fails. Reads
   * once and stops -- no auto-advance, no persona change.
   */
  readCurrentSlide(text: string): Promise<void>;
  /** True once Jack has been explicitly activated for this local-pipeline session (Phase 1/2) -- independent of attentionState's sleeping/standby, which belongs to the unused OpenAI Realtime path in Present mode. */
  jackAwake: boolean;
  /** The ONE authoritative activation function (Phase 2) -- idempotent, greets once per sleeping->awake transition (Phase 5). */
  wakeJackLocal(): Promise<void>;
  /** Explicit local sleep -- stops any current speech/narration and resets the wake guard so the next wake greets again. */
  sleepJackLocal(): void;
  questions: QueuedQuestion[];
  wakeWordMode: "local-wake-word" | "push-to-talk";
  wakeWordAvailable: boolean;

  /** Who currently owns slide navigation. Set by start_presentation (-> jack) and handoff_to_presenter (-> human) via runLocalCommand, or explicitly. */
  presenterControl: ControlOwner;
  setPresenterControl(owner: ControlOwner): void;
  /** Jack-Local-AI-Service reachability -- polled independently of the OpenAI Realtime connection, so manual mode can always report an honest status even when Jack is fully offline. */
  jackLocalHealth: JackHealth | null;

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

  /** Push-to-talk capture -> whisper.cpp -> runLocalCommand, entirely local (no OpenAI). */
  localMicState: LocalRecorderState;
  localMicLevel: number;
  localMicError: string | null;
  startLocalListening(): Promise<void>;
  stopLocalListening(): Promise<{ transcript: string; outcome: LocalCommandOutcome } | null>;

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
  const [questions] = useState<QueuedQuestion[]>([]);
  const [presenterControl, setPresenterControl] = useState<ControlOwner>("presenter");
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
    realtimeSessionRef.current?.close();
    realtimeSessionRef.current = null;
    teardownMic();
    setMicStatus("off");
    setConnectionStatus("disconnected");
    dispatchEvent({ type: "SLEEP" });
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
    if (presenterControlRef.current === "jack") startAutonomousPresentingRef.current();
    dispatchEvent({ type: "RESUME" });
  }, [dispatchEvent, speechPlayer]);

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
    dispatchEvent({ type: "DISCONNECTED" });
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

  /** Sleep is explicit and local -- stops any current speech/narration and resets the wake guard so the next wake greets again. */
  const sleepJackLocal = useCallback(() => {
    cancelAutonomousPresentingRef.current();
    jackAwakeRef.current = false;
    setJackAwake(false);
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
    if (bargeInPhaseRef.current !== "idle") {
      setBargeInPhaseBoth("idle");
      clearBargeInArmTimers();
      clearBargeInCaptureTimeout();
      console.log("[mic] stop() called from: cancelAutonomousPresenting");
      void localRecorder.stop(); // discard whatever was captured -- cancellation, not a command
    }
  }, [stopJackAudio, clearBargeInArmTimers, clearBargeInCaptureTimeout, localRecorder, setBargeInPhaseBoth]);

  const runNarrationStep = useCallback(
    async (generation: number) => {
      const stillCurrent = () => narrationGenerationRef.current === generation && narrationActiveRef.current;
      if (!stillCurrent()) return;

      const controller = controllerRef.current.controller;
      const context: PresentationContext | null = buildPresentationContext(controller);
      if (!context) {
        cancelAutonomousPresenting();
        return;
      }

      dispatchEvent({ type: "LOCAL_COMMAND_START" }); // -> thinking
      let narrationText: string;
      try {
        narrationText = await generateSlideNarration(context);
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
        void runNarrationStep(generation);
      });
    },
    [cancelAutonomousPresenting, dispatchEvent, speechPlayer, voice],
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
      const { text } = await jackApi.transcribeAudio(audio);
      const transcript = text.trim();
      if (!transcript) {
        dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
        return;
      }
      // Reuses the exact same intent-routing path as typed/push-to-talk
      // input -- interruption is just another way text reaches Jack.
      // runLocalCommand itself records the outcome (kind: "interruption")
      // into the single shared lastCommand* state -- no separate tracking
      // needed here, and nothing about to become stale later.
      await runLocalCommandRef.current(transcript, "interruption");
    } catch (err) {
      dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
      setLastError(err instanceof Error ? err.message : "Transcription failed.");
    }
  }, [clearBargeInCaptureTimeout, localRecorder, dispatchEvent, setBargeInPhaseBoth]);

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

  // Arm/disarm ambient listening as Jack's own autonomous speech starts and
  // stops. Only while Jack himself holds the floor (presenterControl ===
  // "jack") -- barge-in during a human-triggered explain/summarize answer is
  // out of scope for this milestone.
  //
  // Sequence once Jack starts speaking: start the recorder immediately (so
  // there's no audio gap), but hold off actually watching for a burst for
  // BARGE_IN_ARM_GUARD_MS (skips the playback-start transient), then spend
  // BARGE_IN_CALIBRATION_MS sampling the level to set an effective threshold
  // for this utterance, THEN arm. All timers are on their own clock (not a
  // level-keyed effect) for the same reason the capture-silence poll is --
  // see its comment.
  useEffect(() => {
    const shouldArm = attentionState === "speaking" && presenterControl === "jack";
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
  }, [attentionState, presenterControl, localRecorder, clearBargeInArmTimers, setBargeInPhaseBoth]);

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
          return finish({ source: intent.source, ok: false, message: "I only heard part of that. Please try again." });
        }

        if (intent.type === "conversation") {
          // Any conversational turn pauses autonomy first -- Phase 12: after
          // an answer, Jack stays paused until an explicit "Continue.".
          cancelAutonomousPresenting();
          const ctx = buildPresentationContext(controller);
          const { parsedDocs, activeFileId } = appSessionRef.current;
          const { answer } = await answerDeckQuestion(
            text,
            ctx ?? { deckTitle: "", currentSlideNumber: 0, totalSlides: 0, currentSlideText: "" },
            Object.values(parsedDocs),
            activeFileId,
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
              void (async () => {
                if (!jackAwakeRef.current) await wakeJackLocal();
                await speakAndWait(pickTakeoverAck());
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
              // Phase 10: regenerate/restart narration for the CURRENT slide -- never skip ahead.
              startAutonomousPresenting();
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
        return finish({
          source: intent.source,
          action,
          ok: result?.success ?? false,
          message: result?.success ? undefined : result?.error,
        });
      } catch (err) {
        dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
        return finish({
          source: "llm",
          ok: false,
          message: err instanceof Error ? err.message : "Local Jack request failed.",
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
    ],
  );

  useEffect(() => {
    runLocalCommandRef.current = runLocalCommand;
  }, [runLocalCommand]);

  const startLocalListening = useCallback(async () => {
    setLastError(null);
    // Recorder ownership: an explicit push-to-talk click always wins over
    // barge-in's ambient monitoring AND over Jack's autonomous narration
    // loop -- not just barge-in's listening phase. An earlier version of
    // this fix only cleared bargeInPhaseRef, which left the narration loop
    // running; if Jack's current utterance then finished naturally, its
    // onEnded callback (never invalidated) would advance and start a new
    // narration step, dispatch AUDIO_START, re-arm barge-in (since
    // presenterControl was still "jack"), and barge-in's own arm effect
    // would call localRecorder.start() again -- which, via this hook's
    // defensive teardown-before-start, tore down push-to-talk's still-
    // recording session out from under it mid-capture. Confirmed live: this
    // produced a genuine short/garbled transcript purely from the handoff
    // race, not from anything the user actually said. cancelAutonomousPresenting
    // stops the audio, invalidates the generation counter so no orphaned
    // step can restart it, AND disarms barge-in -- the complete cleanup,
    // not a partial one.
    //
    // Still not quite enough on its own: cancelAutonomousPresenting resets
    // bargeInPhaseRef to "idle" but does NOT change attentionState, which
    // stays "speaking" until something dispatches an event that moves it.
    // The barge-in arm effect's condition is `shouldArm = attentionState
    // === "speaking" && presenterControl === "jack"` -- if a render happens
    // in the gap between the reset above and localRecorder.start() actually
    // opening a new session, shouldArm is STILL true (attentionState hasn't
    // caught up) and bargeInPhaseRef.current IS "idle" again, so the arm
    // effect immediately re-arms and calls localRecorder.start() a SECOND
    // time, racing this function's own start() call. Dispatching
    // LOCAL_MIC_START *before* starting the recorder (not after, as it read
    // previously) flips attentionState to "listening" in the same
    // synchronous batch as cancelAutonomousPresenting's updates, so
    // shouldArm is already false by the time anything re-renders -- closes
    // the window instead of just narrowing it.
    speechPlayer.unlock(); // real user gesture -- covers any Jack speech triggered by the command this capture produces
    cancelAutonomousPresenting();
    dispatchEvent({ type: "LOCAL_MIC_START" });
    console.log("[mic] start() called from: startLocalListening (push-to-talk)");
    await localRecorder.start();
  }, [localRecorder, dispatchEvent, cancelAutonomousPresenting, speechPlayer]);

  const stopLocalListening = useCallback(async (): Promise<{ transcript: string; outcome: LocalCommandOutcome } | null> => {
    console.log("[mic] stop() called from: stopLocalListening (push-to-talk)");
    const audio = await localRecorder.stop();
    if (!audio) {
      dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
      recordCommandOutcome("", { source: "deterministic", ok: false, message: "Couldn't understand that." }, "voice");
      return null;
    }
    dispatchEvent({ type: "LOCAL_COMMAND_START" });
    try {
      const { text } = await jackApi.transcribeAudio(audio);
      const transcript = text.trim();
      if (!transcript) {
        dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
        recordCommandOutcome("", { source: "deterministic", ok: false, message: "Couldn't understand that." }, "voice");
        return null;
      }
      const outcome = await runLocalCommand(transcript, "voice");
      return { transcript, outcome };
    } catch {
      dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
      const whisperUnavailable = jackLocalHealth?.whisper === "unavailable";
      const message = whisperUnavailable ? "Jack Local AI unavailable." : "Couldn't understand that.";
      recordCommandOutcome("", { source: "deterministic", ok: false, message }, "voice");
      return { transcript: "", outcome: { source: "deterministic", ok: false, message } };
    }
  }, [localRecorder, dispatchEvent, runLocalCommand, recordCommandOutcome, jackLocalHealth]);

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
    setVoice,
    setCaptionsEnabled,
    setBrowserFallbackEnabled,
    readCurrentSlide,
    jackAwake,
    wakeJackLocal,
    sleepJackLocal,
    questions,
    wakeWordMode: wakeWordService.mode,
    wakeWordAvailable: wakeWordService.available,
    presenterControl,
    setPresenterControl,
    jackLocalHealth,
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
    startLocalListening,
    stopLocalListening,
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

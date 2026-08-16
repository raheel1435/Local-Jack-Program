"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, type RealtimeItem } from "@openai/agents-realtime";
import { useLocalRecorder, type LocalRecorderState } from "../hooks/useLocalRecorder";
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
// meter code. These are first-pass thresholds (see Phase 9 caveats in the
// milestone report) -- not validated against real acoustic hardware/echo.
const BARGE_IN_LEVEL = 0.12;
const BARGE_IN_SUSTAIN_TICKS = 4; // consecutive over-threshold rAF ticks before it counts as real speech
const BARGE_IN_SILENCE_MS = 900; // sustained quiet before auto-ending the captured utterance
const BARGE_IN_MAX_CAPTURE_MS = 8000; // hard cap so a stuck capture can't hang forever

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
  runLocalCommand(text: string): Promise<LocalCommandOutcome>;

  /** Push-to-talk capture -> whisper.cpp -> runLocalCommand, entirely local (no OpenAI). */
  localMicState: LocalRecorderState;
  localMicLevel: number;
  localMicError: string | null;
  startLocalListening(): Promise<void>;
  stopLocalListening(): Promise<{ transcript: string; outcome: LocalCommandOutcome } | null>;

  /** True while Jack's autonomous narrate-then-advance loop is running (presenterControl === "jack" and not paused/interrupted). */
  isPresentingAutonomously: boolean;

  /** Set only by barge-in (typed/push-to-talk callers already get this as runLocalCommand's/stopLocalListening's return value). */
  lastBargeInTranscript: string | null;
  lastLocalCommandOutcome: LocalCommandOutcome | null;
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
  const [lastLocalCommandOutcome, setLastLocalCommandOutcome] = useState<LocalCommandOutcome | null>(null);
  const [lastBargeInTranscript, setLastBargeInTranscript] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [controlMode, setControlModeState] = useState<ControlMode>("presenterLeads");
  const [audienceQuestionPolicy, setAudienceQuestionPolicyState] = useState<AudienceQuestionPolicy>("askPresenterFirst");
  const [humourEnabled, setHumourEnabledState] = useState(true);
  const [language, setLanguageState] = useState("English");
  const [questions] = useState<QueuedQuestion[]>([]);
  const [presenterControl, setPresenterControl] = useState<ControlOwner>("presenter");
  const [jackLocalHealth, setJackLocalHealth] = useState<JackHealth | null>(null);
  const [isPresentingAutonomously, setIsPresentingAutonomously] = useState(false);
  const localRecorder = useLocalRecorder();
  const presenterControlRef = useRef(presenterControl);
  useEffect(() => {
    presenterControlRef.current = presenterControl;
  }, [presenterControl]);

  const [speechPlayer] = useState(() => createJackSpeechPlayer());
  const narrationGenerationRef = useRef(0);
  const narrationActiveRef = useRef(false);
  // "idle": not listening for interruption. "armed": Jack is speaking, watching
  // mic level for a loud-enough burst to count as a real interruption.
  // "capturing": interruption detected, audio stopped, recording the presenter's utterance.
  const bargeInPhaseRef = useRef<"idle" | "armed" | "capturing">("idle");
  const bargeInLoudTicksRef = useRef(0);
  const bargeInSilenceStartRef = useRef<number | null>(null);
  const bargeInCaptureTimeoutRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Kept in sync with localRecorder.level so the interval-based silence
  // poll below can read the CURRENT level without depending on a React
  // effect re-running -- level settling at an exactly-constant value (e.g.
  // true digital silence, 0) never re-fires a useEffect keyed on it, since
  // React skips updates that don't change by Object.is. An interval sidesteps that.
  const localMicLevelRef = useRef(0);
  // Lets finishBargeInCapture (defined before runLocalCommand, since
  // runLocalCommand itself needs the barge-in machinery) call the latest
  // runLocalCommand without a circular useCallback dependency.
  const runLocalCommandRef = useRef<(text: string) => Promise<LocalCommandOutcome>>(
    async () => ({ source: "deterministic", ok: false, message: "Jack isn't ready yet." }),
  );
  // Same forward-reference pattern for pause()/resume() (defined earlier,
  // for the manual Pause/Resume buttons) to reach the autonomy controls
  // (defined later, since they depend on the speech player/narration deps).
  const cancelAutonomousPresentingRef = useRef<() => void>(() => {});
  const startAutonomousPresentingRef = useRef<() => void>(() => {});

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
    realtimeSessionRef.current?.interrupt();
    controllerRef.current.controller.pausePresentation();
    cancelAutonomousPresentingRef.current(); // manual Pause button must also stop Jack's own narration loop
    dispatchEvent({ type: "PAUSE" });
  }, [dispatchEvent]);

  const resume = useCallback(() => {
    controllerRef.current.controller.resumePresentation();
    if (presenterControlRef.current === "jack") startAutonomousPresentingRef.current();
    dispatchEvent({ type: "RESUME" });
  }, [dispatchEvent]);

  const interrupt = useCallback(() => {
    realtimeSessionRef.current?.interrupt();
    cancelAutonomousPresentingRef.current(); // manual Stop must also cancel local narration + pending advance
  }, []);

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

  /** Fetches Kokoro audio and plays it through the single shared player, with real completion (not a timer) driving AUDIO_START/AUDIO_STOPPED. Failures are swallowed -- the caller's text response already landed. */
  const speakThroughPlayer = useCallback(
    async (text: string) => {
      try {
        const audio = await jackApi.speak(text);
        dispatchEvent({ type: "AUDIO_START" });
        speechPlayer.play(audio, () => dispatchEvent({ type: "AUDIO_STOPPED" }));
      } catch {
        // Kokoro unavailable -- text already shown via currentCaption; speech is best-effort.
      }
    },
    [dispatchEvent, speechPlayer],
  );

  // --- Barge-in capture teardown ------------------------------------------
  const clearBargeInCaptureTimeout = useCallback(() => {
    if (bargeInCaptureTimeoutRef.current !== null) {
      clearInterval(bargeInCaptureTimeoutRef.current);
      bargeInCaptureTimeoutRef.current = null;
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
      bargeInPhaseRef.current = "idle";
      clearBargeInCaptureTimeout();
      void localRecorder.stop(); // discard whatever was captured -- cancellation, not a command
    }
  }, [stopJackAudio, clearBargeInCaptureTimeout, localRecorder]);

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
        audio = await jackApi.speak(narrationText);
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
    [cancelAutonomousPresenting, dispatchEvent, speechPlayer],
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
    bargeInPhaseRef.current = "idle";
    clearBargeInCaptureTimeout();
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
      // input -- interruption is just another way text reaches Jack. The
      // outcome is captured here (unlike typed/mic-button input, nothing
      // else is listening for this call's return value) so the UI can show
      // what an interruption actually resulted in.
      setLastBargeInTranscript(transcript);
      const outcome = await runLocalCommandRef.current(transcript);
      setLastLocalCommandOutcome(outcome);
    } catch (err) {
      dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
      setLastError(err instanceof Error ? err.message : "Transcription failed.");
    }
  }, [clearBargeInCaptureTimeout, localRecorder, dispatchEvent]);

  const handleBargeInDetected = useCallback(() => {
    bargeInPhaseRef.current = "capturing";
    bargeInSilenceStartRef.current = null;
    narrationGenerationRef.current += 1; // invalidate the in-flight narration step
    narrationActiveRef.current = false;
    setIsPresentingAutonomously(false);
    stopJackAudio(); // cancel, not natural completion -- no auto-advance
    dispatchEvent({ type: "USER_SPEECH_DETECTED" }); // speaking -> listening (existing transition)
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
  }, [stopJackAudio, dispatchEvent, clearBargeInCaptureTimeout, finishBargeInCapture]);

  // Arm/disarm ambient listening as Jack's own autonomous speech starts and
  // stops. Only while Jack himself holds the floor (presenterControl ===
  // "jack") -- barge-in during a human-triggered explain/summarize answer is
  // out of scope for this milestone.
  useEffect(() => {
    const shouldArm = attentionState === "speaking" && presenterControl === "jack";
    if (shouldArm && bargeInPhaseRef.current === "idle") {
      bargeInPhaseRef.current = "armed";
      bargeInLoudTicksRef.current = 0;
      void localRecorder.start();
    } else if (!shouldArm && bargeInPhaseRef.current === "armed") {
      // Jack finished/was stopped without a detected interruption -- disarm and discard.
      bargeInPhaseRef.current = "idle";
      void localRecorder.stop();
    }
    // "capturing" is left alone here; handleBargeInDetected/finishBargeInCapture own that transition.
  }, [attentionState, presenterControl, localRecorder]);

  // Watches mic level while armed for a sustained loud burst -> real
  // interruption. (Silence detection during "capturing" is handled by the
  // interval started in handleBargeInDetected, not here -- see its comment.)
  // First-pass level-threshold VAD, not perfect acoustic echo cancellation --
  // see Phase 9 caveats in the milestone report.
  useEffect(() => {
    if (bargeInPhaseRef.current !== "armed") return;
    if (localRecorder.level > BARGE_IN_LEVEL) {
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
    async (text: string): Promise<LocalCommandOutcome> => {
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
          return { source: intent.source, ok: false, message: "I didn't catch a presentation command there." };
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
          setCurrentCaption(answer);
          dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
          void speakThroughPlayer(answer);
          return { source: intent.source, ok: true, message: answer };
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
          setCurrentCaption(chat.content);
          dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
          void speakThroughPlayer(chat.content);
          return { source: intent.source, action, ok: true, message: chat.content };
        }

        let result: { success: boolean; error?: string } | null = null;
        switch (action) {
          case "start_presentation":
            result = controller.startPresentation();
            if (result.success) {
              setPresenterControl("jack");
              startAutonomousPresenting();
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
            cancelAutonomousPresenting();
            result = controller.pausePresentation();
            break;
          case "resume_presentation":
            result = controller.resumePresentation();
            if (result.success && presenterControlRef.current === "jack") {
              // Phase 10: regenerate/restart narration for the CURRENT slide -- never skip ahead.
              startAutonomousPresenting();
            }
            break;
          case "handoff_to_presenter":
            cancelAutonomousPresenting();
            result = controller.handControlToPresenter();
            if (result.success) setPresenterControl("presenter");
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
        return {
          source: intent.source,
          action,
          ok: result?.success ?? false,
          message: result?.success ? undefined : result?.error,
        };
      } catch (err) {
        dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
        return {
          source: "llm",
          ok: false,
          message: err instanceof Error ? err.message : "Local Jack request failed.",
        };
      }
    },
    [dispatchEvent, cancelAutonomousPresenting, startAutonomousPresenting, speakThroughPlayer],
  );

  useEffect(() => {
    runLocalCommandRef.current = runLocalCommand;
  }, [runLocalCommand]);

  const startLocalListening = useCallback(async () => {
    setLastError(null);
    await localRecorder.start();
    dispatchEvent({ type: "LOCAL_MIC_START" });
  }, [localRecorder, dispatchEvent]);

  const stopLocalListening = useCallback(async (): Promise<{ transcript: string; outcome: LocalCommandOutcome } | null> => {
    const audio = await localRecorder.stop();
    if (!audio) {
      dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
      return null;
    }
    dispatchEvent({ type: "LOCAL_COMMAND_START" });
    try {
      const { text } = await jackApi.transcribeAudio(audio);
      const transcript = text.trim();
      if (!transcript) {
        dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
        setLastError("Didn't catch any speech -- try again.");
        return null;
      }
      const outcome = await runLocalCommand(transcript);
      return { transcript, outcome };
    } catch (err) {
      dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
      const message = err instanceof Error ? err.message : "Transcription failed.";
      setLastError(message);
      return { transcript: "", outcome: { source: "deterministic", ok: false, message } };
    }
  }, [localRecorder, dispatchEvent, runLocalCommand]);

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
    setLanguage: setLanguageState,
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
    lastBargeInTranscript,
    lastLocalCommandOutcome,
  };

  return <JackContext.Provider value={value}>{children}</JackContext.Provider>;
}

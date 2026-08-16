"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, type RealtimeItem } from "@openai/agents-realtime";
import { findRelevantSections } from "../lib/askJackProvider";
import { jackApi, type JackHealth, type JackIntentAction } from "../lib/jackApi";
import { summarizeDocuments } from "./documentContext";
import { buildInstructions } from "./instructions";
import { nextAttentionState } from "./jackStateMachine";
import { toOrbPresentation, type OrbPresentation } from "./orbStateMap";
import { buildPresentationContext, formatContextForPrompt } from "./presentationContext";
import { unsupportedController, type PresentationController } from "./presentationController";
import { createPresentationTools } from "./tools";
import { createWakeWordService } from "./wakeWordService";
import { useSession } from "../session/SessionContext";
import type { ParsedDocument } from "../session/types";
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

export interface LocalCommandOutcome {
  source: "deterministic" | "llm";
  action?: string;
  ok: boolean;
  /** Human-readable result: the failure reason, or Jack's spoken answer for explain/summarize. */
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

function playAudioBlob(blob: Blob, onEnded?: () => void) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const cleanup = () => {
    URL.revokeObjectURL(url);
    onEnded?.();
  };
  audio.addEventListener("ended", cleanup);
  audio.addEventListener("error", cleanup);
  void audio.play().catch(cleanup);
}

function resolveSlideIndexFromTarget(
  target: string | undefined,
  parsedDocs: Record<string, ParsedDocument>,
  activeFileId: string | null,
): number | null {
  if (!target) return null;
  const matches = findRelevantSections(target, Object.values(parsedDocs), activeFileId, 1);
  return matches.length > 0 ? matches[0].sectionIndex : null;
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
}

const JackContext = createContext<JackContextValue | null>(null);

export function useJack(): JackContextValue {
  const ctx = useContext(JackContext);
  if (!ctx) throw new Error("useJack must be used within JackProvider");
  return ctx;
}

export function JackProvider({ children }: { children: ReactNode }) {
  const { session: appSession } = useSession();

  const [attentionState, setAttentionState] = useState<JackAttentionState>("disconnected");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [micStatus, setMicStatus] = useState<MicPipelineStatus>("off");
  const [micLevel, setMicLevel] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [currentCaption, setCurrentCaption] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);
  const [controlMode, setControlModeState] = useState<ControlMode>("presenterLeads");
  const [audienceQuestionPolicy, setAudienceQuestionPolicyState] = useState<AudienceQuestionPolicy>("askPresenterFirst");
  const [humourEnabled, setHumourEnabledState] = useState(true);
  const [language, setLanguageState] = useState("English");
  const [questions] = useState<QueuedQuestion[]>([]);
  const [presenterControl, setPresenterControl] = useState<ControlOwner>("presenter");
  const [jackLocalHealth, setJackLocalHealth] = useState<JackHealth | null>(null);

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
    dispatchEvent({ type: "PAUSE" });
  }, [dispatchEvent]);

  const resume = useCallback(() => {
    controllerRef.current.controller.resumePresentation();
    dispatchEvent({ type: "RESUME" });
  }, [dispatchEvent]);

  const interrupt = useCallback(() => {
    realtimeSessionRef.current?.interrupt();
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
    setMicStatus("off");
    setConnectionStatus("disconnected");
    setTranscript([]);
    setCurrentCaption("");
    humourUsedRef.current = false;
    openingPendingRef.current = false;
    dispatchEvent({ type: "DISCONNECTED" });
  }, [teardownMic, dispatchEvent, wakeWordService]);

  const runLocalCommand = useCallback(
    async (text: string): Promise<LocalCommandOutcome> => {
      dispatchEvent({ type: "LOCAL_COMMAND_START" });
      const controller = controllerRef.current.controller;
      try {
        const intent = await jackApi.detectIntent(text);
        dispatchEvent({ type: "LOCAL_COMMAND_ACTING" });
        const action = intent.action as JackIntentAction | undefined;

        if (action === "explain_slide" || action === "summarize_slide") {
          const ctx = buildPresentationContext(controller);
          const instruction =
            action === "explain_slide"
              ? "Explain this slide to the audience in 2-3 concise sentences."
              : "Summarize this slide in one or two sentences.";
          const prompt = ctx ? `${formatContextForPrompt(ctx)}\n\n${instruction}` : instruction;
          const chat = await jackApi.chat([{ role: "user", content: prompt }], { maxTokens: 150 });
          setCurrentCaption(chat.content);
          dispatchEvent({ type: "LOCAL_COMMAND_DONE" });
          void jackApi
            .speak(chat.content)
            .then((blob) => {
              dispatchEvent({ type: "AUDIO_START" });
              playAudioBlob(blob, () => dispatchEvent({ type: "AUDIO_STOPPED" }));
            })
            .catch(() => {
              // Kokoro unavailable -- the text answer above already landed; speech is best-effort.
            });
          return { source: intent.source, action, ok: true, message: chat.content };
        }

        let result: { success: boolean; error?: string } | null = null;
        switch (action) {
          case "start_presentation":
            result = controller.startPresentation();
            if (result.success) setPresenterControl("jack");
            break;
          case "next_slide":
            result = controller.goToNextSlide();
            break;
          case "previous_slide":
            result = controller.goToPreviousSlide();
            break;
          case "jump_to_slide": {
            const index = resolveSlideIndexFromTarget(
              intent.target,
              appSessionRef.current.parsedDocs,
              appSessionRef.current.activeFileId,
            );
            result =
              index === null
                ? { success: false, error: `Couldn't find a slide matching "${intent.target ?? ""}".` }
                : controller.goToSlide(index);
            break;
          }
          case "pause_presentation":
            result = controller.pausePresentation();
            break;
          case "resume_presentation":
            result = controller.resumePresentation();
            break;
          case "handoff_to_presenter":
            result = controller.handControlToPresenter();
            if (result.success) setPresenterControl("presenter");
            break;
          case "stop_presentation":
            result = controller.endPresentation();
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
    [dispatchEvent],
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
  };

  return <JackContext.Provider value={value}>{children}</JackContext.Provider>;
}

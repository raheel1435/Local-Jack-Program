"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, type RealtimeItem } from "@openai/agents-realtime";
import { summarizeDocuments } from "./documentContext";
import { buildInstructions } from "./instructions";
import { nextAttentionState } from "./jackStateMachine";
import { toOrbPresentation, type OrbPresentation } from "./orbStateMap";
import { unsupportedController, type PresentationController } from "./presentationController";
import { createPresentationTools } from "./tools";
import { createWakeWordService } from "./wakeWordService";
import { useSession } from "../session/SessionContext";
import type {
  AudienceQuestionPolicy,
  ConnectionStatus,
  ControlMode,
  JackAttentionState,
  JackEvent,
  MicPipelineStatus,
  QueuedQuestion,
  TranscriptEntry,
} from "./types";

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
  };

  return <JackContext.Provider value={value}>{children}</JackContext.Provider>;
}

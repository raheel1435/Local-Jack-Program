"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type MicState =
  | "off"
  | "requesting"
  | "listening"
  | "muted"
  | "denied"
  | "unavailable"
  | "error";

export interface UseMicrophoneOptions {
  onResult?: (text: string, isFinal: boolean) => void;
}

export interface UseMicrophoneResult {
  state: MicState;
  level: number;
  start(): Promise<void>;
  stop(): void;
  toggleMute(): void;
  transcript: string;
  interimTranscript: string;
  recognitionSupported: boolean;
  error: string | null;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionWindow {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  webkitAudioContext?: typeof AudioContext;
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as SpeechRecognitionWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useMicrophone(options: UseMicrophoneOptions = {}): UseMicrophoneResult {
  const { onResult } = options;
  const [state, setState] = useState<MicState>("off");
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const recognitionSupported = getRecognitionCtor() !== null;
  const mediaDevicesAvailable =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  const stopLevelLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    stopLevelLoop();
    setLevel(0);
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.stop();
      } catch {
        // already stopped
      }
      recognitionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  }, [stopLevelLoop]);

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
      const rms = Math.sqrt(sumSquares / data.length);
      setLevel(Math.min(1, rms * 4));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(async () => {
    if (!mediaDevicesAvailable) {
      setState("unavailable");
      setError("This browser doesn't support microphone access.");
      return;
    }
    setState("requesting");
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const AudioContextCtor =
        window.AudioContext ?? (window as unknown as SpeechRecognitionWindow).webkitAudioContext;
      if (!AudioContextCtor) throw new Error("This browser doesn't support the Web Audio API.");
      const audioContext: AudioContext = new AudioContextCtor();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;
      runLevelLoop();

      const RecognitionCtor = getRecognitionCtor();
      if (RecognitionCtor) {
        const recognition = new RecognitionCtor();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "en-US";
        recognition.onresult = (event) => {
          let finalText = "";
          let interimText = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            const text = result[0]?.transcript ?? "";
            if (result.isFinal) finalText += text;
            else interimText += text;
          }
          if (finalText) {
            setTranscript((prev) => `${prev}${prev ? " " : ""}${finalText}`.trim());
            onResultRef.current?.(finalText, true);
          }
          setInterimTranscript(interimText);
          if (interimText) onResultRef.current?.(interimText, false);
        };
        recognition.onerror = (event) => {
          if (event.error === "no-speech" || event.error === "aborted") return;
          setError(`Speech recognition error: ${event.error}`);
        };
        recognition.onend = () => {
          // Recognition can end on its own (e.g. silence timeout); restart while still listening.
          if (recognitionRef.current === recognition && streamRef.current) {
            try {
              recognition.start();
            } catch {
              // ignore restart races
            }
          }
        };
        recognitionRef.current = recognition;
        try {
          recognition.start();
        } catch {
          // some browsers throw if called twice in a row; safe to ignore
        }
      }

      setState("listening");
    } catch (err) {
      teardown();
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setState("denied");
        setError("Microphone permission was denied. Allow access in your browser's site settings to use voice features.");
      } else if (err instanceof DOMException && err.name === "NotFoundError") {
        setState("unavailable");
        setError("No microphone was found on this device.");
      } else {
        setState("error");
        setError(err instanceof Error ? err.message : "Couldn't access the microphone.");
      }
    }
  }, [mediaDevicesAvailable, runLevelLoop, teardown]);

  const stop = useCallback(() => {
    teardown();
    setState("off");
    setInterimTranscript("");
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    setState((current) => {
      const nextMuted = current !== "muted";
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !nextMuted;
      });
      return nextMuted ? "muted" : "listening";
    });
  }, []);

  useEffect(() => teardown, [teardown]);

  return {
    state,
    level,
    start,
    stop,
    toggleMute,
    transcript,
    interimTranscript,
    recognitionSupported,
    error,
  };
}

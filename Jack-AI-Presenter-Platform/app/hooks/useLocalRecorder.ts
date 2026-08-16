"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Push-to-talk capture producing a WAV blob for Jack-Local-AI-Service's
 * whisper.cpp transcription. Deliberately NOT MediaRecorder: Chrome's
 * default output is Opus-in-WebM, which whisper.cpp's built-in decoder
 * (miniaudio + stb_vorbis; no ffmpeg on this machine) cannot read. Capturing
 * raw PCM via Web Audio and hand-encoding a WAV header sidesteps that
 * entirely and needs no new dependency.
 */
export type LocalRecorderState = "idle" | "requesting" | "listening" | "error";

export interface UseLocalRecorderResult {
  state: LocalRecorderState;
  level: number;
  error: string | null;
  start(): Promise<void>;
  /** Stops capture and resolves with a WAV blob, or null if nothing was captured. */
  stop(): Promise<Blob | null>;
}

interface WebkitAudioContextWindow {
  webkitAudioContext?: typeof AudioContext;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function useLocalRecorder(): UseLocalRecorderResult {
  const [state, setState] = useState<LocalRecorderState>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);

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
      setLevel(Math.min(1, Math.sqrt(sumSquares / data.length) * 4));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const teardown = useCallback(() => {
    stopLevelLoop();
    setLevel(0);
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    analyserRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  }, [stopLevelLoop]);

  const start = useCallback(async () => {
    setState("requesting");
    setError(null);
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const AudioContextCtor = window.AudioContext ?? (window as unknown as WebkitAudioContextWindow).webkitAudioContext;
      if (!AudioContextCtor) throw new Error("This browser doesn't support the Web Audio API.");
      const audioContext = new AudioContextCtor();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;
      runLevelLoop();

      // ScriptProcessorNode is deprecated but universally supported and
      // avoids shipping a separate AudioWorklet module for this milestone's
      // short push-to-talk captures.
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        chunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      // A ScriptProcessorNode only fires onaudioprocess while it has a path
      // to the destination. Silent, not a feedback loop: onaudioprocess
      // below never writes to event.outputBuffer, so it stays all-zero.
      processor.connect(audioContext.destination);
      processorRef.current = processor;

      setState("listening");
    } catch (err) {
      teardown();
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setError("Microphone permission was denied. Allow access in your browser's site settings to use voice commands.");
      } else if (err instanceof DOMException && err.name === "NotFoundError") {
        setError("No microphone was found on this device.");
      } else {
        setError(err instanceof Error ? err.message : "Couldn't access the microphone.");
      }
      setState("error");
    }
  }, [runLevelLoop, teardown]);

  const stop = useCallback(async (): Promise<Blob | null> => {
    const sampleRate = audioContextRef.current?.sampleRate ?? 48000;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    teardown();
    setState("idle");
    if (chunks.length === 0) return null;
    const samples = concatFloat32(chunks);
    if (samples.length === 0) return null;
    return encodeWav(samples, sampleRate);
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  return { state, level, error, start, stop };
}

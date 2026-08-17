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
export type LocalRecorderState = "idle" | "requesting" | "initializing" | "listening" | "error";

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

// Real hardware (echoCancellation/noiseSuppression/autoGainControl warm-up,
// getUserMedia device negotiation) can add real, variable latency before
// audio genuinely starts flowing -- observed as a user's first word being
// clipped when the UI said "Listening" before samples were actually being
// captured. If the very first buffer hasn't arrived within this long,
// something is unusually slow; proceed rather than hang the mic button
// forever, but this should be rare in practice.
const FIRST_BUFFER_TIMEOUT_MS = 2000;

function mark(label: string, extra?: Record<string, unknown>) {
  // Always-on, not gated behind a flag: this is a local-only dev/diagnostic
  // tool, and these timestamps are exactly what's needed to interpret a real
  // microphone test (see the milestone's Phase 3/10/11 real-hardware ask) --
  // filter the console on "[mic]" to follow one recording session.
  const t = Math.round(performance.now());
  if (extra) console.log(`[mic] t=${t}ms ${label}`, extra);
  else console.log(`[mic] t=${t}ms ${label}`);
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
    // Defensive: if something (barge-in's ambient arm, or a previous
    // push-to-talk session) left the recorder active, tear it down first
    // instead of silently leaking the old MediaStream/AudioContext and
    // fighting over the same refs. Whichever caller invokes start() next
    // cleanly takes ownership -- see the "recorder ownership" note in
    // JackProvider.tsx for the barge-in side of this.
    if (audioContextRef.current || streamRef.current) {
      mark("start() called while already active -- tearing down previous session first");
      teardown();
    }

    mark("mic click / start() invoked");
    setState("requesting");
    setError(null);
    chunksRef.current = [];
    try {
      // Best-effort suppression of Jack's own speaker output being picked
      // back up as "user speech" during barge-in monitoring. Not validated
      // as true acoustic echo cancellation on real hardware -- browsers
      // apply this on a best-effort basis and it can vary by device/OS.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      mark("getUserMedia resolved");
      streamRef.current = stream;
      setState("initializing");

      const AudioContextCtor = window.AudioContext ?? (window as unknown as WebkitAudioContextWindow).webkitAudioContext;
      if (!AudioContextCtor) throw new Error("This browser doesn't support the Web Audio API.");
      const audioContext = new AudioContextCtor();
      audioContextRef.current = audioContext;
      // Some browsers can hand back a freshly-created context in "suspended"
      // state even after a user gesture; resume() is a no-op if it's already
      // running, but skipping it risks silently losing audio until something
      // else happens to resume the context later.
      await audioContext.resume();
      mark("AudioContext running", { sampleRate: audioContext.sampleRate, state: audioContext.state });

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;
      runLevelLoop();

      // ScriptProcessorNode is deprecated but universally supported and
      // avoids shipping a separate AudioWorklet module for this milestone's
      // short push-to-talk captures. Buffer size reduced from the previous
      // 4096 (~85ms at 48kHz) to 1024 (~21ms) -- this is ScriptProcessorNode's
      // own inherent "time until the first callback can possibly fire" floor,
      // and smaller buffers mean less of a user's first word can be lost to
      // it while still being comfortably cheap to process.
      const processor = audioContext.createScriptProcessor(1024, 1, 1);
      let firstBufferSeen = false;
      let resolveFirstBuffer: (() => void) | null = null;
      const firstBufferPromise = new Promise<void>((resolve) => {
        resolveFirstBuffer = resolve;
      });
      processor.onaudioprocess = (event) => {
        chunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        if (!firstBufferSeen) {
          firstBufferSeen = true;
          mark("first audio buffer received -- genuinely capturing now");
          resolveFirstBuffer?.();
        }
      };
      source.connect(processor);
      // A ScriptProcessorNode only fires onaudioprocess while it has a path
      // to the destination. Silent, not a feedback loop: onaudioprocess
      // below never writes to event.outputBuffer, so it stays all-zero.
      processor.connect(audioContext.destination);
      processorRef.current = processor;

      // Don't tell the UI (and the auto-stop-on-silence timer that starts
      // once this resolves) that we're "Listening" until audio is actually
      // flowing -- otherwise a user who starts speaking the instant they see
      // "Listening" can lose their first word to setup latency that already
      // happened invisibly. Falls back to proceeding anyway after a timeout
      // so a genuinely stalled first callback can't hang the mic button.
      await Promise.race([
        firstBufferPromise,
        new Promise<void>((resolve) => setTimeout(resolve, FIRST_BUFFER_TIMEOUT_MS)),
      ]);
      if (!firstBufferSeen) {
        mark("WARNING: first buffer did not arrive within timeout -- proceeding anyway");
      }

      setState("listening");
      mark("Listening shown to user");
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
    mark("recording stopped");
    const sampleRate = audioContextRef.current?.sampleRate ?? 48000;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    teardown();
    setState("idle");
    if (chunks.length === 0) return null;
    const samples = concatFloat32(chunks);
    if (samples.length === 0) return null;
    mark("WAV encoded, ready to send", { durationMs: Math.round((samples.length / sampleRate) * 1000) });
    return encodeWav(samples, sampleRate);
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  return { state, level, error, start, stop };
}

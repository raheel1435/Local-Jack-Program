"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Push-to-talk capture producing a WAV blob for Jack-Local-AI-Service's
 * whisper.cpp transcription. Deliberately NOT MediaRecorder: Chrome's
 * default output is Opus-in-WebM, which whisper.cpp's built-in decoder
 * (miniaudio + stb_vorbis; no ffmpeg on this machine) cannot read. Capturing
 * raw PCM via Web Audio and hand-encoding a WAV header sidesteps that
 * entirely and needs no new dependency.
 *
 * Capture core: AudioWorkletNode (public/audio-worklet/pcm-recorder-processor.js),
 * not ScriptProcessorNode. ScriptProcessorNode passed the user's real
 * microphone test (fee60b7) in automated/fake-mic testing but failed on real
 * hardware -- the user got "you." for a full sentence. ScriptProcessorNode
 * runs on the main thread and only guarantees delivery once per full buffer
 * (1024 samples => ~21ms floor at 48kHz, worse under any main-thread
 * contention); AudioWorkletNode runs on the audio rendering thread and is
 * called every 128-sample quantum regardless of main-thread load.
 */
export type LocalRecorderState =
  | "idle"
  | "requesting"
  | "initializing"
  | "listening"
  | "processing"
  | "error";

/** Dev-only diagnostics for the most recently completed recording. Never
 * includes the actual audio samples -- see Phase 10/11 of the AudioWorklet
 * migration milestone. Exists to make a defective capture (e.g. a "you."
 * transcript from a real multi-word utterance) diagnosable from timestamps
 * and levels alone, without saving audio. */
export interface RecorderMetrics {
  sampleRate: number;
  workletLoadedAt: number | null;
  firstFrameAt: number | null;
  listeningAt: number | null;
  stoppedAt: number;
  /** ms from click (start() invoked) to the first real PCM frame arriving. */
  captureStartLatencyMs: number | null;
  frameMessageCount: number;
  pcmSampleCount: number;
  durationMs: number;
  /** Peak/RMS of the final captured PCM (worklet/WAV stage). */
  peakAmplitude: number;
  rmsAmplitude: number;
  /** Peak/session-average RMS from the separate AnalyserNode, over the same
   * session -- compared against peakAmplitude/rmsAmplitude above to isolate
   * whether a zero-signal capture is lost before or after the
   * AudioWorkletNode (Phase 16 of the activation milestone). */
  analyserPeak: number;
  analyserAvgRms: number;
  wavBytes: number;
}

export interface UseLocalRecorderResult {
  state: LocalRecorderState;
  level: number;
  error: string | null;
  /** Diagnostics for the most recently completed (stop()-resolved) recording. */
  metrics: RecorderMetrics | null;
  start(): Promise<void>;
  /** Stops capture and resolves with a WAV blob, or null if nothing was captured. */
  stop(): Promise<Blob | null>;
}

interface WebkitAudioContextWindow {
  webkitAudioContext?: typeof AudioContext;
}

const WORKLET_URL = "/audio-worklet/pcm-recorder-processor.js";
const WORKLET_NODE_NAME = "pcm-recorder-processor";

// Real hardware (echoCancellation/noiseSuppression/autoGainControl warm-up,
// getUserMedia device negotiation) can add real, variable latency before
// audio genuinely starts flowing -- observed as a user's first word being
// clipped when the UI said "Listening" before samples were actually being
// captured. If the very first frame hasn't arrived within this long,
// something is unusually slow; proceed rather than hang the mic button
// forever, but this should be rare in practice.
const FIRST_FRAME_TIMEOUT_MS = 2000;

// Silent-PCM safety (Phase 13): int16 quantization/analog noise floor is
// never exactly zero, but real speech peaks far above this -- a captured
// peak below it means the microphone signal was effectively lost somewhere
// in the pipeline (device, permission-granted-but-muted, wrong device),
// not that the user spoke quietly.
const SILENT_PEAK_THRESHOLD = 0.005;

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
  // Real device/AudioContext sample rate (typically 44.1kHz or 48kHz), never
  // a hardcoded 16kHz -- whisper.cpp's miniaudio-based decoder resamples to
  // its required 16kHz internally from whatever rate the WAV header
  // declares, so the header must state the truth (see LOCAL_JACK_RUNTIME.md
  // / whisper.cpp's common-whisper.cpp ma_decoder_config_init call).
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

function computePeakAndRms(samples: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
    sumSquares += samples[i] * samples[i];
  }
  return { peak, rms: samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0 };
}

/** Masks a device id for logs -- diagnostic, never shown in UI (Phase 20). */
function maskDeviceId(id: string | undefined): string {
  if (!id) return "(none)";
  return id.length <= 8 ? "***" : `${id.slice(0, 8)}…`;
}

export function useLocalRecorder(): UseLocalRecorderResult {
  const [state, setState] = useState<LocalRecorderState>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<RecorderMetrics | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const silentGainNodeRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const frameMessageCountRef = useRef(0);
  // Analyser-stage peak/RMS across the whole session, for direct comparison
  // against the worklet/PCM-stage peak/RMS at stop() -- Phase 16 of the
  // activation milestone: isolate whether a zero-signal capture is lost
  // before or after the AudioWorkletNode.
  const analyserPeakRef = useRef(0);
  const analyserRmsSumRef = useRef(0);
  const analyserRmsCountRef = useRef(0);

  const clickedAtRef = useRef(0);
  const workletLoadedAtRef = useRef<number | null>(null);
  const firstFrameAtRef = useRef<number | null>(null);
  const listeningAtRef = useRef<number | null>(null);

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
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const normalized = (data[i] - 128) / 128;
        sumSquares += normalized * normalized;
        const abs = Math.abs(normalized);
        if (abs > peak) peak = abs;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      if (peak > analyserPeakRef.current) analyserPeakRef.current = peak;
      analyserRmsSumRef.current += rms;
      analyserRmsCountRef.current += 1;
      setLevel(Math.min(1, rms * 4));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const teardown = useCallback(() => {
    stopLevelLoop();
    setLevel(0);
    if (workletNodeRef.current) {
      try {
        workletNodeRef.current.port.postMessage("stop");
      } catch {
        // context/port may already be gone
      }
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (silentGainNodeRef.current) {
      silentGainNodeRef.current.disconnect();
      silentGainNodeRef.current = null;
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

    clickedAtRef.current = performance.now();
    workletLoadedAtRef.current = null;
    firstFrameAtRef.current = null;
    listeningAtRef.current = null;
    frameMessageCountRef.current = 0;
    analyserPeakRef.current = 0;
    analyserRmsSumRef.current = 0;
    analyserRmsCountRef.current = 0;

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

      // Device audit (Phase 12/14/20): confirm which physical input, which
      // browser-applied processing, and what actual track STATE is in effect
      // -- deviceId is masked here too, it's a diagnostic console log, not UI.
      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings();
      mark("microphone track settings", {
        label: track?.label || "(no label -- permission not yet fully granted, or browser policy)",
        enabled: track?.enabled,
        muted: track?.muted,
        readyState: track?.readyState,
        deviceId: maskDeviceId(settings?.deviceId),
        sampleRate: settings?.sampleRate,
        channelCount: settings?.channelCount,
        echoCancellation: settings?.echoCancellation,
        noiseSuppression: settings?.noiseSuppression,
        autoGainControl: settings?.autoGainControl,
      });
      // How many audio-input devices Windows/the browser sees -- confirms
      // whether a wrong-device selection is even a plausible cause before
      // adding a selector UI for it (Phase 14/15: only add one with evidence).
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        mark("audio input devices available", { count: audioInputs.length });
      } catch {
        // enumerateDevices can fail/be restricted in some contexts -- non-fatal, just skip this diagnostic
      }

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

      // addModule is per-AudioContext-instance (worklet modules aren't
      // globally shared across contexts), so this re-registers on every
      // start() -- the browser's HTTP cache makes the actual fetch cheap
      // after the first load.
      await audioContext.audioWorklet.addModule(WORKLET_URL);
      workletLoadedAtRef.current = performance.now();
      mark("AudioWorklet module loaded");

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;
      runLevelLoop();

      // numberOfOutputs: 1, routed through a GainNode pinned to 0 and INTO
      // destination -- not numberOfOutputs: 0 left disconnected. Per spec, a
      // zero-output node should stay active purely from its input
      // connection, but that relies on the browser's graph-liveness
      // heuristics treating an output-less node as still worth pulling on
      // every render quantum -- exactly the kind of edge case that can
      // behave inconsistently in practice (Phase 17 of the activation
      // milestone). Explicitly connecting into an active destination-reaching
      // path guarantees the graph is pulled every quantum regardless of that
      // heuristic, while gain=0 keeps the microphone completely inaudible --
      // the worklet's own process() never writes to its output buffer
      // either, so it's silent twice over.
      const workletNode = new AudioWorkletNode(audioContext, WORKLET_NODE_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: "explicit",
      });
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      silentGainNodeRef.current = silentGain;

      let firstFrameSeen = false;
      let resolveFirstFrame: (() => void) | null = null;
      const firstFramePromise = new Promise<void>((resolve) => {
        resolveFirstFrame = resolve;
      });
      workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        chunksRef.current.push(event.data);
        frameMessageCountRef.current += 1;
        if (!firstFrameSeen) {
          firstFrameSeen = true;
          firstFrameAtRef.current = performance.now();
          mark("first PCM frame received -- genuinely capturing now", {
            captureStartLatencyMs: Math.round(firstFrameAtRef.current - clickedAtRef.current),
          });
          resolveFirstFrame?.();
        }
      };
      source.connect(workletNode);
      workletNode.connect(silentGain);
      silentGain.connect(audioContext.destination);
      workletNodeRef.current = workletNode;

      // Don't tell the UI (and the auto-stop-on-silence timer that starts
      // once this resolves) that we're "Listening" until audio is actually
      // flowing -- otherwise a user who starts speaking the instant they see
      // "Listening" can lose their first word to setup latency that already
      // happened invisibly. Falls back to proceeding anyway after a timeout
      // so a genuinely stalled first callback can't hang the mic button.
      await Promise.race([
        firstFramePromise,
        new Promise<void>((resolve) => setTimeout(resolve, FIRST_FRAME_TIMEOUT_MS)),
      ]);
      if (!firstFrameSeen) {
        mark("WARNING: first PCM frame did not arrive within timeout -- proceeding anyway");
      }

      listeningAtRef.current = performance.now();
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
    setState("processing");
    const sampleRate = audioContextRef.current?.sampleRate ?? 48000;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const frameMessageCount = frameMessageCountRef.current;
    const stoppedAt = performance.now();
    const analyserPeak = Number(analyserPeakRef.current.toFixed(4));
    const analyserAvgRms = Number(
      (analyserRmsCountRef.current > 0 ? analyserRmsSumRef.current / analyserRmsCountRef.current : 0).toFixed(4),
    );
    teardown();
    setState("idle");
    if (chunks.length === 0) {
      setMetrics({
        sampleRate,
        workletLoadedAt: workletLoadedAtRef.current,
        firstFrameAt: firstFrameAtRef.current,
        listeningAt: listeningAtRef.current,
        stoppedAt,
        captureStartLatencyMs:
          firstFrameAtRef.current !== null ? Math.round(firstFrameAtRef.current - clickedAtRef.current) : null,
        frameMessageCount,
        pcmSampleCount: 0,
        durationMs: 0,
        peakAmplitude: 0,
        rmsAmplitude: 0,
        analyserPeak,
        analyserAvgRms,
        wavBytes: 0,
      });
      mark("stop() resolved with no captured audio", { analyserPeak, analyserAvgRms });
      return null;
    }
    const samples = concatFloat32(chunks);
    if (samples.length === 0) return null;
    const { peak, rms } = computePeakAndRms(samples);
    const durationMs = Math.round((samples.length / sampleRate) * 1000);
    const wav = encodeWav(samples, sampleRate);

    const recorderMetrics: RecorderMetrics = {
      sampleRate,
      workletLoadedAt: workletLoadedAtRef.current,
      firstFrameAt: firstFrameAtRef.current,
      listeningAt: listeningAtRef.current,
      stoppedAt,
      captureStartLatencyMs:
        firstFrameAtRef.current !== null ? Math.round(firstFrameAtRef.current - clickedAtRef.current) : null,
      frameMessageCount,
      pcmSampleCount: samples.length,
      durationMs,
      peakAmplitude: Number(peak.toFixed(4)),
      analyserPeak,
      analyserAvgRms,
      rmsAmplitude: Number(rms.toFixed(4)),
      wavBytes: wav.size,
    };
    setMetrics(recorderMetrics);
    mark("WAV encoded, ready to send", recorderMetrics as unknown as Record<string, unknown>);
    // A clearly multi-word utterance producing a very short WAV (a few
    // hundred ms) is the concrete real-hardware failure signature this
    // migration exists to fix -- flag it loudly rather than silently
    // shipping a doomed transcription request.
    if (durationMs < 700) {
      mark("WARNING: captured audio is very short -- possible clipped/failed capture", { durationMs });
    }
    // Silent-PCM safety (Phase 13): a real quantization/analog noise floor
    // is never exactly zero, but effectively-silent capture (wrong/muted
    // device, permission granted but no signal reaching the track) sits far
    // below any real speech peak. Sending that to Whisper is exactly how a
    // "you." hallucination happens on genuinely empty input -- refuse
    // instead of guessing.
    if (peak < SILENT_PEAK_THRESHOLD) {
      mark("WARNING: captured audio is effectively silent -- refusing to send to Whisper", { peak, rms });
      setError("No microphone audio was detected. Check your microphone input.");
      return null;
    }
    return wav;
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  return { state, level, error, metrics, start, stop };
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptureBoundaryPolicy } from "../jack/capturePolicy";

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

/** Why a capture ended -- Part 7 of the WHISPER SAFETY CORRECTION milestone:
 * every completed capture should say why it stopped, not just how long it
 * was, so a false-trigger or runaway-capture pattern is diagnosable from the
 * console alone. */
export type CaptureCloseReason = "silence" | "hard_cap" | "cancel" | "route_change" | "session_end";

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
  /** How much of the final WAV is bounded pre-trigger ring-buffer audio vs. active post-trigger capture -- 0/0 for a capture that never called markCaptureTriggered() (e.g. push-to-talk). */
  preRollMs: number;
  activeCaptureMs: number;
  /** Always equal to durationMs -- kept as its own explicit field so the capture contract (preRollMs + activeCaptureMs <= policy.maxSubmittedWavMs) is checkable directly off metrics without recomputing it. */
  submittedWavMs: number;
  closeReason: CaptureCloseReason | null;
}

export interface UseLocalRecorderResult {
  state: LocalRecorderState;
  level: number;
  error: string | null;
  /** Diagnostics for the most recently completed (stop()-resolved) recording. */
  metrics: RecorderMetrics | null;
  /** Resolves true only after the first PCM frame proves capture is usable. */
  start(): Promise<boolean>;
  /** Call the instant a real VAD trigger fires (not at arm/listen time).
   * Freezes the bounded pre-roll ring buffer accumulated so far and switches
   * the recorder into capped active-capture accounting for everything after.
   * Never calling this (push-to-talk's explicit start/stop) leaves capture
   * unbounded, matching the pre-existing push-to-talk contract. */
  markCaptureTriggered(): void;
  /** Stops capture and resolves with a WAV blob, or null if nothing was captured. */
  stop(reason: CaptureCloseReason): Promise<Blob | null>;
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

function totalSampleCount(chunks: Float32Array[]): number {
  let total = 0;
  for (const c of chunks) total += c.length;
  return total;
}

/** Keeps only the newest `maxSamples` worth of audio, dropping/truncating
 * whole or partial chunks from the front (oldest). This is the capture-
 * bounding fix's core primitive: used both to continuously ring-buffer the
 * pre-trigger window (called on every frame while un-triggered) and to
 * freeze a bounded pre-roll snapshot the instant a real capture triggers. */
function trimToMaxSamples(chunks: Float32Array[], maxSamples: number): Float32Array[] {
  let total = totalSampleCount(chunks);
  if (total <= maxSamples) return chunks;
  const out = chunks.slice();
  while (out.length > 0 && total - out[0].length >= maxSamples) {
    total -= out[0].length;
    out.shift();
  }
  if (out.length > 0 && total > maxSamples) {
    const excess = total - maxSamples;
    out[0] = out[0].subarray(excess);
  }
  return out;
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

export function useLocalRecorder(capturePolicy: CaptureBoundaryPolicy): UseLocalRecorderResult {
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
  // Capture-bounding state (Part 6): while un-triggered, chunksRef is a
  // continuously-trimmed ring buffer holding only the last
  // capturePolicy.preRollMs of audio. markCaptureTriggered() freezes that
  // snapshot and flips this to true; from then on new frames are appended
  // and capped at preRollMs+activeCaptureMaxMs total, never trimmed from
  // the front again. capturePolicyRef exists so the onmessage closure
  // (created once per start()) always reads the CURRENT policy even if the
  // caller's asrProvider selection changes between renders.
  const triggeredRef = useRef(false);
  const preRollSamplesAtTriggerRef = useRef(0);
  const capturePolicyRef = useRef(capturePolicy);
  // Written in an effect, not during render (react-hooks/refs lint fix):
  // nothing in this render pass reads capturePolicyRef -- only the
  // onmessage closure does, asynchronously, later -- so committing the
  // update after render (rather than during it) changes nothing observable.
  useEffect(() => {
    capturePolicyRef.current = capturePolicy;
  }, [capturePolicy]);
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

  // Bug fix: every disconnect()/stop() call here used to run unguarded --
  // an AudioNode already torn down by a stale/overlapping teardown, or a
  // MediaStreamTrack already stopped elsewhere, can throw synchronously
  // (browsers vary on this). Since this function's caller, stop() below, is
  // never itself wrapped in try/catch, and ITS caller (JackProvider's
  // finishBargeInCapture) awaits stop() outside a try/catch too, a single
  // throw here used to reject the whole chain as an unhandled promise
  // rejection and leave bargeInPhase stuck at "processing" forever -- the
  // mic UI reporting "Processing" indefinitely with no way to recover short
  // of a page reload. Cleanup must never fail the caller: each step is now
  // independently best-effort, same treatment the postMessage/AudioContext
  // steps already had.
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
      try {
        workletNodeRef.current.disconnect();
      } catch {
        // already disconnected/context closed -- nothing left to tear down
      }
      workletNodeRef.current = null;
    }
    if (silentGainNodeRef.current) {
      try {
        silentGainNodeRef.current.disconnect();
      } catch {
        // already disconnected/context closed
      }
      silentGainNodeRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        // already disconnected/context closed
      }
      sourceRef.current = null;
    }
    analyserRef.current = null;
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {
        // track(s) already stopped/ended
      }
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        void audioContextRef.current.close().catch(() => {});
      } catch {
        // already closed/closing
      }
      audioContextRef.current = null;
    }
  }, [stopLevelLoop]);

  const start = useCallback(async (): Promise<boolean> => {
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
    triggeredRef.current = false;
    preRollSamplesAtTriggerRef.current = 0;
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
        const frame = event.data;
        frameMessageCountRef.current += 1;
        if (!firstFrameSeen) {
          firstFrameSeen = true;
          firstFrameAtRef.current = performance.now();
          mark("first PCM frame received -- genuinely capturing now", {
            captureStartLatencyMs: Math.round(firstFrameAtRef.current - clickedAtRef.current),
          });
          resolveFirstFrame?.();
        }
        const sampleRate = audioContextRef.current?.sampleRate ?? 48000;
        if (!triggeredRef.current) {
          // Pre-trigger: continuous bounded ring buffer. This is the actual
          // capture-bounding fix -- previously every frame accumulated here
          // unconditionally from start() (arm time) all the way to stop(),
          // so an utterance that armed long before a real VAD trigger fired
          // could submit an arbitrarily long WAV despite the documented
          // 8-second cap only ever bounding the POST-trigger timer.
          chunksRef.current.push(frame);
          const maxPreRollSamples = Math.round((capturePolicyRef.current.preRollMs / 1000) * sampleRate);
          chunksRef.current = trimToMaxSamples(chunksRef.current, maxPreRollSamples);
        } else {
          // Post-trigger: append and cap the TOTAL (pre-roll + active) at
          // preRollMs+activeCaptureMaxMs worth of samples -- enforced here,
          // inside the recorder itself, not only by the caller's wall-clock
          // setInterval timer (which calls stop() around the same time in
          // the normal case, but this is the structural guarantee Part 6
          // asks for: the SUBMITTED WAV itself is bounded, not just "usually
          // bounded because a timer fires on schedule").
          const maxTotalSamples = Math.round(
            ((capturePolicyRef.current.preRollMs + capturePolicyRef.current.activeCaptureMaxMs) / 1000) * sampleRate,
          );
          const currentTotal = totalSampleCount(chunksRef.current);
          if (currentTotal < maxTotalSamples) {
            const room = maxTotalSamples - currentTotal;
            chunksRef.current.push(room >= frame.length ? frame : frame.subarray(0, room));
          }
          // else: already at the hard ceiling -- drop further frames rather
          // than grow past the documented maximum submitted WAV duration.
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
      // happened invisibly. A timeout is a startup failure: without a PCM
      // frame there is no truthful basis for claiming capture is active.
      await Promise.race([
        firstFramePromise,
        new Promise<void>((resolve) => setTimeout(resolve, FIRST_FRAME_TIMEOUT_MS)),
      ]);
      if (!firstFrameSeen) {
        throw new Error("Microphone started, but no audio frames were received.");
      }

      listeningAtRef.current = performance.now();
      setState("listening");
      mark("Listening shown to user");
      return true;
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
      return false;
    }
  }, [runLevelLoop, teardown]);

  const markCaptureTriggered = useCallback(() => {
    triggeredRef.current = true;
    const sampleRate = audioContextRef.current?.sampleRate ?? 48000;
    const maxPreRollSamples = Math.round((capturePolicyRef.current.preRollMs / 1000) * sampleRate);
    chunksRef.current = trimToMaxSamples(chunksRef.current, maxPreRollSamples);
    preRollSamplesAtTriggerRef.current = totalSampleCount(chunksRef.current);
    mark("capture triggered -- pre-roll frozen", {
      preRollMs: capturePolicyRef.current.preRollMs,
      preRollSamples: preRollSamplesAtTriggerRef.current,
    });
  }, []);

  const stop = useCallback(async (reason: CaptureCloseReason): Promise<Blob | null> => {
    mark("recording stopped", { reason });
    setState("processing");
    const sampleRate = audioContextRef.current?.sampleRate ?? 48000;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const wasTriggered = triggeredRef.current;
    const preRollSamplesAtTrigger = preRollSamplesAtTriggerRef.current;
    triggeredRef.current = false;
    preRollSamplesAtTriggerRef.current = 0;
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
        preRollMs: 0,
        activeCaptureMs: 0,
        submittedWavMs: 0,
        closeReason: reason,
      });
      mark("stop() resolved with no captured audio", { analyserPeak, analyserAvgRms, reason });
      return null;
    }
    const samples = concatFloat32(chunks);
    if (samples.length === 0) return null;
    const { peak, rms } = computePeakAndRms(samples);
    const durationMs = Math.round((samples.length / sampleRate) * 1000);
    const wav = encodeWav(samples, sampleRate);
    // wasTriggered false (push-to-talk/explicit capture that never called
    // markCaptureTriggered) => the whole thing is reported as "active", not
    // "pre-roll" -- there was no ring-buffer/freeze step for it at all.
    const preRollMs = wasTriggered
      ? Math.round((Math.min(preRollSamplesAtTrigger, samples.length) / sampleRate) * 1000)
      : 0;
    const activeCaptureMs = Math.max(0, durationMs - preRollMs);

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
      preRollMs,
      activeCaptureMs,
      submittedWavMs: durationMs,
      closeReason: reason,
    };
    setMetrics(recorderMetrics);
    mark("WAV encoded, ready to send", recorderMetrics as unknown as Record<string, unknown>);
    // A clearly multi-word utterance producing a very short WAV (a few
    // hundred ms) is the concrete real-hardware failure signature this
    // migration exists to fix -- flag it loudly rather than silently
    // shipping a doomed transcription request.
    if (durationMs < capturePolicyRef.current.shortCaptureWarningMs) {
      mark("WARNING: captured audio is very short -- possible clipped/failed capture", { durationMs });
    }
    if (durationMs > capturePolicyRef.current.maxSubmittedWavMs) {
      // Should be structurally unreachable given the per-frame caps above --
      // logged loudly rather than silently trusted, since this is exactly
      // the contract Part 6/7 of the WHISPER SAFETY CORRECTION milestone
      // exist to guarantee.
      mark("WARNING: submitted WAV exceeded the declared capture contract", {
        durationMs,
        maxSubmittedWavMs: capturePolicyRef.current.maxSubmittedWavMs,
      });
    }
    // Silent-PCM safety (Phase 13): a real quantization/analog noise floor
    // is never exactly zero, but effectively-silent capture (wrong/muted
    // device, permission granted but no signal reaching the track) sits far
    // below any real speech peak. Sending that to Whisper is exactly how a
    // "you." hallucination happens on genuinely empty input -- refuse
    // instead of guessing.
    if (peak < capturePolicyRef.current.silentPeakThreshold) {
      mark("WARNING: captured audio is effectively silent -- refusing to send to Whisper", { peak, rms });
      setError("No microphone audio was detected. Check your microphone input.");
      return null;
    }
    return wav;
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  return { state, level, error, metrics, start, markCaptureTriggered, stop };
}

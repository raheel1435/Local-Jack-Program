/**
 * Structural capture/VAD boundary policy, split per ASR provider so a future
 * VibeVoice (Test) tuning pass can never silently mutate Whisper's frozen
 * values -- the frontend analogue of the gateway's WhisperApprovedConfig /
 * VibeVoiceTestConfig split (see Jack-Local-AI-Service/src/config/). Every
 * numeric value below is read from JackProvider.tsx/useLocalRecorder.ts by
 * reference through whichever policy `asrProvider` currently selects; there
 * is no other place these numbers should be hardcoded.
 *
 * WHISPER SAFETY CORRECTION MILESTONE: the values themselves are UNCHANGED
 * from the frozen Whisper baseline (8a6e9fd) except for `preRollMs`,
 * `activeCaptureMaxMs` (renamed from the old bare BARGE_IN_MAX_CAPTURE_MS
 * constant, same 8000ms value), and `maxSubmittedWavMs`, which are NEW --
 * see useLocalRecorder.ts's capture-bounding fix. Codex's independent review
 * found that the previously-documented 8-second cap only bounded the
 * ACTIVE-capture timer; the recorder itself accumulated every PCM frame from
 * start() (arm time, which can precede a real VAD trigger by an unbounded
 * amount of idle listening) with no trimming, so the actual submitted WAV
 * could exceed 8 seconds. `preRollMs` + `activeCaptureMaxMs` is now a real,
 * enforced ceiling on the complete submitted WAV, not just on the
 * post-trigger portion.
 */
export interface CaptureBoundaryPolicy {
  readonly provider: "whisper" | "vibevoice" | "openai";
  /** Stage 2: "CLOUD_BYOK_FROZEN" is neither "our own approved local
   * baseline" nor "an experimental local tuning target" -- OpenAI Speech's
   * VAD/capture timing has no local tuning surface at all (it's just the
   * network destination for the same captured WAV), so it starts pinned to
   * the exact Whisper-approved numbers rather than inventing a third
   * meaning for an existing status value. */
  readonly status: "APPROVED_FROZEN" | "TEST_EXPERIMENTAL_TUNABLE" | "CLOUD_BYOK_FROZEN";

  // --- Barge-in VAD trigger (unchanged from the frozen baseline) ---
  /** 0..1 RMS-derived level a burst must cross before sustain-counting starts. */
  readonly bargeInLevel: number;
  /** Consecutive over-threshold level-loop ticks (~60fps) required to count as real speech onset, not a transient. */
  readonly sustainTicks: number;
  /** Sustained under-threshold duration that ends an active capture. */
  readonly silenceMs: number;
  /** Delay after arming before the sustain-watcher starts, so Jack's own TTS playback-start transient can't self-trigger. */
  readonly armGuardMs: number;
  /** Per-utterance noise-floor sampling window right after the arm guard. */
  readonly calibrationMs: number;
  /** Margin added above the calibrated floor to set this utterance's effective trigger threshold. */
  readonly floorMargin: number;

  // --- Recorder-level capture safety (unchanged from the frozen baseline) ---
  /** Below this peak amplitude, captured audio is treated as effectively silent and never sent to ASR. */
  readonly silentPeakThreshold: number;
  /** Below this duration, a captured WAV is flagged as a possible clipped/failed capture (logged, not blocked). */
  readonly shortCaptureWarningMs: number;

  // --- Capture bounding (NEW: closes the unbounded-pre-trigger-history gap) ---
  /** Bounded ring-buffer window kept from BEFORE a VAD trigger, so the submitted WAV keeps a little useful onset context without being able to grow unboundedly during idle "armed" listening. */
  readonly preRollMs: number;
  /** Hard ceiling on the ACTIVE (post-trigger) portion alone -- same value/intent as the old bare BARGE_IN_MAX_CAPTURE_MS constant. */
  readonly activeCaptureMaxMs: number;
  /** The real contract: preRollMs + activeCaptureMaxMs + a small encoding/frame-granularity tolerance. The COMPLETE submitted WAV must never exceed this, enforced inside useLocalRecorder itself (not just by the caller's wall-clock timer). */
  readonly maxSubmittedWavMs: number;
}

const CAPTURE_TOLERANCE_MS = 250;

export const WhisperApprovedCapturePolicy: CaptureBoundaryPolicy = {
  provider: "whisper",
  status: "APPROVED_FROZEN",
  bargeInLevel: 0.12,
  sustainTicks: 10,
  silenceMs: 1500,
  armGuardMs: 350,
  calibrationMs: 250,
  floorMargin: 0.09,
  silentPeakThreshold: 0.005,
  shortCaptureWarningMs: 700,
  preRollMs: 500,
  activeCaptureMaxMs: 8000,
  maxSubmittedWavMs: 500 + 8000 + CAPTURE_TOLERANCE_MS,
};

// Deliberately a SEPARATE object literal, not a spread/reference of
// WhisperApprovedCapturePolicy -- see providerIsolation-style tests in
// capturePolicy.test.ts, which assert edits to one object structurally
// cannot affect the other. Values currently match Whisper's (Vibe is not
// being tuned in this milestone -- see VIBEVOICE_BASELINE.md); only the
// isolation boundary is new.
export const VibeVoiceTestCapturePolicy: CaptureBoundaryPolicy = {
  provider: "vibevoice",
  status: "TEST_EXPERIMENTAL_TUNABLE",
  bargeInLevel: 0.12,
  sustainTicks: 10,
  silenceMs: 1500,
  armGuardMs: 350,
  calibrationMs: 250,
  floorMargin: 0.09,
  silentPeakThreshold: 0.005,
  shortCaptureWarningMs: 700,
  preRollMs: 500,
  activeCaptureMaxMs: 8000,
  maxSubmittedWavMs: 500 + 8000 + CAPTURE_TOLERANCE_MS,
};

// Stage 2 (OpenAI Speech ASR): deliberately a SEPARATE object literal too
// (same isolation rule as VibeVoiceTestCapturePolicy above), values
// currently identical to Whisper's -- mic authority/VAD capture is a
// browser-side concern entirely independent of which ASR engine ultimately
// receives the resulting WAV, and there is no product reason yet for
// OpenAI Speech to diverge from the approved baseline.
export const OpenAiSpeechCapturePolicy: CaptureBoundaryPolicy = {
  provider: "openai",
  status: "CLOUD_BYOK_FROZEN",
  bargeInLevel: 0.12,
  sustainTicks: 10,
  silenceMs: 1500,
  armGuardMs: 350,
  calibrationMs: 250,
  floorMargin: 0.09,
  silentPeakThreshold: 0.005,
  shortCaptureWarningMs: 700,
  preRollMs: 500,
  activeCaptureMaxMs: 8000,
  maxSubmittedWavMs: 500 + 8000 + CAPTURE_TOLERANCE_MS,
};

export function capturePolicyFor(provider: "whisper" | "vibevoice" | "openai"): CaptureBoundaryPolicy {
  if (provider === "vibevoice") return VibeVoiceTestCapturePolicy;
  if (provider === "openai") return OpenAiSpeechCapturePolicy;
  return WhisperApprovedCapturePolicy;
}

/**
 * Calibrate down for a quiet microphone, but never above the approved speech
 * threshold. A user can begin speaking during the short calibration window;
 * treating that voice as ambient noise must not make the same voice
 * impossible to detect afterward.
 */
export function effectiveSpeechThreshold(noiseFloor: number, policy: CaptureBoundaryPolicy): number {
  return Math.min(policy.bargeInLevel, noiseFloor + policy.floorMargin);
}

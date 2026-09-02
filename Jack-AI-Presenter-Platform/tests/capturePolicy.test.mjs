import assert from "node:assert/strict";
import test from "node:test";
import {
  WhisperApprovedCapturePolicy,
  VibeVoiceTestCapturePolicy,
  OpenAiSpeechCapturePolicy,
  capturePolicyFor,
  effectiveSpeechThreshold,
} from "../app/jack/capturePolicy.ts";

// WHISPER SAFETY CORRECTION milestone, Part 9/24: structural isolation
// between the frozen Whisper capture policy and the experimental Vibe one --
// a future Vibe-only tuning pass must not be able to mutate Whisper's
// numbers. Mirrors Jack-Local-AI-Service's providerIsolation.test.ts.
// Stage 2 (OpenAI Speech ASR, multi-provider AI milestone) extends this
// with a third, equally-isolated policy.

test("status tags are correct and distinct", () => {
  assert.equal(WhisperApprovedCapturePolicy.status, "APPROVED_FROZEN");
  assert.equal(VibeVoiceTestCapturePolicy.status, "TEST_EXPERIMENTAL_TUNABLE");
  assert.equal(OpenAiSpeechCapturePolicy.status, "CLOUD_BYOK_FROZEN");
});

test("the three policies are genuinely separate objects, not the same reference", () => {
  assert.notEqual(WhisperApprovedCapturePolicy, VibeVoiceTestCapturePolicy);
  assert.notEqual(WhisperApprovedCapturePolicy, OpenAiSpeechCapturePolicy);
  assert.notEqual(VibeVoiceTestCapturePolicy, OpenAiSpeechCapturePolicy);
});

test("capturePolicyFor selects the right policy per provider", () => {
  assert.equal(capturePolicyFor("whisper"), WhisperApprovedCapturePolicy);
  assert.equal(capturePolicyFor("vibevoice"), VibeVoiceTestCapturePolicy);
  assert.equal(capturePolicyFor("openai"), OpenAiSpeechCapturePolicy);
});

test("the capture contract is internally consistent: maxSubmittedWavMs >= preRollMs + activeCaptureMaxMs", () => {
  for (const policy of [WhisperApprovedCapturePolicy, VibeVoiceTestCapturePolicy, OpenAiSpeechCapturePolicy]) {
    assert.ok(policy.maxSubmittedWavMs >= policy.preRollMs + policy.activeCaptureMaxMs);
  }
});

test("OpenAI Speech's capture/VAD values match the approved Whisper baseline exactly -- mic authority is not reimplemented per ASR engine", () => {
  assert.equal(OpenAiSpeechCapturePolicy.bargeInLevel, WhisperApprovedCapturePolicy.bargeInLevel);
  assert.equal(OpenAiSpeechCapturePolicy.sustainTicks, WhisperApprovedCapturePolicy.sustainTicks);
  assert.equal(OpenAiSpeechCapturePolicy.silenceMs, WhisperApprovedCapturePolicy.silenceMs);
  assert.equal(OpenAiSpeechCapturePolicy.activeCaptureMaxMs, WhisperApprovedCapturePolicy.activeCaptureMaxMs);
  assert.equal(OpenAiSpeechCapturePolicy.maxSubmittedWavMs, WhisperApprovedCapturePolicy.maxSubmittedWavMs);
});

test("Whisper's frozen values match the pre-existing baseline exactly", () => {
  assert.equal(WhisperApprovedCapturePolicy.bargeInLevel, 0.12);
  assert.equal(WhisperApprovedCapturePolicy.sustainTicks, 10);
  assert.equal(WhisperApprovedCapturePolicy.silenceMs, 1500);
  assert.equal(WhisperApprovedCapturePolicy.armGuardMs, 350);
  assert.equal(WhisperApprovedCapturePolicy.calibrationMs, 250);
  assert.equal(WhisperApprovedCapturePolicy.floorMargin, 0.09);
  assert.equal(WhisperApprovedCapturePolicy.silentPeakThreshold, 0.005);
  assert.equal(WhisperApprovedCapturePolicy.shortCaptureWarningMs, 700);
  assert.equal(WhisperApprovedCapturePolicy.activeCaptureMaxMs, 8000);
});

test("calibration never raises the speech trigger above the approved threshold", () => {
  assert.equal(effectiveSpeechThreshold(0.3, WhisperApprovedCapturePolicy), 0.12);
});

test("calibration can lower the trigger for a quiet microphone", () => {
  assert.ok(Math.abs(effectiveSpeechThreshold(0.01, WhisperApprovedCapturePolicy) - 0.1) < Number.EPSILON);
});

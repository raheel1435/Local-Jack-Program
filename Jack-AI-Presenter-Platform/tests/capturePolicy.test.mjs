import assert from "node:assert/strict";
import test from "node:test";
import { WhisperApprovedCapturePolicy, VibeVoiceTestCapturePolicy, capturePolicyFor } from "../app/jack/capturePolicy.ts";

// WHISPER SAFETY CORRECTION milestone, Part 9/24: structural isolation
// between the frozen Whisper capture policy and the experimental Vibe one --
// a future Vibe-only tuning pass must not be able to mutate Whisper's
// numbers. Mirrors Jack-Local-AI-Service's providerIsolation.test.ts.

test("status tags are correct and distinct", () => {
  assert.equal(WhisperApprovedCapturePolicy.status, "APPROVED_FROZEN");
  assert.equal(VibeVoiceTestCapturePolicy.status, "TEST_EXPERIMENTAL_TUNABLE");
});

test("the two policies are genuinely separate objects, not the same reference", () => {
  assert.notEqual(WhisperApprovedCapturePolicy, VibeVoiceTestCapturePolicy);
});

test("capturePolicyFor selects the right policy per provider", () => {
  assert.equal(capturePolicyFor("whisper"), WhisperApprovedCapturePolicy);
  assert.equal(capturePolicyFor("vibevoice"), VibeVoiceTestCapturePolicy);
});

test("the capture contract is internally consistent: maxSubmittedWavMs >= preRollMs + activeCaptureMaxMs", () => {
  for (const policy of [WhisperApprovedCapturePolicy, VibeVoiceTestCapturePolicy]) {
    assert.ok(policy.maxSubmittedWavMs >= policy.preRollMs + policy.activeCaptureMaxMs);
  }
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

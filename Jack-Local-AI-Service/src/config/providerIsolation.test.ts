import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_VOCABULARY_PROMPT } from "../providers/whisper/WhisperProvider.ts";
import { WhisperApprovedConfig } from "./whisperApprovedConfig.ts";
import { VibeVoiceTestConfig } from "./vibeVoiceTestConfig.ts";

// Structural enforcement for the VibeVoice isolated-optimization milestone:
// VibeVoiceTestConfig is experimental/tunable and must never be able to
// mutate what WhisperApprovedConfig (the frozen baseline) reports. These
// assertions don't depend on env vars or file access, so they run the same
// everywhere -- if a future edit makes any Vibe-only value leak into the
// Whisper side, this file breaks immediately rather than silently.

test("WhisperApprovedConfig is marked frozen; VibeVoiceTestConfig is marked experimental", () => {
  assert.equal(WhisperApprovedConfig.status, "APPROVED_FROZEN");
  assert.equal(VibeVoiceTestConfig.status, "TEST_EXPERIMENTAL_TUNABLE");
});

test("Vibe thread count does not change the Whisper thread count", () => {
  assert.equal(WhisperApprovedConfig.threads, 4);
  assert.notEqual(WhisperApprovedConfig.threads, VibeVoiceTestConfig.threads);
});

test("Vibe context vocabulary does not change the Whisper prompt", () => {
  assert.equal(WhisperApprovedConfig.commandVocabularyPrompt, COMMAND_VOCABULARY_PROMPT);
  assert.notEqual(WhisperApprovedConfig.commandVocabularyPrompt, VibeVoiceTestConfig.contextVocabulary);
});

test("Vibe timeouts do not change the Whisper timeout", () => {
  assert.equal(WhisperApprovedConfig.timeoutMs, 60_000);
  assert.notEqual(WhisperApprovedConfig.timeoutMs, VibeVoiceTestConfig.requestTimeoutMs);
  assert.notEqual(WhisperApprovedConfig.timeoutMs, VibeVoiceTestConfig.serverStartTimeoutMs);
});

test("Vibe's warm-vs-cold runtime choice does not change the Whisper executable path key", () => {
  // WhisperApprovedConfig reads only WHISPER_EXECUTABLE_PATH; it has no
  // notion of "warm" or "stream server" at all -- asserting the field
  // doesn't exist on it is the isolation guarantee, not just a value check.
  assert.equal("streamServerExecutablePath" in WhisperApprovedConfig, false);
  assert.equal("warmRuntime" in WhisperApprovedConfig, false);
});

test("WhisperApprovedConfig's command-vocabulary prompt is imported from WhisperProvider, not duplicated", () => {
  // Guards against the isolation object itself silently becoming a second
  // source of truth (see this file's own module comment).
  assert.equal(WhisperApprovedConfig.commandVocabularyPrompt, COMMAND_VOCABULARY_PROMPT);
});

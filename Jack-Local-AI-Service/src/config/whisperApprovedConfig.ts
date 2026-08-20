import { COMMAND_VOCABULARY_PROMPT, WHISPER_THREADS } from "../providers/whisper/WhisperProvider.js";
import { config } from "./services.js";

/**
 * WhisperApprovedConfig -- explicit, read-only snapshot of the FROZEN
 * baseline established by the Whisper Approved Baseline Audit (see
 * WHISPER_APPROVED_BASELINE.md). Every value here is read from the same
 * place WhisperProvider.ts itself reads it from (COMMAND_VOCABULARY_PROMPT
 * is imported, not copied) -- this object exists purely to make the
 * provider-isolation boundary structurally explicit and machine-checkable
 * (see providerIsolation.test.ts), not to introduce a second source of
 * truth. Changing any value here without updating WHISPER_APPROVED_BASELINE.md
 * and re-running the full frozen regression suite is exactly the mistake
 * this object's own isolation test exists to catch.
 */
export const WhisperApprovedConfig = {
  status: "APPROVED_FROZEN" as const,
  executablePath: config.whisperExecutablePath,
  modelPath: config.whisperModelPath,
  // Imported from WhisperProvider.ts, not copied -- WHISPER SAFETY
  // CORRECTION milestone, Part 10: this used to be a bare literal 4 that
  // merely documented whisper.cpp's own CLI default (never actually passed
  // as -t). Now explicitly pinned in buildWhisperArgs, confirmed via
  // repeated timed runs to produce byte-identical transcripts and
  // statistically indistinguishable latency vs. the old implicit default.
  threads: WHISPER_THREADS,
  timeoutMs: 60_000,
  commandVocabularyPrompt: COMMAND_VOCABULARY_PROMPT,
} as const;

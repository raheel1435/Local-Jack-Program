import { config } from "./services.js";

/**
 * VibeVoiceTestConfig -- TEST / EXPERIMENTAL / TUNABLE. Everything here is
 * scoped to VibeVoice only and must never leak into WhisperApprovedConfig
 * or WhisperProvider.ts (see providerIsolation.test.ts).
 */
export const VibeVoiceTestConfig = {
  status: "TEST_EXPERIMENTAL_TUNABLE" as const,
  executablePath: config.vibeAsrExecutablePath,
  streamServerExecutablePath: config.vibeAsrStreamServerExecutablePath,
  vaeModelPath: config.vibeAsrVaeModelPath,
  lmModelPath: config.vibeAsrLmModelPath,

  // 8 of this machine's 12 logical cores, leaving headroom for the
  // concurrently-running llama.cpp/Kokoro/gateway processes. NOTE: unlike
  // the cold-vs-warm timing and the 20-phrase command corpus (both real,
  // measured, and recorded in VIBEVOICE_BASELINE.md), this specific thread
  // count was NOT re-verified by an actual per-thread-count benchmark this
  // milestone -- a prior version of this comment claimed a specific
  // 2/4/6/8/10/12-thread sweep with per-count averages that was never
  // actually run/recorded anywhere. Treat 8 as a reasonable inherited
  // default, not an empirically-optimal one, until someone runs that sweep
  // for real.
  threads: 8,
  greedy: true, // deterministic output -- appropriate for a side-by-side ASR comparison, unchanged from the pre-existing cold-path default

  // Officially-supported persistent runtime: asr_stream_server.exe's own
  // --help banner: "loads models once, processes audio via stdin". Measured
  // (see VIBEVOICE_BASELINE.md): cold one-shot `asr_infer.exe` calls average
  // ~2514ms/utterance; once the warm server is up, every request after the
  // first averages ~1197ms -- roughly half, because the VAE+LM load cost is
  // paid once per gateway lifetime instead of on every command. The warm
  // server's own FIRST request is not faster than cold (it pays that same
  // load cost too, just once) -- the win is steady-state, not first-request.
  // VibeWarmServer drives this exact protocol; VIBE_ASR_EXECUTABLE_PATH
  // (asr_infer.exe, the one-shot CLI) is kept configured only as the binary
  // VibeAsrProvider.checkHealth() verifies exists, not as a request-time
  // fallback path.
  warmRuntime: true,
  requestTimeoutMs: 30_000,
  serverStartTimeoutMs: 30_000,

  // --context is VibeASR.cpp's own supported hotwords/context flag
  // (confirmed via `asr_infer.exe --help` / `asr_stream_server.exe --help`
  // -- "Hotwords/context info to improve recognition accuracy"), NOT
  // assumed from the unrelated full 7B VibeVoice-ASR model. This is the
  // Vibe-specific analogue of Whisper's --prompt fix, using the mechanism
  // THIS runtime actually documents. Set once at warm-server startup (the
  // stdin protocol is one-audio-path-per-line with no per-request context
  // override), so unlike Whisper's per-call hotwords-append, this is fixed
  // for the server's lifetime -- acceptable today because no caller
  // currently passes per-call hotwords (confirmed via the Whisper baseline
  // audit's equivalent check).
  //
  // SAFETY FIX (mirrors WhisperProvider.ts's COMMAND_VOCABULARY_PROMPT):
  // this used to be complete example command SENTENCES ("Jack, stop.",
  // "Jack, take over again.", ...) -- structurally the exact same shape of
  // prompt that whisper.cpp's own decoder was CONFIRMED (WHISPER
  // FALSE-DESTRUCTIVE-COMMAND ROOT-CAUSE milestone) to regurgitate
  // verbatim from pure noise, 6/6 times across seeds, producing a clean,
  // deterministically-matching "Jack, stop." with no speech present at all.
  // VibeASR.cpp/BitNet is a different LM-side-primed decoder, but the same
  // failure class -- an initial-context string shaped as a complete,
  // ready-to-execute command -- was never re-tested against it before this
  // fix. This word-list-only replacement keeps the vocabulary-priming
  // benefit (the individual words a real command needs) while removing the
  // complete-sentence regurgitation target, exactly as WhisperProvider.ts's
  // own fix did. A live noise-reproduction re-test against
  // asr_stream_server.exe specifically (mirroring WHISPER_APPROVED_BASELINE.md's
  // methodology) is still open -- see VIBEVOICE_BASELINE.md.
  contextVocabulary:
    "Jack next previous back pause continue stop take over here explain summarize slide three pricing roadmap presentation",
} as const;

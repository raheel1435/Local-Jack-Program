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
  contextVocabulary:
    "Jack, next slide. Jack, previous slide. Jack, go back. Jack, pause. Jack, continue. Jack, stop. " +
    "Jack, take over. Jack, take over again. I'll take it from here. Jack, explain this slide. " +
    "Jack, summarize this slide. Jack, go to slide three. pricing, roadmap, presentation.",
} as const;

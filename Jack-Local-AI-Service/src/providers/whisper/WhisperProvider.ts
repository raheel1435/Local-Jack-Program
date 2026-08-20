import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { config } from "../../config/services.js";
import type { AsrProvider, JackTranscribeResponse, ProviderStatus } from "../../types/jack.js";

const execFileAsync = promisify(execFile);

/**
 * Whisper-baseline-audit finding, confirmed live and reproducible: without
 * any context, ggml-base.en mis-hears several of Jack's own short command
 * words -- "Jack, stop." -> "Jackstomp.", "Jack, pause." -> "Jack Paws"
 * (a genuine homophone, "pause"/"paws"), "Jack, next slide." -> "Jacknix
 * slide." (word-boundary merge). None of those match matchDeterministicCommand
 * (commandRouter.ts) as written, so each one broke the command it was
 * trying to give -- "Jackstomp" fails safe to unknown, "Jack Paws" gets
 * classified as idle conversation by the LLM fallback, and "Jacknix slide"
 * triggered the LLM to hallucinate an unrelated jump_to_slide target that
 * was never in the transcript at all.
 *
 * whisper.cpp's --prompt flag (an initial decoder prompt, NOT a spoken
 * prefix -- see whisper-cli --help) primes the language-model side of
 * decoding toward expected vocabulary. Passing a fixed command vocabulary
 * eliminated all three failures in every reproduction and produced ZERO
 * false insertions into unrelated speech.
 *
 * WHISPER FALSE-DESTRUCTIVE-COMMAND ROOT-CAUSE milestone: the ORIGINAL
 * version of this prompt (kept below in this comment for the record) was
 * complete example sentences -- "Jack, stop.", "Jack, take over again.",
 * "I'll take it from here." verbatim. Root-caused live: real-hardware
 * microphone testing reproduced repeated false stop_presentation/
 * start_presentation/handoff_to_presenter actions from ambient audio with
 * NO one speaking, and a controlled experiment proved the mechanism --
 * identical synthetic broadband noise (no speech at all), fed to
 * whisper-cli 3x across 2 amplitude/seed variants: WITH that full-sentence
 * prompt, produced "Jack, stop." byte-identical every single time (6/6
 * runs) -- a clean, well-formed, deterministically-matching destructive
 * command from pure noise. WITHOUT any prompt, the same noise produced
 * "(machine whirring)" -- already safe (caught by isNonSpeechArtifact
 * below). whisper.cpp's initial-prompt mechanism primes the decoder's
 * language-model side hard enough that on low-confidence/ambiguous audio,
 * it can regurgitate the prompt's own complete example sentences verbatim
 * rather than transcribing the actual (near-silent/noisy) input.
 *
 * This word-list-only replacement keeps the vocabulary-priming benefit
 * (verified: still correctly transcribes "Jack, stop." / "Jack, pause." /
 * "Jack, explain this slide." / "Jack, take over again." / "I'll take it
 * from here." / "Jack, go to slide three." from real Kokoro-synthesized
 * audio, and every one still resolves to the same action via
 * matchDeterministicCommand's existing comma/period-tolerant patterns) but
 * removes the complete-sentence regurgitation target: the SAME noise test
 * (both seeds, 3 runs each) now produces only the single bare word "slide"
 * -- already safe via the existing bare-word-fragment check
 * (isBareWordFragment) AND the address gate (no "jack" in it at all).
 *
 * A per-token confidence gate (whisper.cpp's --print-confidence/-ojf) was
 * evaluated and explicitly NOT implemented: under this new prompt, the
 * noise-hallucinated "slide" measured 0.91-0.97 average token confidence --
 * HIGHER than several genuine real-command recordings under the same new
 * prompt (0.48-0.91 average across 5 samples). Confidence does not reliably
 * separate real speech from hallucination once the prompt no longer
 * strongly primes one specific phrase, so a threshold gate here would be
 * unreliable at best and could false-reject genuine quiet/urgent commands
 * at worst. See WHISPER_APPROVED_BASELINE.md's root-cause section for the
 * full data. Self-echo (Jack's own TTS leaking through the browser's
 * imperfect echo cancellation) is a SEPARATE mechanism this prompt change
 * does not address -- see addressing.ts / JackProvider.tsx's self-echo
 * guard for that.
 *
 * Original full-sentence prompt, for the record:
 * "Jack, next slide. Jack, previous slide. Jack, go back. Jack, pause.
 * Jack, continue. Jack, stop. Jack, take over. Jack, take over again. I'll
 * take it from here. Jack, explain this slide. Jack, summarize this slide.
 * Jack, go to slide three."
 */
export const COMMAND_VOCABULARY_PROMPT =
  "Jack next previous pause continue stop take over explain summarize slide pricing roadmap presentation";

// WHISPER SAFETY CORRECTION milestone, Part 10: whisper.cpp's own CLI
// default happened to already be 4 (confirmed via repeated timed runs, byte-
// identical transcript and statistically indistinguishable latency with vs.
// without this flag -- see VIBEVOICE_BASELINE-adjacent measurement notes in
// this milestone's report). Explicitly pinning it turns "documents the
// effective value" (whisperApprovedConfig.ts's old caveat) into something
// actually true and reproducible if a future whisper.cpp upgrade ever
// changes its own default.
export const WHISPER_THREADS = 4;

/** Pure arg-builder, pulled out of transcribe() so the --prompt fix (and the
 * hotwords-append behavior) is directly unit-testable without shelling out
 * to a real whisper-cli binary. */
export function buildWhisperArgs(
  modelPath: string,
  audioFilePath: string,
  language?: string,
  opts?: { hotwords?: string[] }
): string[] {
  const prompt = opts?.hotwords?.length
    ? `${COMMAND_VOCABULARY_PROMPT} ${opts.hotwords.join(", ")}.`
    : COMMAND_VOCABULARY_PROMPT;

  const args = ["-m", modelPath, "-f", audioFilePath, "-nt", "-np", "-t", String(WHISPER_THREADS), "--prompt", prompt];
  if (language) {
    args.push("-l", language);
  }
  return args;
}

/**
 * whisper.cpp in this repo's built configuration exposes no HTTP server —
 * only a CLI executable. This provider shells out to it directly. Swap the
 * implementation for an HTTP client if/when a whisper-server build is used.
 *
 * This is the APPROVED (default) ASR engine -- see VibeAsrProvider for the
 * TEST engine. Both implement the same AsrProvider interface so routes and
 * the UI never need engine-specific branching.
 */
export class WhisperProvider implements AsrProvider {
  readonly id = "whisper" as const;
  readonly name = "Approved · Whisper";

  private readonly executablePath: string;
  private readonly modelPath: string;

  constructor(
    executablePath: string = config.whisperExecutablePath,
    modelPath: string = config.whisperModelPath
  ) {
    this.executablePath = executablePath;
    this.modelPath = modelPath;
  }

  async checkHealth(): Promise<ProviderStatus> {
    if (!this.executablePath || !this.modelPath) {
      return "unavailable";
    }
    try {
      await access(this.executablePath, fsConstants.X_OK | fsConstants.F_OK);
      await access(this.modelPath, fsConstants.F_OK);
      return "available";
    } catch {
      return "unavailable";
    }
  }

  async transcribe(
    audioFilePath: string,
    language?: string,
    opts?: { hotwords?: string[] }
  ): Promise<JackTranscribeResponse> {
    if (!this.executablePath || !this.modelPath) {
      throw new Error(
        "whisper.cpp is not configured: set WHISPER_EXECUTABLE_PATH and WHISPER_MODEL_PATH"
      );
    }

    // --prompt primes the decoder toward this app's own command vocabulary
    // -- see COMMAND_VOCABULARY_PROMPT's comment for the confirmed bugs this
    // fixes. Any caller-supplied hotwords (deck-specific terms, currently
    // unused -- no caller passes them yet) are appended, not substituted,
    // so the baseline command-vocabulary fix always applies regardless.
    const args = buildWhisperArgs(this.modelPath, audioFilePath, language, opts);

    const start = Date.now();
    const { stdout } = await execFileAsync(this.executablePath, args, {
      timeout: 60_000,
    });

    return {
      text: stdout.trim(),
      provider: this.id,
      latencyMs: Date.now() - start,
      language,
    };
  }
}

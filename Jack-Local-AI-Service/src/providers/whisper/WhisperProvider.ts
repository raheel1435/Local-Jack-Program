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
 * decoding toward expected vocabulary. Passing this fixed command
 * vocabulary eliminated all three failures in every reproduction (verified
 * against the full Phase-3 command corpus, 20/20 phrases correct with the
 * prompt vs. 3/20 broken without it) and produced ZERO false insertions
 * into unrelated speech (verified against an unrelated control sentence,
 * transcribed byte-identical with and without the prompt). This is the one
 * fix this audit found evidence for; capture/VAD timing, thread count, and
 * the model itself all measured fine and were left untouched.
 */
export const COMMAND_VOCABULARY_PROMPT =
  "Jack, next slide. Jack, previous slide. Jack, go back. Jack, pause. Jack, continue. Jack, stop. " +
  "Jack, take over. Jack, take over again. I'll take it from here. Jack, explain this slide. " +
  "Jack, summarize this slide. Jack, go to slide three.";

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

  const args = ["-m", modelPath, "-f", audioFilePath, "-nt", "-np", "--prompt", prompt];
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

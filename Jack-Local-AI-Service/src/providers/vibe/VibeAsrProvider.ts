import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { config } from "../../config/services.js";
import type { AsrProvider, JackTranscribeResponse, ProviderStatus } from "../../types/jack.js";

const execFileAsync = promisify(execFile);

/**
 * TEST ASR engine: VibeVoice-ASR-BitNet, run via VibeASR.cpp's asr_infer CLI
 * (no HTTP server -- same shell-out pattern as WhisperProvider). Opt-in
 * only: never invoked unless a request explicitly selects provider
 * "vibevoice" (see routes/transcription.ts). If this fails or is
 * unconfigured, the caller gets a structured error -- there is no automatic
 * fallback to Whisper anywhere in this class or its callers.
 */
export class VibeAsrProvider implements AsrProvider {
  readonly id = "vibevoice" as const;
  readonly name = "Test · VibeVoice";

  private readonly executablePath: string;
  private readonly vaeModelPath: string;
  private readonly lmModelPath: string;

  constructor(
    executablePath: string = config.vibeAsrExecutablePath,
    vaeModelPath: string = config.vibeAsrVaeModelPath,
    lmModelPath: string = config.vibeAsrLmModelPath
  ) {
    this.executablePath = executablePath;
    this.vaeModelPath = vaeModelPath;
    this.lmModelPath = lmModelPath;
  }

  async checkHealth(): Promise<ProviderStatus> {
    if (!this.executablePath || !this.vaeModelPath || !this.lmModelPath) {
      return "unavailable";
    }
    try {
      await access(this.executablePath, fsConstants.X_OK | fsConstants.F_OK);
      await access(this.vaeModelPath, fsConstants.F_OK);
      await access(this.lmModelPath, fsConstants.F_OK);
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
    if (!this.executablePath || !this.vaeModelPath || !this.lmModelPath) {
      throw new Error(
        "VibeVoice-ASR-BitNet is not configured: set VIBE_ASR_EXECUTABLE_PATH, VIBE_ASR_VAE_MODEL_PATH and VIBE_ASR_LM_MODEL_PATH"
      );
    }

    const args = [
      "--vae-model",
      this.vaeModelPath,
      "--lm-model",
      this.lmModelPath,
      "--audio",
      audioFilePath,
      "-t",
      "4",
      "--greedy", // deterministic output -- appropriate for a side-by-side ASR comparison
    ];
    if (opts?.hotwords && opts.hotwords.length > 0) {
      args.push("--context", opts.hotwords.join(", "));
    }

    const start = Date.now();
    const { stdout } = await execFileAsync(this.executablePath, args, {
      timeout: 120_000,
    });

    return {
      text: stdout.trim(),
      provider: this.id,
      latencyMs: Date.now() - start,
      // VibeVoice-ASR-BitNet is multilingual/code-switching by design and
      // does not take a target-language hint the way whisper.cpp's `-l`
      // does -- `language` here reflects only what the caller asked for,
      // not a detected language (asr_infer's plain-text mode reports none).
      language,
    };
  }
}

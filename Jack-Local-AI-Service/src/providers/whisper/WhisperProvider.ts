import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { config } from "../../config/services.js";
import type { ProviderStatus } from "../../types/jack.js";

const execFileAsync = promisify(execFile);

/**
 * whisper.cpp in this repo's built configuration exposes no HTTP server —
 * only a CLI executable. This provider shells out to it directly. Swap the
 * implementation for an HTTP client if/when a whisper-server build is used.
 */
export class WhisperProvider {
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
    language?: string
  ): Promise<{ text: string; latencyMs: number }> {
    if (!this.executablePath || !this.modelPath) {
      throw new Error(
        "whisper.cpp is not configured: set WHISPER_EXECUTABLE_PATH and WHISPER_MODEL_PATH"
      );
    }

    const args = [
      "-m",
      this.modelPath,
      "-f",
      audioFilePath,
      "-nt", // no timestamps, plain text output
      "-np", // no progress output
    ];
    if (language) {
      args.push("-l", language);
    }

    const start = Date.now();
    const { stdout } = await execFileAsync(this.executablePath, args, {
      timeout: 60_000,
    });

    return {
      text: stdout.trim(),
      latencyMs: Date.now() - start,
    };
  }
}

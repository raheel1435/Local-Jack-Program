import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { config } from "../../config/services.js";
import { VibeVoiceTestConfig } from "../../config/vibeVoiceTestConfig.js";
import { VibeWarmServer } from "./VibeWarmServer.js";
import type { AsrProvider, JackTranscribeResponse, ProviderStatus } from "../../types/jack.js";

const execFileAsync = promisify(execFile);

/**
 * TEST ASR engine: VibeVoice-ASR-BitNet, run via VibeASR.cpp. Opt-in only:
 * never invoked unless a request explicitly selects provider "vibevoice"
 * (see routes/transcription.ts). If this fails or is unconfigured, the
 * caller gets a structured error -- there is no automatic fallback to
 * Whisper anywhere in this class or its callers (VibeVoice isolated-
 * optimization milestone, Part 19: no silent fallback).
 *
 * VibeVoiceTestConfig.warmRuntime (default true) routes transcription
 * through VibeWarmServer, a persistent child process using VibeASR.cpp's
 * own officially-supported asr_stream_server.exe -- measured ~2x faster
 * than the one-shot `asr_infer.exe` CLI on every request after the first,
 * since the VAE+LM reload cost is then paid once per gateway lifetime
 * instead of once per call (see VIBEVOICE_BASELINE.md). The one-shot CLI path
 * (`execFileAsync` below) is kept only as the health-check target and as a
 * documented reference implementation if warmRuntime is ever disabled.
 */
export class VibeAsrProvider implements AsrProvider {
  readonly id = "vibevoice" as const;
  readonly name = "Test · VibeVoice";

  private readonly executablePath: string;
  private readonly vaeModelPath: string;
  private readonly lmModelPath: string;
  private readonly warmServer: VibeWarmServer | null;

  constructor(
    executablePath: string = config.vibeAsrExecutablePath,
    vaeModelPath: string = config.vibeAsrVaeModelPath,
    lmModelPath: string = config.vibeAsrLmModelPath
  ) {
    this.executablePath = executablePath;
    this.vaeModelPath = vaeModelPath;
    this.lmModelPath = lmModelPath;
    this.warmServer = VibeVoiceTestConfig.warmRuntime
      ? new VibeWarmServer(
          config.vibeAsrStreamServerExecutablePath,
          vaeModelPath,
          lmModelPath,
          VibeVoiceTestConfig.threads,
          VibeVoiceTestConfig.contextVocabulary,
          VibeVoiceTestConfig.serverStartTimeoutMs,
          VibeVoiceTestConfig.requestTimeoutMs
        )
      : null;
  }

  async checkHealth(): Promise<ProviderStatus> {
    if (!this.executablePath || !this.vaeModelPath || !this.lmModelPath) {
      return "unavailable";
    }
    // When warmRuntime is on, asr_stream_server.exe -- not asr_infer.exe --
    // is what actually serves every transcription request (see
    // constructor/transcribe() above). Checking only the cold-path
    // executable here would report "available" while the path that real
    // requests take is missing.
    if (VibeVoiceTestConfig.warmRuntime && !config.vibeAsrStreamServerExecutablePath) {
      return "unavailable";
    }
    try {
      await access(this.executablePath, fsConstants.X_OK | fsConstants.F_OK);
      if (VibeVoiceTestConfig.warmRuntime) {
        await access(config.vibeAsrStreamServerExecutablePath, fsConstants.X_OK | fsConstants.F_OK);
      }
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

    const start = Date.now();
    const text = this.warmServer
      ? await this.warmServer.transcribe(audioFilePath)
      : await this.transcribeCold(audioFilePath, opts);

    return {
      text: text.trim(),
      provider: this.id,
      latencyMs: Date.now() - start,
      // VibeVoice-ASR-BitNet is multilingual/code-switching by design and
      // does not take a target-language hint the way whisper.cpp's `-l`
      // does -- `language` here reflects only what the caller asked for,
      // not a detected language (asr_infer's plain-text mode reports none).
      language,
    };
  }

  /** Reference one-shot path (VibeVoiceTestConfig.warmRuntime === false only).
   * The warm server's --context is fixed at process start (no per-request
   * override in its stdin protocol -- see VibeWarmServer's class comment),
   * so per-call opts.hotwords can only be honored here, on the cold path. */
  private async transcribeCold(audioFilePath: string, opts?: { hotwords?: string[] }): Promise<string> {
    const args = [
      "--vae-model",
      this.vaeModelPath,
      "--lm-model",
      this.lmModelPath,
      "--audio",
      audioFilePath,
      "-t",
      String(VibeVoiceTestConfig.threads),
      "--greedy",
    ];
    const context = opts?.hotwords?.length ? opts.hotwords.join(", ") : VibeVoiceTestConfig.contextVocabulary;
    if (context) args.push("--context", context);

    const { stdout } = await execFileAsync(this.executablePath, args, {
      timeout: 120_000,
    });
    return stdout.trim();
  }
}

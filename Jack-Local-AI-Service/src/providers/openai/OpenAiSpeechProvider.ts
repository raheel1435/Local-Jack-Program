import { createReadStream } from "node:fs";
import OpenAI from "openai";
import { config } from "../../config/services.js";
import { CredentialAuthError } from "../../lib/providerErrors.js";
import type { CredentialStore } from "../../lib/credentialStore.js";
import type { AsrProvider, JackTranscribeResponse, ProviderStatus } from "../../types/jack.js";
import { COMMAND_VOCABULARY_PROMPT } from "../whisper/WhisperProvider.js";

const HEALTH_TIMEOUT_MS = 2000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;

/**
 * OpenAI Speech: a third ASR engine (Stage 2, multi-provider AI milestone),
 * completely independent of AiBrainSelector's own "openai" value -- picking
 * this as the speech engine does NOT select OpenAI as the AI brain, and
 * vice versa. Implements the same AsrProvider interface as
 * WhisperProvider/VibeAsrProvider so routes/the UI never need
 * engine-specific branching.
 *
 * Shares the SAME BYOK "openai" CredentialStore entry OpenAiProvider (chat)
 * uses -- one saved key, usable by both, per the milestone's "no duplicate
 * credential storage, no second OpenAI Speech key" requirement. Uses the
 * official `openai` SDK's audio.transcriptions.create() (POST
 * /v1/audio/transcriptions), never raw fetch, matching this project's
 * official-SDK-first convention for third-party LLM/cloud APIs.
 *
 * Reuses WhisperProvider's exported COMMAND_VOCABULARY_PROMPT word list
 * rather than a second hand-maintained copy: the WHISPER FALSE-DESTRUCTIVE-
 * COMMAND ROOT-CAUSE milestone found that a decoder/style prompt containing
 * COMPLETE example command sentences ("Jack, stop.") can make a model
 * regurgitate them verbatim from noise/near-silent audio -- the fix there
 * was a bare word list with no complete sentences. OpenAI's `prompt`
 * parameter plays the identical decoder-priming role whisper.cpp's
 * --prompt does, so this provider must never diverge from that
 * word-list-only discipline (no synthetic "Nova, stop" or similar).
 */
export class OpenAiSpeechProvider implements AsrProvider {
  readonly id = "openai" as const;
  readonly name = "OpenAI Speech";

  constructor(
    private readonly credentials: CredentialStore,
    private readonly model: string = config.openaiTranscriptionModel,
  ) {}

  async checkHealth(): Promise<ProviderStatus> {
    const key = await this.credentials.getDecrypted("openai");
    // No key configured -- unavailable immediately, no network call. Same
    // reasoning as OpenAiProvider (chat)'s checkHealth().
    if (key === null) return "unavailable";
    try {
      const client = new OpenAI({ apiKey: key, timeout: HEALTH_TIMEOUT_MS, maxRetries: 0 });
      await client.models.list();
      return "available";
    } catch {
      // Must never throw -- healthRouter/this route's own gate both assume
      // checkHealth() always resolves.
      return "unavailable";
    }
  }

  async transcribe(
    audioFilePath: string,
    language?: string,
    opts?: { hotwords?: string[] },
  ): Promise<JackTranscribeResponse> {
    const key = await this.credentials.getDecrypted("openai");
    if (key === null) {
      throw new CredentialAuthError("openai");
    }

    // Same vocabulary-priming + hotword-append pattern as
    // WhisperProvider.buildWhisperArgs -- deliberately words only, never
    // complete command sentences (see class doc comment).
    const prompt = opts?.hotwords?.length
      ? `${COMMAND_VOCABULARY_PROMPT} ${opts.hotwords.join(", ")}.`
      : COMMAND_VOCABULARY_PROMPT;

    const start = Date.now();
    const client = new OpenAI({ apiKey: key, timeout: TRANSCRIBE_TIMEOUT_MS, maxRetries: 0 });

    try {
      // The gateway's own route already wrote the browser's uploaded audio
      // to a uniquely-named temp .wav file before calling this (same file
      // Whisper/VibeVoice consume) -- streamed here, not buffered again, and
      // deleted by the route's own finally block regardless of outcome. WAV
      // is a natively-supported OpenAI upload format, so no transcoding.
      const result = await client.audio.transcriptions.create({
        file: createReadStream(audioFilePath),
        model: this.model,
        prompt,
        ...(language ? { language } : {}),
      });

      return {
        text: (result.text ?? "").trim(),
        provider: this.id,
        latencyMs: Date.now() - start,
        language,
      };
    } catch (e) {
      if (e instanceof OpenAI.AuthenticationError) {
        throw new CredentialAuthError("openai");
      }
      throw e;
    }
  }
}

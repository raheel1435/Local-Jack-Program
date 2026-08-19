import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { WhisperProvider } from "../providers/whisper/WhisperProvider.js";
import type {
  AsrProvider,
  AsrProviderId,
  JackErrorResponse,
  JackTranscribeRequest,
} from "../types/jack.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function parseProvider(value: unknown): AsrProviderId | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === "whisper" || value === "vibevoice") return value;
  return "invalid";
}

export function transcriptionRouter(whisper: WhisperProvider, vibevoice: AsrProvider): Router {
  const router = Router();
  const providers: Record<AsrProviderId, AsrProvider> = { whisper, vibevoice };

  router.post("/jack/transcribe", async (req, res) => {
    const isAudioUpload = Buffer.isBuffer(req.body);

    // Provider selection: explicit only, defaults to "whisper" (Approved).
    // There is NO fallback from vibevoice -> whisper anywhere in this route
    // -- if the requested engine is unavailable, that request fails with a
    // structured error and the caller decides what to do next.
    const rawProvider = isAudioUpload ? req.query.provider : (req.body as Partial<JackTranscribeRequest>).provider;
    const parsedProvider = parseProvider(rawProvider);
    if (parsedProvider === "invalid") {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: `Unknown provider "${String(rawProvider)}". Expected "whisper" or "vibevoice".`,
      };
      res.status(400).json(err);
      return;
    }
    const providerId: AsrProviderId = parsedProvider ?? "whisper";
    const provider = providers[providerId];

    // Browser path: raw audio/wav bytes in the body. The gateway owns the
    // temp filename end to end -- nothing derived from client input ever
    // reaches the filesystem, so there is no path-traversal surface here.
    if (isAudioUpload) {
      const audioBuffer = req.body as Buffer;
      if (audioBuffer.length === 0) {
        const err: JackErrorResponse = {
          error: "invalid_request",
          detail: "Uploaded audio was empty.",
        };
        res.status(400).json(err);
        return;
      }
      if (audioBuffer.length > MAX_UPLOAD_BYTES) {
        const err: JackErrorResponse = {
          error: "invalid_request",
          detail: "Uploaded audio exceeds the 25 MB limit.",
        };
        res.status(413).json(err);
        return;
      }

      const status = await provider.checkHealth();
      if (status === "unavailable") {
        const err: JackErrorResponse = {
          error: `${providerId}_unavailable`,
          detail: unavailableDetail(providerId),
        };
        res.status(503).json(err);
        return;
      }

      const language = typeof req.query.language === "string" ? req.query.language : undefined;
      const tempPath = join(tmpdir(), `jack-transcribe-${randomUUID()}.wav`);
      try {
        await writeFile(tempPath, audioBuffer);
        const result = await provider.transcribe(tempPath, language);
        res.json(result);
      } catch (e) {
        const err: JackErrorResponse = {
          error: `${providerId}_request_failed`,
          detail: e instanceof Error ? e.message : String(e),
        };
        res.status(502).json(err);
      } finally {
        await unlink(tempPath).catch(() => {
          // best-effort cleanup -- nothing more to do if this fails
        });
      }
      return;
    }

    // Backend-testing path: an already-on-disk file path (unchanged).
    const body = req.body as Partial<JackTranscribeRequest>;
    if (!body.audioFilePath || typeof body.audioFilePath !== "string") {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail:
          "Request body must include a local `audioFilePath` string, or be a raw audio/wav upload.",
      };
      res.status(400).json(err);
      return;
    }

    const status = await provider.checkHealth();
    if (status === "unavailable") {
      const err: JackErrorResponse = {
        error: `${providerId}_unavailable`,
        detail: unavailableDetail(providerId),
      };
      res.status(503).json(err);
      return;
    }

    try {
      const result = await provider.transcribe(
        body.audioFilePath,
        body.language
      );
      res.json(result);
    } catch (e) {
      const err: JackErrorResponse = {
        error: `${providerId}_request_failed`,
        detail: e instanceof Error ? e.message : String(e),
      };
      res.status(502).json(err);
    }
  });

  return router;
}

function unavailableDetail(providerId: AsrProviderId): string {
  return providerId === "whisper"
    ? "whisper.cpp is not configured or its executable/model path is missing. Set WHISPER_EXECUTABLE_PATH and WHISPER_MODEL_PATH."
    : "VibeVoice-ASR-BitNet (Test engine) is not configured or its executable/model paths are missing. Set VIBE_ASR_EXECUTABLE_PATH, VIBE_ASR_VAE_MODEL_PATH and VIBE_ASR_LM_MODEL_PATH. There is no automatic fallback to Whisper -- switch engines explicitly if you need a transcript now.";
}

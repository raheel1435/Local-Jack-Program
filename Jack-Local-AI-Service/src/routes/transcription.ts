import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { WhisperProvider } from "../providers/whisper/WhisperProvider.js";
import type {
  JackErrorResponse,
  JackTranscribeRequest,
} from "../types/jack.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function transcriptionRouter(whisper: WhisperProvider): Router {
  const router = Router();

  router.post("/jack/transcribe", async (req, res) => {
    const isAudioUpload = Buffer.isBuffer(req.body);

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

      const status = await whisper.checkHealth();
      if (status === "unavailable") {
        const err: JackErrorResponse = {
          error: "whisper_unavailable",
          detail:
            "whisper.cpp is not configured or its executable/model path is missing. Set WHISPER_EXECUTABLE_PATH and WHISPER_MODEL_PATH.",
        };
        res.status(503).json(err);
        return;
      }

      const language = typeof req.query.language === "string" ? req.query.language : undefined;
      const tempPath = join(tmpdir(), `jack-transcribe-${randomUUID()}.wav`);
      try {
        await writeFile(tempPath, audioBuffer);
        const result = await whisper.transcribe(tempPath, language);
        res.json(result);
      } catch (e) {
        const err: JackErrorResponse = {
          error: "whisper_request_failed",
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

    const status = await whisper.checkHealth();
    if (status === "unavailable") {
      const err: JackErrorResponse = {
        error: "whisper_unavailable",
        detail:
          "whisper.cpp is not configured or its executable/model path is missing. Set WHISPER_EXECUTABLE_PATH and WHISPER_MODEL_PATH.",
      };
      res.status(503).json(err);
      return;
    }

    try {
      const result = await whisper.transcribe(
        body.audioFilePath,
        body.language
      );
      res.json(result);
    } catch (e) {
      const err: JackErrorResponse = {
        error: "whisper_request_failed",
        detail: e instanceof Error ? e.message : String(e),
      };
      res.status(502).json(err);
    }
  });

  return router;
}

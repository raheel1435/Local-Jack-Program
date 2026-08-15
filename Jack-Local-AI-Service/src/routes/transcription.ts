import { Router } from "express";
import { WhisperProvider } from "../providers/whisper/WhisperProvider.js";
import type {
  JackErrorResponse,
  JackTranscribeRequest,
} from "../types/jack.js";

export function transcriptionRouter(whisper: WhisperProvider): Router {
  const router = Router();

  router.post("/jack/transcribe", async (req, res) => {
    const body = req.body as Partial<JackTranscribeRequest>;
    if (!body.audioFilePath || typeof body.audioFilePath !== "string") {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: "Request body must include a local `audioFilePath` string.",
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

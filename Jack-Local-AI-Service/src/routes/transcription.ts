import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { WhisperProvider } from "../providers/whisper/WhisperProvider.js";
import { AdmissionGate } from "../lib/admission.js";
import { CredentialAuthError, isRateLimitError, publicAuthFailure } from "../lib/providerErrors.js";
import type { CredentialStore } from "../lib/credentialStore.js";
import type {
  AsrProvider,
  AsrProviderId,
  JackErrorResponse,
} from "../types/jack.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function parseProvider(value: unknown): AsrProviderId | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === "whisper" || value === "vibevoice" || value === "openai") return value;
  return "invalid";
}

function parseAssistantName(value: unknown): string | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return "invalid";
  const name = value.trim();
  // Persona labels are short human names. Bound and constrain this decoder
  // hint so arbitrary query text cannot enlarge or reshape Whisper's prompt.
  if (!/^[A-Za-z][A-Za-z '-]{0,39}$/.test(name)) return "invalid";
  return name;
}

export function transcriptionRouter(
  whisper: WhisperProvider,
  vibevoice: AsrProvider,
  openaiSpeech: AsrProvider,
  credentialStore?: CredentialStore,
): Router {
  const router = Router();
  const providers: Record<AsrProviderId, AsrProvider> = { whisper, vibevoice, openai: openaiSpeech };
  const gates: Record<AsrProviderId, AdmissionGate> = {
    whisper: new AdmissionGate(2, 2),
    vibevoice: new AdmissionGate(1, 2),
    // Same sizing as chat.ts/intent.ts's cloudGates -- bounds fan-out
    // against a paid, rate-limited API. Unlike whisper/vibevoice this is a
    // genuinely new exposure class ASR never had before Stage 2.
    openai: new AdmissionGate(2, 4),
  };

  router.post("/jack/transcribe", async (req, res) => {
    // Security-boundary hardening: this route used to also accept a JSON
    // body naming an arbitrary already-on-disk `audioFilePath`, with no
    // caller-identity check and no root restriction -- any gateway-reachable
    // client could make the configured ASR engine open (and, via its output,
    // effectively leak the contents of) any file the gateway process could
    // read. Nothing in the shipped product ever used that mode (the browser
    // frontend always uploads raw audio/wav bytes; a repo-wide search found
    // zero callers of the corresponding jackApi.transcribe() client method),
    // so it has been removed rather than sandboxed. The gateway owns the
    // temp filename end to end for every real request -- nothing derived
    // from client input ever reaches the filesystem, so there is no
    // path-traversal surface here.
    if (!Buffer.isBuffer(req.body)) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: "Request body must be a raw audio/wav upload (Content-Type: audio/wav).",
      };
      res.status(400).json(err);
      return;
    }

    // Provider selection is explicit and defaults to Whisper. Vibe may make
    // one request-level local fallback to Whisper; no path enters cloud here.
    const rawProvider = req.query.provider;
    const parsedProvider = parseProvider(rawProvider);
    if (parsedProvider === "invalid") {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: `Unknown provider "${String(rawProvider)}". Expected "whisper", "vibevoice", or "openai".`,
      };
      res.status(400).json(err);
      return;
    }
    const providerId: AsrProviderId = parsedProvider ?? "whisper";
    const provider = providers[providerId];

    const assistantName = parseAssistantName(req.query.assistantName);
    if (assistantName === "invalid") {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: "assistantName must be a 1-40 character human name.",
      };
      res.status(400).json(err);
      return;
    }

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

    const abortController = new AbortController();
    const abort = () => abortController.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    const release = await gates[providerId].acquire(abortController.signal);
    if (!release) {
      if (!res.headersSent) {
        const err: JackErrorResponse = {
          error: `${providerId}_busy`,
          detail: `${providerId} is at capacity; retry after an in-flight request completes.`,
        };
        res.status(429).json(err);
      }
      return;
    }

    try {
      const status = await provider.checkHealth();
      if (status === "unavailable") {
        if (providerId === "vibevoice") {
          const whisperStatus = await whisper.checkHealth();
          if (whisperStatus === "available") {
            const language = typeof req.query.language === "string" ? req.query.language : undefined;
            const tempPath = join(tmpdir(), `jack-transcribe-${randomUUID()}.wav`);
            try {
              await writeFile(tempPath, audioBuffer);
              const result = await whisper.transcribe(tempPath, language, assistantName ? { hotwords: [assistantName] } : undefined);
              console.warn("[provider-fallback] Vibe unavailable; using Whisper for this request.");
              res.json({ ...result, requestedProvider: "vibevoice", actualProvider: "whisper", fallbackUsed: true, fallbackFrom: "vibevoice" });
            } catch (error) {
              const err: JackErrorResponse = await asrFailure("whisper", error, credentialStore);
              res.status(502).json(err);
            } finally {
              await unlink(tempPath).catch(() => {});
            }
            return;
          }
        }
        // openai is a BYOK cloud engine -- "unavailable" can mean not
        // configured, an invalid stored key, or a genuinely unreachable
        // API, and the caller deserves to know which (same distinction
        // chat.ts/intent.ts already make for the AI-brain axis). whisper/
        // vibevoice stay on the existing static unavailableDetail() text.
        let detail: string;
        if (providerId === "openai") {
          const cred = await credentialStore?.status("openai");
          detail =
            !cred || cred.status === "not_configured"
              ? "No OpenAI API key is configured. Add one in Settings before selecting OpenAI Speech."
              : cred.status === "invalid"
                ? "The stored OpenAI API key was rejected. Update it in Settings."
                : "OpenAI Speech is not reachable right now.";
        } else {
          detail = unavailableDetail(providerId);
        }
        const err: JackErrorResponse = {
          error: `${providerId}_unavailable`,
          detail,
          code: "provider_unavailable",
          provider: providerId,
          ...(await asrFallbackFields(providerId, credentialStore)),
        };
        res.status(503).json(err);
        return;
      }

      const language = typeof req.query.language === "string" ? req.query.language : undefined;
      const tempPath = join(tmpdir(), `jack-transcribe-${randomUUID()}.wav`);
      try {
        await writeFile(tempPath, audioBuffer);
        try {
          const result = await provider.transcribe(
            tempPath,
            language,
            assistantName ? { hotwords: [assistantName] } : undefined,
          );
          res.json({ ...result, requestedProvider: providerId, actualProvider: providerId, fallbackUsed: false });
        } catch (primaryError) {
          if (providerId !== "vibevoice" || await whisper.checkHealth() === "unavailable") throw primaryError;
          try {
            const result = await whisper.transcribe(
              tempPath,
              language,
              assistantName ? { hotwords: [assistantName] } : undefined,
            );
            console.warn("[provider-fallback] Vibe request failed; using Whisper for this request.");
            res.json({ ...result, requestedProvider: "vibevoice", actualProvider: "whisper", fallbackUsed: true, fallbackFrom: "vibevoice" });
          } catch (fallbackError) {
            res.status(502).json(await asrFailure("whisper", fallbackError, credentialStore));
          }
        }
      } catch (e) {
        // Distinct failure class only openai's provider can throw (a
        // previously-valid key that was revoked/rejected mid-flight) --
        // mirrors chat.ts's CredentialAuthError -> 401 mapping exactly.
        // whisper/vibevoice never throw this, so this branch is a no-op for
        // them.
        if (e instanceof CredentialAuthError) {
          const err: JackErrorResponse = { error: `${providerId}_unauthorized`, detail: publicAuthFailure(e.providerId), code: "provider_unauthorized", provider: providerId, ...(await asrFallbackFields(providerId, credentialStore)) };
          res.status(401).json(err);
          return;
        }
        const err = await asrFailure(providerId, e, credentialStore);
        res.status(502).json(err);
      } finally {
        await unlink(tempPath).catch(() => {
          // best-effort cleanup -- nothing more to do if this fails
        });
      }
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
      release();
    }
  });

  return router;
}

// Narrowed to the two providers that actually use this static text -- the
// openai branch above builds its own credential-aware detail and never
// calls this, so a future accidental call with "openai" is a compile error
// instead of a silently mislabeled (VibeVoice-flavored) message.
function unavailableDetail(providerId: "whisper" | "vibevoice"): string {
  return providerId === "whisper"
    ? "whisper.cpp is not configured or its executable/model path is missing. Set WHISPER_EXECUTABLE_PATH and WHISPER_MODEL_PATH."
    : "VibeVoice-ASR-BitNet (Test engine) and local Whisper are unavailable. Check their executable and model paths.";
}

async function asrFallbackFields(providerId: AsrProviderId, credentialStore?: CredentialStore): Promise<Pick<JackErrorResponse, "fallbackOptions" | "requiresConsent" | "credentialRequired">> {
  if (providerId === "openai") return { fallbackOptions: ["whisper"], requiresConsent: true };
  if (providerId === "whisper") {
    const connected = (await credentialStore?.status("openai"))?.status === "connected";
    return connected
      ? { fallbackOptions: ["openai"], requiresConsent: true }
      : { fallbackOptions: [], requiresConsent: true, credentialRequired: "openai" };
  }
  return { fallbackOptions: [], requiresConsent: false };
}

async function asrFailure(providerId: AsrProviderId, error: unknown, credentialStore?: CredentialStore): Promise<JackErrorResponse> {
  return {
    error: `${providerId}_request_failed`,
    detail: providerId === "openai"
      ? isRateLimitError(error) ? "OpenAI Speech is temporarily rate limited." : "OpenAI Speech could not transcribe this audio."
      : error instanceof Error ? error.message : String(error),
    code: "provider_request_failed",
    provider: providerId,
    ...(await asrFallbackFields(providerId, credentialStore)),
  };
}

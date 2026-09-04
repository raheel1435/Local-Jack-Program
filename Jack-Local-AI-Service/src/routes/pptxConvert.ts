import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Router, raw, type RequestHandler } from "express";
import { AdmissionGate } from "../lib/admission.js";
import type { JackErrorResponse } from "../types/jack.js";

const execFileAsync = promisify(execFile);

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // matches the app's own upload limit
const CONVERT_TIMEOUT_MS = 60_000;
// Security-boundary hardening: PowerPoint COM conversion is already
// serialized to one-at-a-time (see runExclusive below), but the temp-file
// write previously happened for EVERY request before that serialization
// point -- any number of concurrent large (up to 100MB) uploads could still
// write to disk and hold the full buffer in memory in parallel. This caps
// how many requests may be mid-flight (writing + waiting on the queue) at
// once; anything past that gets a fast, cheap 429 before any disk work.
export const MAX_CONCURRENT_PPTX_REQUESTS = 3;
export const PPTX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, "..", "..", "scripts", "convert-pptx-to-pdf.ps1");
const MAX_ERROR_DETAIL_LENGTH = 300;

/**
 * PPTX visual-fallback fix: never forward a promisified execFile rejection's
 * raw `.message` (it's "Command failed: <full argv>\n<stderr>" -- the FULL
 * command line, including this request's own temp file paths) straight to
 * the client. `stderr` alone is just what the PowerShell script itself
 * wrote (a short, friendly, stage-tagged "STAGE:<id>|<message>" sentence as
 * of the root-cause investigation pass); trimmed and length-capped here
 * too, as a second layer, so an unexpected future failure mode still can't
 * dump an unbounded/raw block of text into the presentation UI the way the
 * original COM exception did.
 */
export interface ConversionFailure {
  stage: string;
  detail: string;
}

const STAGE_PREFIX = /^STAGE:([a-z_]+)\|([\s\S]*)$/;

export function extractConversionFailure(e: unknown): ConversionFailure {
  // Node's own execFile-level timeout (the process didn't exit in time and
  // was killed) never reaches the script's own stderr-writing code at all --
  // this is its own distinct stage, detected from the error object Node
  // itself constructs (`killed: true`), not from anything the script wrote.
  if (e && typeof e === "object" && (e as { killed?: unknown }).killed === true) {
    return { stage: "timeout", detail: `PowerPoint conversion did not finish within ${CONVERT_TIMEOUT_MS / 1000} seconds.` };
  }

  const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr?: unknown }).stderr ?? "").trim() : "";
  const raw = stderr || (e instanceof Error ? e.message : String(e));
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? "";

  const staged = STAGE_PREFIX.exec(firstLine);
  const stage = staged ? staged[1] : "unknown";
  const detail = (staged ? staged[2] : firstLine).trim() || "PowerPoint conversion failed for an unknown reason.";
  return { stage, detail: detail.length > MAX_ERROR_DETAIL_LENGTH ? `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}...` : detail };
}

/**
 * PowerPoint COM automation doesn't handle concurrent Presentations.Open
 * calls well -- a second automation call while one is in flight can attach
 * to the same running instance and interfere with it. This is a
 * single-user local desktop tool, not a multi-tenant server, so a simple
 * in-process queue (not a distributed lock) is sufficient: every request
 * waits for the previous conversion to finish before starting its own.
 */
let queue: Promise<void> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Real PPTX -> PDF visual fidelity via local PowerPoint COM automation --
 * the app's own text-extraction fallback stays in place for machines
 * without PowerPoint, or if a specific conversion fails. Client sends raw
 * .pptx bytes; response is the converted PDF, or a 502 with a clear reason
 * (never a silent/faked success).
 */
export function createPptxAdmissionMiddleware(
  gate = new AdmissionGate(MAX_CONCURRENT_PPTX_REQUESTS, 0),
): RequestHandler {
  return (_req, res, next) => {
    const release = gate.tryAcquire();
    if (!release) {
      const err: JackErrorResponse = {
        error: "too_many_requests",
        detail: `Too many PPTX conversions already in progress (max ${MAX_CONCURRENT_PPTX_REQUESTS}). Try again shortly.`,
      };
      res.status(429).json(err);
      return;
    }
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    res.once("finish", releaseOnce);
    res.once("close", releaseOnce);
    next();
  };
}

export function pptxConvertRouter(): Router {
  const router = Router();

  router.post(
    "/jack/convert-pptx",
    createPptxAdmissionMiddleware(),
    raw({ type: PPTX_CONTENT_TYPE, limit: "100mb" }),
    async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: "Request body must be raw .pptx bytes.",
      };
      res.status(400).json(err);
      return;
    }
    if (req.body.length > MAX_UPLOAD_BYTES) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: "Uploaded file exceeds the 100 MB limit.",
      };
      res.status(413).json(err);
      return;
    }

    const id = randomUUID();
    const inputPath = join(tmpdir(), `jack-pptx-${id}.pptx`);
    const outputPath = join(tmpdir(), `jack-pptx-${id}.pdf`);
    const audioBuffer = req.body as Buffer;

    try {
      await writeFile(inputPath, audioBuffer);
      await runExclusive(() =>
        execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            SCRIPT_PATH,
            "-InputPath",
            inputPath,
            "-OutputPath",
            outputPath,
          ],
          { timeout: CONVERT_TIMEOUT_MS },
        ),
      );
      const pdfBuffer = await readFile(outputPath);
      res.setHeader("Content-Type", "application/pdf");
      res.send(pdfBuffer);
    } catch (e) {
      // A forced timeout can leave PowerPoint running because the script's
      // finally block cannot execute. Deliberately do not guess which
      // POWERPNT process belongs to this request: leaving a possible orphan
      // is safer than terminating a user's unrelated process and losing
      // unsaved work.
      const failure = extractConversionFailure(e);
      const err: JackErrorResponse = {
        error: "pptx_conversion_failed",
        stage: failure.stage,
        detail: failure.detail,
      };
      res.status(502).json(err);
    } finally {
      await unlink(inputPath).catch(() => {
        // best-effort cleanup -- nothing more to do if this fails
      });
      await unlink(outputPath).catch(() => {
        // best-effort cleanup -- nothing more to do if this fails
      });
    }
  });

  return router;
}

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../config/services.js";

const HEALTH_CHECK_TIMEOUT_MS = 2000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 500;
const STDERR_TAIL_MAX_LENGTH = 2000;

export type LocalRuntimeState = "ready" | "restarting" | "failed" | "config_error";

export interface LocalRuntimeStatus {
  state: LocalRuntimeState;
  /** True only while THIS class currently owns the running process (it
   * spawned it and hasn't lost track of it) -- never true for a runtime
   * that was already healthy when checked, since that one could equally be
   * an externally started process this class must never touch. */
  ownedByJack: boolean;
  detail?: string;
}

type SpawnFn = typeof spawn;

export interface LocalRuntimeManagerOptions {
  baseUrl?: string;
  executablePath?: string;
  modelPath?: string;
  host?: string;
  startupTimeoutMs?: number;
  healthPollIntervalMs?: number;
  spawnFn?: SpawnFn;
}

/**
 * Auto-start milestone: Local AI (llama.cpp) is meant to be available by
 * default, without the user manually running llama-server.exe first. This
 * class is the one place that decides whether to reuse an already-healthy
 * runtime or launch one -- every actual request still goes through
 * LlamaCppProvider exactly as before; this only makes sure something is
 * listening at llamacppBaseUrl before that provider ever needs it.
 *
 * Ownership is the load-bearing distinction throughout this class: a
 * runtime that was ALREADY healthy when checked (started by the user, a
 * previous gateway run, or anything else) is never touched again -- not
 * killed on shutdown, not restarted on a later health dip (this class isn't
 * even watching it). Only a process THIS instance actually spawned via
 * spawnFn is tracked in `child` and eligible for stop()/crash-restart.
 */
export class LocalRuntimeManager {
  private readonly baseUrl: string;
  private readonly executablePath: string;
  private readonly modelPath: string;
  private readonly host: string;
  private readonly startupTimeoutMs: number;
  private readonly healthPollIntervalMs: number;
  private readonly spawnFn: SpawnFn;

  private child: ChildProcess | null = null;
  private status: LocalRuntimeStatus = { state: "failed", ownedByJack: false, detail: "Not started yet." };
  private ensurePromise: Promise<LocalRuntimeStatus> | null = null;
  private restarted = false;
  private stopped = false;

  constructor(options: LocalRuntimeManagerOptions = {}) {
    this.baseUrl = options.baseUrl ?? config.llamacppBaseUrl;
    this.executablePath = options.executablePath ?? config.llamacppExecutablePath;
    this.modelPath = options.modelPath ?? config.llamacppModelPath;
    this.host = options.host ?? "127.0.0.1";
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.healthPollIntervalMs = options.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  getStatus(): LocalRuntimeStatus {
    return this.status;
  }

  /** Safe to call more than once, including concurrently -- a call already
   * in flight is reused rather than launching a second process, and a call
   * after a previous success just re-confirms health (no new process). */
  ensureReady(): Promise<LocalRuntimeStatus> {
    if (this.ensurePromise) return this.ensurePromise;
    const attempt = this.ensureReadyOnce().finally(() => {
      if (this.ensurePromise === attempt) this.ensurePromise = null;
    });
    this.ensurePromise = attempt;
    return attempt;
  }

  private async ensureReadyOnce(): Promise<LocalRuntimeStatus> {
    if (await this.checkHealth()) {
      // Reuse: either our own previously spawned process or a healthy
      // external one -- both count as "ready", ownership is unchanged.
      this.status = { state: "ready", ownedByJack: this.child !== null };
      return this.status;
    }

    if (!this.executablePath || !existsSync(this.executablePath)) {
      this.status = {
        state: "config_error",
        ownedByJack: false,
        detail: `Local AI could not start because the llama-server executable was not found${this.executablePath ? ` at "${this.executablePath}"` : " (LLAMACPP_EXECUTABLE_PATH is not configured)"}.`,
      };
      return this.status;
    }
    if (!this.modelPath || !existsSync(this.modelPath)) {
      this.status = {
        state: "config_error",
        ownedByJack: false,
        detail: `Local AI could not start because the model file was not found${this.modelPath ? ` at "${this.modelPath}"` : " (LLAMACPP_MODEL_PATH is not configured)"}.`,
      };
      return this.status;
    }

    return this.spawnAndWait();
  }

  private spawnAndWait(): Promise<LocalRuntimeStatus> {
    return new Promise<LocalRuntimeStatus>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(this.executablePath, [
          "-m",
          this.modelPath,
          "--host",
          this.host,
          "--port",
          this.port(),
        ]);
      } catch (e) {
        const status: LocalRuntimeStatus = {
          state: "failed",
          ownedByJack: false,
          detail: `Local AI could not start: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
        };
        this.status = status;
        resolve(status);
        return;
      }
      this.child = child;

      let stderrTail = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX_LENGTH);
      });

      let settled = false;
      const finish = (status: LocalRuntimeStatus) => {
        if (settled) return;
        settled = true;
        this.status = status;
        resolve(status);
      };

      // Failure before health ever passes -- e.g. the port is already held
      // by something that isn't answering /health, or the model failed to
      // load. A later exit (after `finish` already resolved "ready") is a
      // crash, handled separately by watchForCrash below.
      child.once("exit", (code) => {
        if (settled) return;
        this.child = null;
        const portInUse = /address already in use|EADDRINUSE|only one usage of each socket/i.test(stderrTail);
        finish({
          state: "failed",
          ownedByJack: false,
          detail: portInUse
            ? `Local AI could not start because port ${this.port()} is already in use.`
            : `Local AI could not start (llama-server exited with code ${code}).`,
        });
      });
      child.once("error", (err) => {
        if (settled) return;
        this.child = null;
        finish({ state: "failed", ownedByJack: false, detail: `Local AI could not start: ${err.message}`.slice(0, 300) });
      });

      const deadline = Date.now() + this.startupTimeoutMs;
      const poll = async () => {
        if (settled) return;
        if (await this.checkHealth()) {
          finish({ state: "ready", ownedByJack: true });
          this.watchForCrash(child);
          return;
        }
        if (Date.now() >= deadline) {
          finish({ state: "failed", ownedByJack: true, detail: `Local AI did not become ready within ${this.startupTimeoutMs / 1000} seconds.` });
          child.kill();
          return;
        }
        setTimeout(poll, this.healthPollIntervalMs);
      };
      setTimeout(poll, this.healthPollIntervalMs);
    });
  }

  /** One bounded restart attempt if a Jack-owned runtime dies later, on its
   * own, outside of ensureReady() -- never for an external process (this is
   * only ever attached to a child THIS class spawned). */
  private watchForCrash(child: ChildProcess): void {
    child.once("exit", (code) => {
      if (this.child !== child) return; // superseded by stop() or another restart already
      this.child = null;
      if (this.stopped) return; // intentional shutdown, not a crash
      if (this.restarted) {
        this.status = {
          state: "failed",
          ownedByJack: false,
          detail: `Local AI (llama-server) exited unexpectedly (code ${code}) and the automatic restart also failed. Restart it manually if needed.`,
        };
        return;
      }
      this.restarted = true;
      this.status = {
        state: "restarting",
        ownedByJack: false,
        detail: "Local AI (llama-server) exited unexpectedly; attempting one automatic restart.",
      };
      void this.spawnAndWait().then((status) => {
        this.status = status;
      });
    });
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private port(): string {
    try {
      return new URL(this.baseUrl).port || "80";
    } catch {
      return "8081";
    }
  }

  /** Terminates ONLY a Jack-owned child (a process this class itself
   * spawned) -- never an externally started, already-healthy llama-server.
   * Safe to call even if nothing is running. */
  stop(): void {
    this.stopped = true;
    if (this.child) {
      const child = this.child;
      this.child = null;
      child.kill();
    }
  }
}

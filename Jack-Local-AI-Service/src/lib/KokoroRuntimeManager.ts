import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { config } from "../config/services.js";

const HEALTH_CHECK_TIMEOUT_MS = 2000;
// Kokoro's startup does real work beyond just binding a port -- loading a
// ~327MB PyTorch model on CPU and running one warmup synthesis before it
// reports ready -- confirmed live to take ~15-20s, well past llama.cpp's
// 30s-is-plenty default. 60s gives real headroom without masking a genuine
// hang.
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 500;
const OUTPUT_TAIL_MAX_LENGTH = 2000;

export type KokoroRuntimeState = "ready" | "restarting" | "failed" | "config_error";

export interface KokoroRuntimeStatus {
  state: KokoroRuntimeState;
  /** Same meaning as LocalRuntimeManager's ownedByJack -- true only while
   * THIS class currently owns the running process. */
  ownedByJack: boolean;
  detail?: string;
}

type SpawnFn = typeof spawn;

export interface KokoroRuntimeManagerOptions {
  baseUrl?: string;
  projectRoot?: string;
  host?: string;
  startupTimeoutMs?: number;
  healthPollIntervalMs?: number;
  spawnFn?: SpawnFn;
}

/**
 * Same auto-start pattern as LocalRuntimeManager (see its own doc comment
 * for the full ownership rationale), applied to Kokoro-FastAPI -- the TTS
 * engine behind /jack/speak. Launches the project's own virtualenv's
 * `python.exe -m uvicorn api.src.main:app` directly (same env vars, same
 * relative MODEL_DIR/VOICES_DIR as runtime-dependencies/Kokoro-FastAPI's own
 * start-cpu.ps1), bound to 127.0.0.1 instead of that script's 0.0.0.0 --
 * this is a local-only dev service, matching every other Jack-launched
 * runtime's loopback-only convention.
 *
 * Deliberately does NOT go through `uv run uvicorn` the way start-cpu.ps1
 * does, despite that being the "official" invocation -- confirmed live that
 * it fails two different ways under Node's spawn() with no shell: a bare
 * "uv" ENOENTs when `cwd` is also set (a real Windows/libuv interaction),
 * and even once resolved to an absolute path, `uv run uvicorn ...` exits
 * silently (code 1, no output) for reasons that didn't repro under a normal
 * shell. `uv run python -m uvicorn ...` (still through uv) DOES work, but
 * was observed to exit early once uv hands off to Python while the actual
 * server keeps running as an ORPHANED, no-longer-tracked process -- which
 * would break this class's exit/crash-detection entirely (a false "failed"
 * right after a real success, and a watchForCrash that can never fire for
 * the process that's actually serving requests). Spawning the venv's own
 * python.exe directly sidesteps every one of these: no bare-name PATH
 * lookup, no wrapper process, one child that IS the server for its whole
 * lifetime. Skips start-cpu.ps1's `uv pip install`/model-download steps
 * deliberately (one-time environment setup, not something to re-run on
 * every gateway boot) -- a missing venv/model is instead reported as a
 * clear config_error (see below), never attempted.
 */
export class KokoroRuntimeManager {
  private readonly baseUrl: string;
  private readonly projectRoot: string;
  private readonly host: string;
  private readonly startupTimeoutMs: number;
  private readonly healthPollIntervalMs: number;
  private readonly spawnFn: SpawnFn;

  private child: ChildProcess | null = null;
  private status: KokoroRuntimeStatus = { state: "failed", ownedByJack: false, detail: "Not started yet." };
  private ensurePromise: Promise<KokoroRuntimeStatus> | null = null;
  private restarted = false;
  private stopped = false;

  constructor(options: KokoroRuntimeManagerOptions = {}) {
    this.baseUrl = options.baseUrl ?? config.kokoroBaseUrl;
    this.projectRoot = options.projectRoot ?? config.kokoroProjectRoot;
    this.host = options.host ?? "127.0.0.1";
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.healthPollIntervalMs = options.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /** KOKORO_PROJECT_ROOT is documented/configured as a path relative to the
   * gateway's own cwd (matching every other *_PATH config in this project).
   * Confirmed live: passing that relative string straight through as both
   * `cwd` and part of the spawned command path breaks Node's own relative-
   * command resolution on Windows ("spawn ..\\...\\python.exe ENOENT" even
   * though the file is right there) -- resolving to an absolute path once,
   * up front, avoids the interaction entirely. */
  private absoluteProjectRoot(): string {
    return resolvePath(this.projectRoot);
  }

  private pythonExecutable(): string {
    const root = this.absoluteProjectRoot();
    return process.platform === "win32"
      ? join(root, ".venv", "Scripts", "python.exe")
      : join(root, ".venv", "bin", "python");
  }

  getStatus(): KokoroRuntimeStatus {
    return this.status;
  }

  /** Safe to call more than once, including concurrently -- see
   * LocalRuntimeManager.ensureReady()'s identical doc comment. */
  ensureReady(): Promise<KokoroRuntimeStatus> {
    if (this.ensurePromise) return this.ensurePromise;
    const attempt = this.ensureReadyOnce().finally(() => {
      if (this.ensurePromise === attempt) this.ensurePromise = null;
    });
    this.ensurePromise = attempt;
    return attempt;
  }

  private async ensureReadyOnce(): Promise<KokoroRuntimeStatus> {
    if (await this.checkHealth()) {
      this.status = { state: "ready", ownedByJack: this.child !== null };
      return this.status;
    }

    if (!this.projectRoot || !existsSync(this.projectRoot)) {
      this.status = {
        state: "config_error",
        ownedByJack: false,
        detail: `Kokoro TTS could not start because its project directory was not found${this.projectRoot ? ` at "${this.projectRoot}"` : " (KOKORO_PROJECT_ROOT is not configured)"}.`,
      };
      return this.status;
    }
    const modelPath = join(this.absoluteProjectRoot(), "api", "src", "models", "v1_0", "kokoro-v1_0.pth");
    if (!existsSync(modelPath)) {
      this.status = {
        state: "config_error",
        ownedByJack: false,
        detail: `Kokoro TTS could not start because its model file was not found at "${modelPath}". Run Kokoro-FastAPI's own setup (start-cpu.ps1/start-cpu.sh) once to download it.`,
      };
      return this.status;
    }
    const pythonExecutable = this.pythonExecutable();
    if (!existsSync(pythonExecutable)) {
      this.status = {
        state: "config_error",
        ownedByJack: false,
        detail: `Kokoro TTS could not start because its virtual environment's Python was not found at "${pythonExecutable}". Run Kokoro-FastAPI's own setup (start-cpu.ps1/start-cpu.sh) once to create it.`,
      };
      return this.status;
    }

    return this.spawnAndWait();
  }

  private spawnAndWait(): Promise<KokoroRuntimeStatus> {
    return new Promise<KokoroRuntimeStatus>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(
          this.pythonExecutable(),
          ["-m", "uvicorn", "api.src.main:app", "--host", this.host, "--port", this.port()],
          {
            cwd: this.absoluteProjectRoot(),
            env: {
              ...process.env,
              PYTHONUTF8: "1",
              PROJECT_ROOT: this.absoluteProjectRoot(),
              USE_GPU: "false",
              PYTHONPATH: `${this.absoluteProjectRoot()};${join(this.absoluteProjectRoot(), "api")}`,
              MODEL_DIR: "src/models",
              VOICES_DIR: "src/voices/v1_0",
              WEB_PLAYER_PATH: join(this.absoluteProjectRoot(), "web"),
            },
          },
        );
      } catch (e) {
        const status: KokoroRuntimeStatus = {
          state: "failed",
          ownedByJack: false,
          detail: `Kokoro TTS could not start: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
        };
        this.status = status;
        resolve(status);
        return;
      }
      this.child = child;

      let outputTail = "";
      const captureOutput = (chunk: Buffer) => {
        outputTail = (outputTail + chunk.toString()).slice(-OUTPUT_TAIL_MAX_LENGTH);
      };
      child.stdout?.on("data", captureOutput);
      child.stderr?.on("data", captureOutput);

      let settled = false;
      const finish = (status: KokoroRuntimeStatus) => {
        if (settled) return;
        settled = true;
        this.status = status;
        resolve(status);
      };

      // Same distinction as LocalRuntimeManager: a failure before health
      // ever passes is a startup failure; a later exit is a crash, handled
      // separately by watchForCrash below.
      child.once("exit", (code) => {
        if (settled) return;
        this.child = null;
        const portInUse = /address already in use|EADDRINUSE|10048|only one usage of each socket/i.test(outputTail);
        finish({
          state: "failed",
          ownedByJack: false,
          detail: portInUse
            ? `Kokoro TTS could not start because port ${this.port()} is already in use.`
            : `Kokoro TTS could not start (uvicorn exited with code ${code}).`,
        });
      });
      child.once("error", (err) => {
        if (settled) return;
        this.child = null;
        finish({ state: "failed", ownedByJack: false, detail: `Kokoro TTS could not start: ${err.message}`.slice(0, 300) });
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
          finish({ state: "failed", ownedByJack: true, detail: `Kokoro TTS did not become ready within ${this.startupTimeoutMs / 1000} seconds.` });
          child.kill();
          return;
        }
        setTimeout(poll, this.healthPollIntervalMs);
      };
      setTimeout(poll, this.healthPollIntervalMs);
    });
  }

  /** One bounded restart attempt if a Jack-owned runtime dies later -- see
   * LocalRuntimeManager.watchForCrash()'s identical doc comment. */
  private watchForCrash(child: ChildProcess): void {
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      if (this.restarted) {
        this.status = {
          state: "failed",
          ownedByJack: false,
          detail: `Kokoro TTS exited unexpectedly (code ${code}) and the automatic restart also failed. Restart it manually if needed.`,
        };
        return;
      }
      this.restarted = true;
      this.status = {
        state: "restarting",
        ownedByJack: false,
        detail: "Kokoro TTS exited unexpectedly; attempting one automatic restart.",
      };
      void this.spawnAndWait().then((status) => {
        this.status = status;
      });
    });
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/audio/voices`, { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private port(): string {
    try {
      return new URL(this.baseUrl).port || "80";
    } catch {
      return "8880";
    }
  }

  /** Terminates ONLY a Jack-owned child. Safe to call even if nothing is
   * running -- see LocalRuntimeManager.stop()'s identical doc comment. */
  stop(): void {
    this.stopped = true;
    if (this.child) {
      const child = this.child;
      this.child = null;
      child.kill();
    }
  }
}

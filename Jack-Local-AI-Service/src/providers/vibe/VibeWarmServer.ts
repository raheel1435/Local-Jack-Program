import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Wraps VibeASR.cpp's officially-supported `asr_stream_server.exe` (its own
 * --help banner: "Streaming ASR server - loads models once, processes audio
 * via stdin"). This is a process-lifecycle wrapper around a mechanism the
 * upstream binary already provides -- not a reimplementation of any
 * inference internals. The one-shot `asr_infer.exe` CLI reloads the full
 * VAE+LM GGUF weights on every single call; measured cold-path average is
 * ~2514ms/utterance vs. ~1197ms for a warm request after the first (see
 * VIBEVOICE_BASELINE.md) -- pure reload cost the model only needs to pay
 * once per gateway lifetime, which is exactly what this class buys by
 * keeping one warm child process alive across requests.
 *
 * Protocol, confirmed live by capturing the real binary's stdout and stderr
 * SEPARATELY (a naive `2>&1` merge -- my first attempt -- interleaves them
 * and reads as if everything were one stream, which cost real debugging
 * time chasing a phantom hang): the ENTIRE init banner, every "[Server]
 * Chunk N:", "[audio_io] Loaded:", and "Prompt built:" progress line is
 * written to stderr, not stdout. stdout carries only three things: a single
 * "---READY---" line once at startup, then per request, zero or one
 * transcript content lines followed by a literal "---END---" line. An
 * "[ERROR] ..." line (confirmed to also land on stdout) replaces the
 * transcript line on a per-utterance failure (bad/unreadable audio) without
 * killing the server. This class therefore reads ONLY child.stdout and
 * treats every line arriving between two "---END---" boundaries as that
 * request's response -- no dependency on any stderr-only progress line.
 */
export class VibeWarmServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  private collectedLines: string[] = [];
  private currentResolve: ((transcript: string) => void) | null = null;
  private currentReject: ((err: Error) => void) | null = null;
  private currentTimeout: NodeJS.Timeout | null = null;

  constructor(
    private readonly executablePath: string,
    private readonly vaeModelPath: string,
    private readonly lmModelPath: string,
    private readonly threads: number,
    private readonly context: string | undefined,
    private readonly serverStartTimeoutMs: number,
    private readonly requestTimeoutMs: number
  ) {}

  /** Serializes requests: the child's stdin/stdout is a single shared stream. */
  async transcribe(audioFilePath: string): Promise<string> {
    await this.ensureStarted();
    const run = this.queue.then(() => this.sendOne(audioFilePath));
    // Keep the chain alive regardless of this request's outcome so a single
    // failure doesn't wedge every request queued behind it.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const args = [
        "--vae-model",
        this.vaeModelPath,
        "--lm-model",
        this.lmModelPath,
        "-t",
        String(this.threads),
        "--greedy",
        "--no-token-stream",
      ];
      if (this.context) args.push("--context", this.context);

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.executablePath, args);
      } catch (e) {
        this.ready = null;
        rejectReady(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.child = child;
      this.collectedLines = [];

      const startTimeout = setTimeout(() => {
        child.kill();
      }, this.serverStartTimeoutMs);

      let becameReady = false;
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!becameReady) {
          if (line.trim() === "---READY---") {
            becameReady = true;
            clearTimeout(startTimeout);
            resolveReady();
          }
          return;
        }
        this.handleLine(line);
      });

      // The entire init banner and every per-chunk progress line ("[Server]
      // Chunk N:", "[audio_io] Loaded:", "Prompt built:") land on stderr,
      // confirmed by capturing the two streams separately -- drained here
      // only so an unexpected large write there can never block the child;
      // nothing on this class's parsing depends on stderr content.
      child.stderr.resume();

      // Without this, a write() racing the child's exit (e.g. this class's
      // own timeout-triggered kill(), or the child crashing mid-request)
      // throws an uncaught 'error' event on the stdin Socket and takes down
      // the ENTIRE gateway process -- confirmed live: reproduced exactly
      // this crash before adding this handler. sendOne()'s own `if
      // (!this.child)` guard only protects the *next* call; it can't
      // protect a write already in flight when the pipe breaks.
      child.stdin.on("error", (err) => {
        this.failCurrent(err instanceof Error ? err : new Error(String(err)));
      });

      child.on("exit", (code) => {
        clearTimeout(startTimeout);
        this.child = null;
        this.ready = null;
        const err = new Error(`VibeVoice warm server exited unexpectedly (code ${code})`);
        this.failCurrent(err);
        if (!becameReady) rejectReady(err);
      });

      child.on("error", (err) => {
        clearTimeout(startTimeout);
        this.child = null;
        this.ready = null;
        this.failCurrent(err);
        if (!becameReady) rejectReady(err);
      });
    });
    return this.ready;
  }

  private sendOne(audioFilePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this.child) {
        reject(new Error("VibeVoice warm server is not running"));
        return;
      }
      this.collectedLines = [];
      this.currentResolve = resolve;
      this.currentReject = reject;
      this.currentTimeout = setTimeout(() => {
        this.failCurrent(new Error("VibeVoice warm server request timed out"));
        // A hung request means the child's stdin/stdout framing can no
        // longer be trusted -- kill it so the NEXT request gets a clean
        // respawn (ensureStarted() re-creates `this.ready` once `this.child`
        // is null) rather than silently reading stale output forever.
        this.child?.kill();
      }, this.requestTimeoutMs);
      this.child.stdin.write(audioFilePath + "\n");
    });
  }

  /** Every stdout line between two "---END---" boundaries belongs to the
   * request currently in flight -- zero lines (empty transcript), one
   * transcript line, or one "[ERROR] ..." line. */
  private handleLine(line: string): void {
    if (line === "---END---") {
      const errorLine = this.collectedLines.find((l) => l.startsWith("[ERROR]"));
      const transcript = this.collectedLines.join(" ").trim();
      this.collectedLines = [];
      if (errorLine) {
        this.rejectCurrent(new Error(errorLine));
      } else {
        this.resolveCurrent(transcript);
      }
      return;
    }
    if (line.trim().length > 0) {
      this.collectedLines.push(line);
    }
  }

  private resolveCurrent(transcript: string): void {
    if (this.currentTimeout) clearTimeout(this.currentTimeout);
    this.currentTimeout = null;
    const resolve = this.currentResolve;
    this.currentResolve = null;
    this.currentReject = null;
    resolve?.(transcript);
  }

  private rejectCurrent(err: Error): void {
    if (this.currentTimeout) clearTimeout(this.currentTimeout);
    this.currentTimeout = null;
    const reject = this.currentReject;
    this.currentResolve = null;
    this.currentReject = null;
    reject?.(err);
  }

  private failCurrent(err: Error): void {
    if (this.currentReject) this.rejectCurrent(err);
  }
}

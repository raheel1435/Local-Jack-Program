import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { LocalRuntimeManager } from "./LocalRuntimeManager.ts";

// LocalRuntimeManager's existsSync checks are real filesystem checks (by
// design -- see its own doc comment), so tests that exercise the "launch a
// process" path need executablePath/modelPath that actually exist on disk.
// This file and its sibling LocalRuntimeManager.ts are both real,
// guaranteed-present files -- used purely as stand-ins, never actually run.
const REAL_EXECUTABLE = fileURLToPath(import.meta.url);
const REAL_MODEL = fileURLToPath(new URL("./LocalRuntimeManager.ts", import.meta.url));

/** Minimal fake ChildProcess -- just enough of the EventEmitter surface
 * LocalRuntimeManager actually touches (stderr data, exit, error, kill).
 * Mirrors this codebase's existing precedent (VibeWarmServer.test.ts) of
 * exercising real lifecycle logic against a lightweight fake rather than a
 * real OS process, so tests stay fast and deterministic. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void; killed: boolean };
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return;
    child.killed = true;
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
  };
  return child;
}

function withMockedFetch<T>(impl: (url: string) => Promise<Response> | Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string) => Promise.resolve(impl(String(url)))) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const okResponse = () => new Response("{}", { status: 200 });
const failResponse = () => new Response("", { status: 503 });

test("an already-healthy runtime is reused -- no process is launched", () =>
  withMockedFetch(okResponse, async () => {
    let spawnCalls = 0;
    const manager = new LocalRuntimeManager({
      executablePath: REAL_EXECUTABLE,
      modelPath: REAL_MODEL,
      spawnFn: (() => { spawnCalls += 1; return fakeChild(); }) as any,
    });
    const status = await manager.ensureReady();
    assert.equal(status.state, "ready");
    assert.equal(status.ownedByJack, false);
    assert.equal(spawnCalls, 0);
  }));

test("an absent runtime is launched exactly once, with the configured executable/model/host/port", () => {
  let healthy = false;
  let spawnArgs: { command: string; args: string[] } | null = null;
  return withMockedFetch(
    () => (healthy ? okResponse() : failResponse()),
    async () => {
      const manager = new LocalRuntimeManager({
        baseUrl: "http://127.0.0.1:8081",
        executablePath: REAL_EXECUTABLE,
        modelPath: REAL_MODEL,
        healthPollIntervalMs: 5,
        spawnFn: ((command: string, args: string[]) => {
          spawnArgs = { command, args };
          const child = fakeChild();
          setTimeout(() => { healthy = true; }, 15);
          return child;
        }) as any,
      });
      const status = await manager.ensureReady();
      assert.equal(status.state, "ready");
      assert.equal(status.ownedByJack, true);
      assert.equal(spawnArgs?.command, REAL_EXECUTABLE);
      assert.deepEqual(spawnArgs?.args, ["-m", REAL_MODEL, "--host", "127.0.0.1", "--port", "8081"]);
    },
  );
});

test("concurrent ensureReady() calls while starting up launch only one process", () => {
  let healthy = false;
  let spawnCalls = 0;
  return withMockedFetch(
    () => (healthy ? okResponse() : failResponse()),
    async () => {
      const manager = new LocalRuntimeManager({
        executablePath: REAL_EXECUTABLE,
        modelPath: REAL_MODEL,
        healthPollIntervalMs: 5,
        spawnFn: (() => {
          spawnCalls += 1;
          setTimeout(() => { healthy = true; }, 15);
          return fakeChild();
        }) as any,
      });
      const [a, b, c] = await Promise.all([manager.ensureReady(), manager.ensureReady(), manager.ensureReady()]);
      assert.equal(spawnCalls, 1);
      for (const status of [a, b, c]) assert.equal(status.state, "ready");
    },
  );
});

test("a second ensureReady() call after success reuses health -- still no new process", () => {
  let healthy = false;
  let spawnCalls = 0;
  return withMockedFetch(
    () => (healthy ? okResponse() : failResponse()),
    async () => {
      const manager = new LocalRuntimeManager({
        executablePath: REAL_EXECUTABLE,
        modelPath: REAL_MODEL,
        healthPollIntervalMs: 5,
        spawnFn: (() => {
          spawnCalls += 1;
          setTimeout(() => { healthy = true; }, 15);
          return fakeChild();
        }) as any,
      });
      await manager.ensureReady();
      const second = await manager.ensureReady();
      assert.equal(spawnCalls, 1);
      assert.equal(second.state, "ready");
    },
  );
});

test("a missing executable is a clear configuration error, never a launch attempt", () =>
  withMockedFetch(failResponse, async () => {
    let spawnCalls = 0;
    const manager = new LocalRuntimeManager({
      executablePath: "C:/definitely/not/a/real/llama-server.exe",
      modelPath: "model.gguf",
      spawnFn: (() => { spawnCalls += 1; return fakeChild(); }) as any,
    });
    const status = await manager.ensureReady();
    assert.equal(status.state, "config_error");
    assert.match(status.detail ?? "", /executable was not found/);
    assert.equal(spawnCalls, 0);
  }));

test("a missing model file is a clear configuration error, never a launch attempt", () =>
  withMockedFetch(failResponse, async () => {
    let spawnCalls = 0;
    // REAL_EXECUTABLE is a real, existing file -- used only to prove the
    // executable-exists check passes so the model check is what's actually
    // being exercised.
    const manager = new LocalRuntimeManager({
      executablePath: REAL_EXECUTABLE,
      modelPath: "C:/definitely/not/a/real/model.gguf",
      spawnFn: (() => { spawnCalls += 1; return fakeChild(); }) as any,
    });
    const status = await manager.ensureReady();
    assert.equal(status.state, "config_error");
    assert.match(status.detail ?? "", /model file was not found/);
    assert.equal(spawnCalls, 0);
  }));

test("startup timeout: gateway stays alive, status is a structured failure, and the stuck child is killed", () =>
  withMockedFetch(failResponse, async () => {
    let killed = false;
    const manager = new LocalRuntimeManager({
      executablePath: REAL_EXECUTABLE,
      modelPath: REAL_MODEL,
      startupTimeoutMs: 20,
      healthPollIntervalMs: 5,
      spawnFn: (() => {
        const child = fakeChild();
        const originalKill = child.kill;
        child.kill = () => { killed = true; originalKill(); };
        return child;
      }) as any,
    });
    const status = await manager.ensureReady();
    assert.equal(status.state, "failed");
    assert.match(status.detail ?? "", /did not become ready/);
    assert.equal(killed, true);
  }));

test("a port already in use is reported as its own clear reason, not a raw exit code or stack dump", () =>
  withMockedFetch(failResponse, async () => {
    const manager = new LocalRuntimeManager({
      baseUrl: "http://127.0.0.1:8081",
      executablePath: REAL_EXECUTABLE,
      modelPath: REAL_MODEL,
      healthPollIntervalMs: 5,
      spawnFn: (() => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stderr.emit("data", Buffer.from("bind: Only one usage of each socket address is normally permitted\n"));
          child.emit("exit", 1);
        });
        return child;
      }) as any,
    });
    const status = await manager.ensureReady();
    assert.equal(status.state, "failed");
    assert.match(status.detail ?? "", /port 8081 is already in use/);
  }));

test("stop() never kills an externally started, already-healthy process", () =>
  withMockedFetch(okResponse, async () => {
    let spawnCalls = 0;
    const manager = new LocalRuntimeManager({
      executablePath: "llama-server.exe",
      modelPath: "model.gguf",
      spawnFn: (() => { spawnCalls += 1; return fakeChild(); }) as any,
    });
    await manager.ensureReady();
    manager.stop(); // must be a no-op -- nothing was ever spawned
    assert.equal(spawnCalls, 0);
  }));

test("stop() cleanly kills a Jack-owned process", () => {
  let healthy = false;
  let child: ReturnType<typeof fakeChild>;
  return withMockedFetch(
    () => (healthy ? okResponse() : failResponse()),
    async () => {
      const manager = new LocalRuntimeManager({
        executablePath: REAL_EXECUTABLE,
        modelPath: REAL_MODEL,
        healthPollIntervalMs: 5,
        spawnFn: (() => {
          child = fakeChild();
          setTimeout(() => { healthy = true; }, 15);
          return child;
        }) as any,
      });
      await manager.ensureReady();
      manager.stop();
      assert.equal(child!.killed, true);
    },
  );
});

test("a Jack-owned runtime that crashes later gets exactly one automatic restart attempt, which succeeds", () => {
  let healthy = false;
  let spawnCalls = 0;
  let firstChild: ReturnType<typeof fakeChild>;
  return withMockedFetch(
    () => (healthy ? okResponse() : failResponse()),
    async () => {
      const manager = new LocalRuntimeManager({
        executablePath: REAL_EXECUTABLE,
        modelPath: REAL_MODEL,
        healthPollIntervalMs: 5,
        spawnFn: (() => {
          spawnCalls += 1;
          const child = fakeChild();
          if (spawnCalls === 1) firstChild = child;
          setTimeout(() => { healthy = true; }, 15);
          return child;
        }) as any,
      });
      await manager.ensureReady();
      assert.equal(spawnCalls, 1);

      // Simulate the process dying on its own, well after startup succeeded.
      healthy = false;
      firstChild!.emit("exit", 1);
      // Give the bounded restart (its own spawn + health poll) time to run.
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(spawnCalls, 2);
      assert.equal(manager.getStatus().state, "ready");
    },
  );
});

test("a Jack-owned runtime whose crash-triggered restart also fails ends in a bounded failure, not a loop", () => {
  let spawnCalls = 0;
  let firstChild: ReturnType<typeof fakeChild>;
  let firstHealthy = false;
  return withMockedFetch(
    () => (firstHealthy ? okResponse() : failResponse()),
    async () => {
      const manager = new LocalRuntimeManager({
        executablePath: REAL_EXECUTABLE,
        modelPath: REAL_MODEL,
        startupTimeoutMs: 20,
        healthPollIntervalMs: 5,
        spawnFn: (() => {
          spawnCalls += 1;
          const child = fakeChild();
          if (spawnCalls === 1) {
            firstChild = child;
            setTimeout(() => { firstHealthy = true; }, 10);
          }
          // The restart's own spawn (call #2) never becomes healthy --
          // firstHealthy is flipped back to false before triggering it.
          return child;
        }) as any,
      });
      await manager.ensureReady();
      assert.equal(spawnCalls, 1);

      firstHealthy = false;
      firstChild!.emit("exit", 1);
      // Long enough for the restart attempt's own startupTimeoutMs (20ms) to
      // elapse and resolve to "failed", but not so long a THIRD spawn could
      // plausibly have been mistaken for legitimate.
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(spawnCalls, 2, "exactly one restart attempt -- never a loop");
      assert.equal(manager.getStatus().state, "failed");
    },
  );
});

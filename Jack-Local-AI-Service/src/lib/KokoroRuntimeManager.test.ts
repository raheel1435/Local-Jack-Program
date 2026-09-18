import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { KokoroRuntimeManager } from "./KokoroRuntimeManager.ts";

// KokoroRuntimeManager's existsSync checks are real filesystem checks (same
// design as LocalRuntimeManager) -- REAL_PROJECT_ROOT is this file's own
// directory (guaranteed to exist), used for tests that don't need the
// model-check to pass.
const REAL_PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));

function withMockedFetch<T>(impl: (url: string) => Promise<Response> | Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string) => Promise.resolve(impl(String(url)))) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void; killed: boolean };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return;
    child.killed = true;
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
  };
  return child;
}

const okResponse = () => new Response("{}", { status: 200 });
const failResponse = () => new Response("", { status: 503 });

test("an already-healthy Kokoro is reused -- no process is launched", () =>
  withMockedFetch(okResponse, async () => {
    let spawnCalls = 0;
    const manager = new KokoroRuntimeManager({
      projectRoot: REAL_PROJECT_ROOT,
      spawnFn: (() => { spawnCalls += 1; return fakeChild(); }) as any,
    });
    const status = await manager.ensureReady();
    assert.equal(status.state, "ready");
    assert.equal(status.ownedByJack, false);
    assert.equal(spawnCalls, 0);
  }));

test("a missing project root is a clear configuration error, never a launch attempt", () =>
  withMockedFetch(failResponse, async () => {
    let spawnCalls = 0;
    const manager = new KokoroRuntimeManager({
      projectRoot: "C:/definitely/not/a/real/kokoro/project",
      spawnFn: (() => { spawnCalls += 1; return fakeChild(); }) as any,
    });
    const status = await manager.ensureReady();
    assert.equal(status.state, "config_error");
    assert.match(status.detail ?? "", /project directory was not found/);
    assert.equal(spawnCalls, 0);
  }));

test("a missing model file is a clear configuration error, never a launch attempt", () =>
  withMockedFetch(failResponse, async () => {
    let spawnCalls = 0;
    // REAL_PROJECT_ROOT exists but (correctly) has no api/src/models/v1_0/
    // subtree -- proves the project-root check passes so the model check is
    // what's actually being exercised.
    const manager = new KokoroRuntimeManager({
      projectRoot: REAL_PROJECT_ROOT,
      spawnFn: (() => { spawnCalls += 1; return fakeChild(); }) as any,
    });
    const status = await manager.ensureReady();
    assert.equal(status.state, "config_error");
    assert.match(status.detail ?? "", /model file was not found/);
    assert.equal(spawnCalls, 0);
  }));

/** Builds a real directory layout (in the OS temp dir) with the exact
 * api/src/models/v1_0/kokoro-v1_0.pth AND .venv/Scripts/python.exe (or
 * .venv/bin/python on POSIX) relative paths KokoroRuntimeManager checks
 * for, so "launch" tests can pass both checks without the real model/venv. */
async function withFakeKokoroProjectRoot<T>(fn: (projectRoot: string) => Promise<T>): Promise<T> {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const projectRoot = await mkdtemp(join(tmpdir(), "kokoro-test-"));
  await mkdir(join(projectRoot, "api", "src", "models", "v1_0"), { recursive: true });
  await writeFile(join(projectRoot, "api", "src", "models", "v1_0", "kokoro-v1_0.pth"), "fake");
  const pythonPath = process.platform === "win32"
    ? join(projectRoot, ".venv", "Scripts", "python.exe")
    : join(projectRoot, ".venv", "bin", "python");
  await mkdir(join(pythonPath, ".."), { recursive: true });
  await writeFile(pythonPath, "fake");
  try {
    return await fn(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("a missing virtualenv python is a clear configuration error, never a launch attempt", () =>
  withMockedFetch(failResponse, async () => {
    let spawnCalls = 0;
    // REAL_PROJECT_ROOT has no api/src/models/v1_0/ subtree either, but
    // that check runs first -- use a project root with a real model but no
    // .venv to prove THIS check is what's being exercised.
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const projectRoot = await mkdtemp(join(tmpdir(), "kokoro-test-novenv-"));
    await mkdir(join(projectRoot, "api", "src", "models", "v1_0"), { recursive: true });
    await writeFile(join(projectRoot, "api", "src", "models", "v1_0", "kokoro-v1_0.pth"), "fake");
    try {
      const manager = new KokoroRuntimeManager({
        projectRoot,
        spawnFn: (() => { spawnCalls += 1; return fakeChild(); }) as any,
      });
      const status = await manager.ensureReady();
      assert.equal(status.state, "config_error");
      assert.match(status.detail ?? "", /virtual environment's Python was not found/);
      assert.equal(spawnCalls, 0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }));

test("an absent runtime is launched exactly once, with the venv's python -m uvicorn/cwd/host/port", () =>
  withFakeKokoroProjectRoot((projectRoot) => {
    let healthy = false;
    let spawnCall: { command: string; args: string[]; options: any } | null = null;
    return withMockedFetch(
      () => (healthy ? okResponse() : failResponse()),
      async () => {
        const manager = new KokoroRuntimeManager({
          baseUrl: "http://127.0.0.1:8880",
          projectRoot,
          healthPollIntervalMs: 5,
          spawnFn: ((command: string, args: string[], options: any) => {
            spawnCall = { command, args, options };
            const child = fakeChild();
            setTimeout(() => { healthy = true; }, 15);
            return child;
          }) as any,
        });
        const status = await manager.ensureReady();
        assert.equal(status.state, "ready");
        assert.equal(status.ownedByJack, true);
        // Spawns the venv's own python.exe directly (never a bare "uv"/
        // "uvicorn" command) -- see KokoroRuntimeManager's own doc comment
        // for why: this sidesteps a real Node-on-Windows spawn+cwd bug and
        // an orphaned-process tracking hazard, both confirmed live.
        assert.match(spawnCall?.command ?? "", /python(\.exe)?$/i);
        assert.deepEqual(spawnCall?.args, ["-m", "uvicorn", "api.src.main:app", "--host", "127.0.0.1", "--port", "8880"]);
        assert.equal(spawnCall?.options.cwd, projectRoot);
        assert.equal(spawnCall?.options.env.USE_GPU, "false");
      },
    );
  }));

test("concurrent ensureReady() calls while starting up launch only one process", () =>
  withFakeKokoroProjectRoot((projectRoot) => {
    let healthy = false;
    let spawnCalls = 0;
    return withMockedFetch(
      () => (healthy ? okResponse() : failResponse()),
      async () => {
        const manager = new KokoroRuntimeManager({
          projectRoot,
          healthPollIntervalMs: 5,
          spawnFn: (() => {
            spawnCalls += 1;
            setTimeout(() => { healthy = true; }, 15);
            return fakeChild();
          }) as any,
        });
        const [a, b] = await Promise.all([manager.ensureReady(), manager.ensureReady()]);
        assert.equal(spawnCalls, 1);
        assert.equal(a.state, "ready");
        assert.equal(b.state, "ready");
      },
    );
  }));

test("startup timeout: gateway stays alive, status is a structured failure, and the stuck child is killed", () =>
  withFakeKokoroProjectRoot((projectRoot) =>
    withMockedFetch(failResponse, async () => {
      let killed = false;
      const manager = new KokoroRuntimeManager({
        projectRoot,
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
    }),
  ));

test("a port already in use is reported as its own clear reason, not a raw exit code or stack dump", () =>
  withFakeKokoroProjectRoot((projectRoot) =>
    withMockedFetch(failResponse, async () => {
      const manager = new KokoroRuntimeManager({
        baseUrl: "http://127.0.0.1:8880",
        projectRoot,
        healthPollIntervalMs: 5,
        spawnFn: (() => {
          const child = fakeChild();
          queueMicrotask(() => {
            child.stderr.emit("data", Buffer.from("OSError: [WinError 10048] only one usage of each socket address is normally permitted\n"));
            child.emit("exit", 1);
          });
          return child;
        }) as any,
      });
      const status = await manager.ensureReady();
      assert.equal(status.state, "failed");
      assert.match(status.detail ?? "", /port 8880 is already in use/);
    }),
  ));

test("stop() never kills an externally started, already-healthy process", () =>
  withMockedFetch(okResponse, async () => {
    let spawnCalls = 0;
    const manager = new KokoroRuntimeManager({
      projectRoot: REAL_PROJECT_ROOT,
      spawnFn: (() => { spawnCalls += 1; return fakeChild(); }) as any,
    });
    await manager.ensureReady();
    manager.stop();
    assert.equal(spawnCalls, 0);
  }));

test("stop() cleanly kills a Jack-owned process", () =>
  withFakeKokoroProjectRoot((projectRoot) => {
    let healthy = false;
    let child: ReturnType<typeof fakeChild>;
    return withMockedFetch(
      () => (healthy ? okResponse() : failResponse()),
      async () => {
        const manager = new KokoroRuntimeManager({
          projectRoot,
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
  }));

test("a Jack-owned Kokoro that crashes later gets exactly one automatic restart attempt, which succeeds", () =>
  withFakeKokoroProjectRoot((projectRoot) => {
    let healthy = false;
    let spawnCalls = 0;
    let firstChild: ReturnType<typeof fakeChild>;
    return withMockedFetch(
      () => (healthy ? okResponse() : failResponse()),
      async () => {
        const manager = new KokoroRuntimeManager({
          projectRoot,
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

        healthy = false;
        firstChild!.emit("exit", 1);
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(spawnCalls, 2);
        assert.equal(manager.getStatus().state, "ready");
      },
    );
  }));

test("a Jack-owned Kokoro whose crash-triggered restart also fails ends in a bounded failure, not a loop", () =>
  withFakeKokoroProjectRoot((projectRoot) => {
    let spawnCalls = 0;
    let firstChild: ReturnType<typeof fakeChild>;
    let firstHealthy = false;
    return withMockedFetch(
      () => (firstHealthy ? okResponse() : failResponse()),
      async () => {
        const manager = new KokoroRuntimeManager({
          projectRoot,
          startupTimeoutMs: 20,
          healthPollIntervalMs: 5,
          spawnFn: (() => {
            spawnCalls += 1;
            const child = fakeChild();
            if (spawnCalls === 1) {
              firstChild = child;
              setTimeout(() => { firstHealthy = true; }, 10);
            }
            return child;
          }) as any,
        });
        await manager.ensureReady();
        assert.equal(spawnCalls, 1);

        firstHealthy = false;
        firstChild!.emit("exit", 1);
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(spawnCalls, 2, "exactly one restart attempt -- never a loop");
        assert.equal(manager.getStatus().state, "failed");
      },
    );
  }));

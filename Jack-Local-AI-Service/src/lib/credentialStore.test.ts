import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, type DpapiCipher } from "./credentialStore.ts";

function fakeCipher(): DpapiCipher {
  const store = new Map<string, string>();
  return {
    async protect(plaintext, outFile) {
      store.set(outFile, plaintext);
    },
    async unprotect(inFile) {
      const value = store.get(inFile);
      if (value === undefined) throw new Error(`no ciphertext at ${inFile}`);
      return value;
    },
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jack-credstore-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("set() -> status() round trip reports connected with the correct lastFour", () =>
  withTempDir(async (dir) => {
    const store = new CredentialStore({ baseDir: dir, cipher: fakeCipher() });
    const report = await store.set("openai", "sk-abcd1234");
    assert.equal(report.status, "connected");
    assert.equal(report.lastFour, "1234");

    const status = await store.status("openai");
    assert.equal(status.status, "connected");
    assert.equal(status.lastFour, "1234");
  }));

test("remove() -> status() reports not_configured", () =>
  withTempDir(async (dir) => {
    const store = new CredentialStore({ baseDir: dir, cipher: fakeCipher() });
    await store.set("anthropic", "sk-ant-test");
    await store.remove("anthropic");
    const status = await store.status("anthropic");
    assert.deepEqual(status, { provider: "anthropic", status: "not_configured" });
  }));

test("getDecrypted() returns exactly the stored plaintext", () =>
  withTempDir(async (dir) => {
    const store = new CredentialStore({ baseDir: dir, cipher: fakeCipher() });
    await store.set("openai", "sk-round-trip-me");
    assert.equal(await store.getDecrypted("openai"), "sk-round-trip-me");
  }));

test("a failing verify callback stores status 'invalid' with a detail, and getDecrypted() still returns the raw key -- 'invalid' does not mean 'deleted'", () =>
  withTempDir(async (dir) => {
    const store = new CredentialStore({
      baseDir: dir,
      cipher: fakeCipher(),
      verifiers: { openai: async () => ({ ok: false, detail: "Unauthorized (401)" }) },
    });
    const report = await store.set("openai", "sk-bad-key");
    assert.equal(report.status, "invalid");
    assert.equal(report.detail, "Unauthorized (401)");

    const key = await store.getDecrypted("openai");
    assert.equal(key, "sk-bad-key");
  }));

test("status() for a never-configured provider returns not_configured without touching the cipher", () =>
  withTempDir(async (dir) => {
    const store = new CredentialStore({ baseDir: dir, cipher: fakeCipher() });
    const status = await store.status("anthropic");
    assert.deepEqual(status, { provider: "anthropic", status: "not_configured" });
  }));

test("getDecrypted() returns null (never throws) when no key was ever stored", () =>
  withTempDir(async (dir) => {
    const store = new CredentialStore({ baseDir: dir, cipher: fakeCipher() });
    assert.equal(await store.getDecrypted("openai"), null);
  }));

test("getDecrypted() returns null (never throws, never falls back to env vars) when the cipher itself fails to decrypt", () =>
  withTempDir(async (dir) => {
    const brokenCipher: DpapiCipher = {
      async protect(_plaintext, _outFile) {
        // pretend a file was written, but unprotect will fail -- simulates
        // a ciphertext blob encrypted under a different Windows account.
      },
      async unprotect() {
        throw new Error("DPAPI Unprotect failed: target data unrecognized by the current user");
      },
    };
    const originalEnv = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-should-never-be-used";
    try {
      const store = new CredentialStore({ baseDir: dir, cipher: brokenCipher });
      await store.set("openai", "sk-original");
      const key = await store.getDecrypted("openai");
      assert.equal(key, null, "must not silently fall back to process.env.OPENAI_API_KEY");
    } finally {
      if (originalEnv === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalEnv;
    }
  }));

test("testConnection() re-verifies the already-stored key without requiring re-entry", () =>
  withTempDir(async (dir) => {
    let verifyCallCount = 0;
    const store = new CredentialStore({
      baseDir: dir,
      cipher: fakeCipher(),
      verifiers: {
        openai: async () => {
          verifyCallCount++;
          return verifyCallCount === 1 ? { ok: true } : { ok: false, detail: "now rejected" };
        },
      },
    });
    await store.set("openai", "sk-test");
    assert.equal(verifyCallCount, 1);

    const retest = await store.testConnection("openai");
    assert.equal(verifyCallCount, 2);
    assert.equal(retest.status, "invalid");
    assert.equal(retest.lastFour, "test");
  }));

test("testConnection() on a never-configured provider returns not_configured without calling the verifier", () =>
  withTempDir(async (dir) => {
    let called = false;
    const store = new CredentialStore({
      baseDir: dir,
      cipher: fakeCipher(),
      verifiers: { openai: async () => { called = true; return { ok: true }; } },
    });
    const report = await store.testConnection("openai");
    assert.deepEqual(report, { provider: "openai", status: "not_configured" });
    assert.equal(called, false);
  }));
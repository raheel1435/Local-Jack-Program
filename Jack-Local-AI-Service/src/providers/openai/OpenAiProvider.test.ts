import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiProvider } from "./OpenAiProvider.ts";
import { CredentialAuthError } from "../../lib/providerErrors.ts";
import type { CredentialStore } from "../../lib/credentialStore.ts";

function fakeStore(key: string | null): CredentialStore {
  return { getDecrypted: async () => key } as unknown as CredentialStore;
}

function withMockedFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("checkHealth returns unavailable with no network call when no key is configured", async () => {
  let called = false;
  await withMockedFetch(
    (async () => {
      called = true;
      throw new Error("fetch should never be called when no key is configured");
    }) as typeof fetch,
    async () => {
      const provider = new OpenAiProvider(fakeStore(null), "gpt-4o-mini");
      assert.equal(await provider.checkHealth(), "unavailable");
    },
  );
  assert.equal(called, false);
});

test("checkHealth never throws -- returns unavailable on a non-2xx response", async () => {
  await withMockedFetch(
    (async () => new Response(JSON.stringify({ error: { message: "server error" } }), { status: 500 })) as typeof fetch,
    async () => {
      const provider = new OpenAiProvider(fakeStore("sk-test"), "gpt-4o-mini");
      assert.equal(await provider.checkHealth(), "unavailable");
    },
  );
});

test("chat() extracts choices[0].message.content and reports the served model", async () => {
  await withMockedFetch(
    (async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          model: "gpt-4o-mini-2024-07-18",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello there." } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
    async () => {
      const provider = new OpenAiProvider(fakeStore("sk-test"), "gpt-4o-mini");
      const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
      assert.equal(result.content, "Hello there.");
      assert.equal(result.model, "gpt-4o-mini-2024-07-18");
      assert.equal(typeof result.latencyMs, "number");
    },
  );
});

test("chat() throws CredentialAuthError on a 401 response, not a generic Error", async () => {
  await withMockedFetch(
    (async () =>
      new Response(
        JSON.stringify({ error: { message: "Incorrect API key provided.", type: "invalid_request_error" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
    async () => {
      const provider = new OpenAiProvider(fakeStore("sk-bad"), "gpt-4o-mini");
      await assert.rejects(
        () => provider.chat({ messages: [{ role: "user", content: "hi" }] }),
        (err: unknown) => err instanceof CredentialAuthError && err.providerId === "openai",
      );
    },
  );
});

test("chat() throws CredentialAuthError (never a bare fetch attempt) when no key is configured", async () => {
  let called = false;
  await withMockedFetch(
    (async () => {
      called = true;
      throw new Error("should not be called");
    }) as typeof fetch,
    async () => {
      const provider = new OpenAiProvider(fakeStore(null), "gpt-4o-mini");
      await assert.rejects(
        () => provider.chat({ messages: [{ role: "user", content: "hi" }] }),
        (err: unknown) => err instanceof CredentialAuthError,
      );
    },
  );
  assert.equal(called, false);
});
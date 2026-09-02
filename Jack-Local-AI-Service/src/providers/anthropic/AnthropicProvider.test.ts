import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicProvider } from "./AnthropicProvider.ts";
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

function okResponse(content: { type: string; text?: string }[], model = "claude-haiku-4-5") {
  return new Response(
    JSON.stringify({ id: "msg_1", model, content, stop_reason: "end_turn" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("checkHealth returns unavailable with no network call when no key is configured", async () => {
  let called = false;
  await withMockedFetch(
    (async () => {
      called = true;
      throw new Error("should not be called");
    }) as typeof fetch,
    async () => {
      const provider = new AnthropicProvider(fakeStore(null), "claude-haiku-4-5");
      assert.equal(await provider.checkHealth(), "unavailable");
    },
  );
  assert.equal(called, false);
});

test("checkHealth never throws -- returns unavailable on a non-2xx response", async () => {
  await withMockedFetch(
    (async () => new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 })) as typeof fetch,
    async () => {
      const provider = new AnthropicProvider(fakeStore("sk-ant-test"), "claude-haiku-4-5");
      assert.equal(await provider.checkHealth(), "unavailable");
    },
  );
});

test("a role:'system' message is hoisted to the top-level `system` field and removed from `messages`", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withMockedFetch(
    (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return okResponse([{ type: "text", text: "ok" }]);
    }) as typeof fetch,
    async () => {
      const provider = new AnthropicProvider(fakeStore("sk-ant-test"), "claude-haiku-4-5");
      await provider.chat({
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "Hi" },
        ],
        max_tokens: 100,
      });
    },
  );
  assert.equal(capturedBody?.system, "Be terse.");
  assert.deepEqual(capturedBody?.messages, [{ role: "user", content: "Hi" }]);
});

test("max_tokens defaults from config when the caller didn't send one (Anthropic requires it, JackChatRequest doesn't)", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withMockedFetch(
    (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return okResponse([{ type: "text", text: "ok" }]);
    }) as typeof fetch,
    async () => {
      const provider = new AnthropicProvider(fakeStore("sk-ant-test"), "claude-haiku-4-5");
      await provider.chat({ messages: [{ role: "user", content: "Hi" }] });
    },
  );
  assert.equal(capturedBody?.max_tokens, 1024);
});

test("response content (array of text blocks) is joined into a single string", async () => {
  await withMockedFetch(
    (async () => okResponse([{ type: "text", text: "Hello, " }, { type: "text", text: "world." }])) as typeof fetch,
    async () => {
      const provider = new AnthropicProvider(fakeStore("sk-ant-test"), "claude-haiku-4-5");
      const result = await provider.chat({ messages: [{ role: "user", content: "hi" }], max_tokens: 50 });
      assert.equal(result.content, "Hello, world.");
    },
  );
});

test("chat() throws CredentialAuthError on a 401 response, not a generic Error", async () => {
  await withMockedFetch(
    (async () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
    async () => {
      const provider = new AnthropicProvider(fakeStore("sk-ant-bad"), "claude-haiku-4-5");
      await assert.rejects(
        () => provider.chat({ messages: [{ role: "user", content: "hi" }], max_tokens: 50 }),
        (err: unknown) => err instanceof CredentialAuthError && err.providerId === "anthropic",
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
      const provider = new AnthropicProvider(fakeStore(null), "claude-haiku-4-5");
      await assert.rejects(
        () => provider.chat({ messages: [{ role: "user", content: "hi" }] }),
        (err: unknown) => err instanceof CredentialAuthError,
      );
    },
  );
  assert.equal(called, false);
});
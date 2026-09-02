import assert from "node:assert/strict";
import test from "node:test";
import { jackApi } from "../app/lib/jackApi.ts";

// Regression coverage for CLAUDE-04: jackApi.health() used to fabricate
// `gateway: "ok"` on ANY failure (network error, timeout, non-2xx, bad
// JSON) -- structurally indistinguishable from a genuinely healthy gateway
// whose providers all happen to be down, since "ok" was the type's only
// permitted value. Fixed to report "unreachable" instead.

test("health() reports gateway: \"ok\" and passes through the real response on success", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ gateway: "ok", colibri: "unavailable", llamacpp: "available", whisper: "available", vibevoice: "available", kokoro: "available", activeLlmProvider: "llamacpp" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const health = await jackApi.health();
  assert.equal(health.gateway, "ok");
  assert.equal(health.llamacpp, "available");
});

test("health() reports gateway: \"unreachable\" (never a fabricated \"ok\") when the fetch itself throws", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const health = await jackApi.health();
  assert.equal(health.gateway, "unreachable");
  assert.equal(health.llamacpp, "unavailable");
  assert.equal(health.whisper, "unavailable");
});

test("health() reports gateway: \"unreachable\" on a non-2xx response, not \"ok\"", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });

  const health = await jackApi.health();
  assert.equal(health.gateway, "unreachable");
});

// Multi-provider AI milestone: the synthetic offline-fallback literal must
// include openai/anthropic like every other provider field, or a caller
// reading health.openai on a genuinely unreachable gateway would see
// `undefined` instead of the honest "unavailable".
test("health()'s offline synthetic fallback reports openai/anthropic as unavailable too", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const health = await jackApi.health();
  assert.equal(health.openai, "unavailable");
  assert.equal(health.anthropic, "unavailable");
});

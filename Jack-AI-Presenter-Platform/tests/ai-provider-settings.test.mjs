import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAiProviderId, AI_PROVIDER_OPTIONS, DEFAULT_AI_PROVIDER_ID } from "../app/jack/aiProviderSettings.ts";
import { jackApi } from "../app/lib/jackApi.ts";

test("normalizeAiProviderId accepts every real option id", () => {
  for (const option of AI_PROVIDER_OPTIONS) {
    assert.equal(normalizeAiProviderId(option.id), option.id);
  }
});

test("normalizeAiProviderId safely defaults to local for garbage/removed values", () => {
  assert.equal(normalizeAiProviderId("bogus"), DEFAULT_AI_PROVIDER_ID);
  assert.equal(normalizeAiProviderId(undefined), DEFAULT_AI_PROVIDER_ID);
  assert.equal(normalizeAiProviderId(null), DEFAULT_AI_PROVIDER_ID);
  assert.equal(normalizeAiProviderId(42), DEFAULT_AI_PROVIDER_ID);
});

function withMockedFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("saveCredential sends the key in the request body and never reads it back from the response", () =>
  withMockedFetch(
    async (url, init) => {
      assert.ok(String(url).endsWith("/jack/credentials/openai"));
      const body = JSON.parse(init.body);
      assert.equal(body.apiKey, "sk-test-key-12345");
      return new Response(
        JSON.stringify({ provider: "openai", status: "connected", lastFour: "2345", updatedAt: "2026-01-01T00:00:00.000Z" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    async () => {
      const report = await jackApi.saveCredential("openai", "sk-test-key-12345");
      assert.equal(report.status, "connected");
      assert.equal(report.lastFour, "2345");
      // The report object structurally cannot carry the full key -- there is
      // no field on CredentialStatusReport that could hold it.
      assert.equal("apiKey" in report, false);
    },
  ));

test("getCredentialStatus returns both providers' reports", () =>
  withMockedFetch(
    async () =>
      new Response(
        JSON.stringify({
          openai: { provider: "openai", status: "not_configured" },
          anthropic: { provider: "anthropic", status: "connected", lastFour: "9999" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const result = await jackApi.getCredentialStatus();
      assert.equal(result.openai.status, "not_configured");
      assert.equal(result.anthropic.status, "connected");
    },
  ));

test("removeCredential issues a DELETE and returns not_configured", () =>
  withMockedFetch(
    async (url, init) => {
      assert.equal(init?.method, "DELETE");
      assert.ok(String(url).endsWith("/jack/credentials/anthropic"));
      return new Response(JSON.stringify({ provider: "anthropic", status: "not_configured" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      const report = await jackApi.removeCredential("anthropic");
      assert.equal(report.status, "not_configured");
    },
  ));

test("testCredential POSTs to the /test endpoint with no body required", () =>
  withMockedFetch(
    async (url, init) => {
      assert.equal(init?.method, "POST");
      assert.ok(String(url).endsWith("/jack/credentials/openai/test"));
      return new Response(JSON.stringify({ provider: "openai", status: "connected", lastFour: "abcd" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      const report = await jackApi.testCredential("openai");
      assert.equal(report.status, "connected");
    },
  ));
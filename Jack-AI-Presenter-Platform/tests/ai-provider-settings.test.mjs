import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAiProviderId, AI_PROVIDER_OPTIONS, DEFAULT_AI_PROVIDER_ID } from "../app/jack/aiProviderSettings.ts";
import { jackApi, setProviderFallbackConsentHandler, setProviderRequestStatusHandler } from "../app/lib/jackApi.ts";
import { activeBrainStatus } from "../app/jack/brainStatus.ts";

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

test("active brain status follows only the selected provider", () => {
  const health = {
    gateway: "ok", colibri: "available", llamacpp: "unavailable",
    whisper: "available", vibevoice: "unavailable", kokoro: "available",
    openai: "available", anthropic: "unavailable", activeLlmProvider: "colibri",
  };

  assert.deepEqual(activeBrainStatus("local", health), {
    label: "Local AI", readiness: "connected", text: "Local AI: Brain ready",
  });
  assert.deepEqual(activeBrainStatus("openai", health), {
    label: "OpenAI", readiness: "connected", text: "OpenAI: Brain ready",
  });
  assert.deepEqual(activeBrainStatus("anthropic", health), {
    label: "Anthropic", readiness: "offline", text: "Anthropic: Brain offline",
  });
  assert.notEqual(activeBrainStatus("openai", health).text, "Local AI: Brain ready");
  assert.deepEqual(activeBrainStatus("openai", null), {
    label: "OpenAI", readiness: "checking", text: "OpenAI: Checking brain…",
  });
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

test("OpenAI failure never invokes Local before consent; approval retries Local once", async () => {
  const providers = [];
  let prompt;
  let observed;
  setProviderFallbackConsentHandler(async (request) => { prompt = request; return "local"; });
  setProviderRequestStatusHandler((status) => { observed = status; });
  await withMockedFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    providers.push(body.aiProvider);
    if (providers.length === 1) {
      assert.deepEqual(providers, ["openai"], "Local must not run before consent");
      return new Response(JSON.stringify({ detail: "OpenAI unavailable", provider: "openai", fallbackOptions: ["local"], requiresConsent: true }), { status: 502 });
    }
    return new Response(JSON.stringify({ content: "local answer", model: "local", latencyMs: 1, actualProvider: "local" }), { status: 200 });
  }, async () => {
    const result = await jackApi.chat([{ role: "user", content: "hello" }], { aiProvider: "openai" });
    assert.equal(result.content, "local answer");
  });
  assert.deepEqual(providers, ["openai", "local"]);
  assert.equal(prompt.failedProvider, "openai");
  assert.equal(observed.selectedProvider, "openai");
  assert.equal(observed.actualProvider, "local");
  assert.equal(observed.fallbackUsed, true);
  setProviderFallbackConsentHandler(null);
  setProviderRequestStatusHandler(null);
});

test("canceling cloud-to-Local consent makes no Local request", async () => {
  let calls = 0;
  setProviderFallbackConsentHandler(async () => null);
  await assert.rejects(withMockedFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify({ detail: "Anthropic unavailable", provider: "anthropic", fallbackOptions: ["local"], requiresConsent: true }), { status: 502 });
  }, () => jackApi.chat([{ role: "user", content: "hello" }], { aiProvider: "anthropic" })));
  assert.equal(calls, 1);
  setProviderFallbackConsentHandler(null);
});

test("Anthropic failure can retry Local exactly once after approval", async () => {
  const providers = [];
  setProviderFallbackConsentHandler(async () => "local");
  await withMockedFetch(async (_url, init) => {
    const selected = JSON.parse(init.body).aiProvider;
    providers.push(selected);
    return providers.length === 1
      ? new Response(JSON.stringify({ detail: "Anthropic unavailable", provider: "anthropic", fallbackOptions: ["local"], requiresConsent: true }), { status: 502 })
      : new Response(JSON.stringify({ content: "local", model: "local", latencyMs: 1, actualProvider: "local" }), { status: 200 });
  }, () => jackApi.chat([{ role: "user", content: "hello" }], { aiProvider: "anthropic" }));
  assert.deepEqual(providers, ["anthropic", "local"]);
  setProviderFallbackConsentHandler(null);
});

test("Whisper failure offers OpenAI Speech and retries it exactly once only after consent", async () => {
  const urls = [];
  setProviderFallbackConsentHandler(async (request) => {
    assert.equal(request.kind, "asr");
    assert.deepEqual(request.options, ["openai"]);
    assert.equal(urls.length, 1, "OpenAI Speech must not run before consent");
    return "openai";
  });
  await withMockedFetch(async (url) => {
    urls.push(String(url));
    if (urls.length === 1) return new Response(JSON.stringify({ detail: "Whisper unavailable", provider: "whisper", fallbackOptions: ["openai"], requiresConsent: true }), { status: 503 });
    return new Response(JSON.stringify({ text: "hello", provider: "openai", actualProvider: "openai", latencyMs: 1 }), { status: 200 });
  }, async () => {
    const result = await jackApi.transcribeAudio(new Blob(["wav"]), undefined, "whisper");
    assert.equal(result.provider, "openai");
  });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /provider=openai/);
  setProviderFallbackConsentHandler(null);
});

test("OpenAI Speech failure offers Whisper; approval invokes Whisper once", async () => {
  const urls = [];
  setProviderFallbackConsentHandler(async (request) => {
    assert.deepEqual(request.options, ["whisper"]);
    assert.equal(urls.length, 1, "Whisper must not run before consent");
    return "whisper";
  });
  await withMockedFetch(async (url) => {
    urls.push(String(url));
    if (urls.length === 1) return new Response(JSON.stringify({ detail: "OpenAI Speech unavailable", provider: "openai", fallbackOptions: ["whisper"], requiresConsent: true }), { status: 502 });
    return new Response(JSON.stringify({ text: "hello", provider: "whisper", actualProvider: "whisper", latencyMs: 1 }), { status: 200 });
  }, () => jackApi.transcribeAudio(new Blob(["wav"]), undefined, "openai"));
  assert.equal(urls.length, 2);
  assert.match(urls[1], /provider=whisper/);
  setProviderFallbackConsentHandler(null);
});

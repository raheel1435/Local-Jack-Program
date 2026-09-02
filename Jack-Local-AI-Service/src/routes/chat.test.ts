import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { chatRouter, type LlmProviderRegistry } from "./chat.ts";
import { AdmissionGate } from "../lib/admission.ts";
import { CredentialAuthError } from "../lib/providerErrors.ts";
import type { AiBrainSelector, JackChatRequest, LlmProvider } from "../types/jack.ts";

function fakeProvider(status: "available" | "unavailable", captured: JackChatRequest[], fail?: Error): LlmProvider {
  return {
    checkHealth: async () => status,
    chat: async (value) => {
      captured.push(value);
      if (fail) throw fail;
      return { content: "ok", model: "local", latencyMs: 1, raw: null };
    },
  };
}

async function withServer(
  registry: LlmProviderRegistry,
  fn: (baseUrl: string) => Promise<void>,
  gates?: Partial<Record<AiBrainSelector, AdmissionGate>>,
) {
  const app = express();
  app.use(express.json());
  app.use(chatRouter(registry, gates));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/jack/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("public chat rejects role, prompt, tuning, model, and grammar violations", async () => {
  const captured: JackChatRequest[] = [];
  const registry: LlmProviderRegistry = {
    local: fakeProvider("available", captured),
    openai: fakeProvider("available", captured),
    anthropic: fakeProvider("available", captured),
  };
  await withServer(registry, async (base) => {
    const badBodies = [
      { messages: [{ role: "tool", content: "x" }] },
      { messages: [{ role: "user", content: "x" }], max_tokens: 0 },
      { messages: [{ role: "user", content: "x" }], temperature: 3 },
      { messages: [{ role: "user", content: "x" }], model: "override" },
      { messages: [{ role: "user", content: "x" }], grammar: "root ::= .*" },
      { messages: [{ role: "user", content: "x".repeat(32_769) }] },
    ];
    for (const body of badBodies) assert.equal((await post(base, body)).status, 400);
  });
});

test("public chat forwards only validated fields", async () => {
  const captured: JackChatRequest[] = [];
  const registry: LlmProviderRegistry = {
    local: fakeProvider("available", captured),
    openai: fakeProvider("available", []),
    anthropic: fakeProvider("available", []),
  };
  await withServer(registry, async (base) => {
    const response = await post(base, {
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 200,
      temperature: 0.4,
      ignored: "not forwarded",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(captured, [{ messages: [{ role: "user", content: "hello" }], max_tokens: 200, temperature: 0.4 }]);
  });
});

test("aiProvider omitted routes to local -- today's exact default behavior, not a fallback", async () => {
  const localCaptured: JackChatRequest[] = [];
  const registry: LlmProviderRegistry = {
    local: fakeProvider("available", localCaptured),
    openai: fakeProvider("available", []),
    anthropic: fakeProvider("available", []),
  };
  await withServer(registry, async (base) => {
    const res = await post(base, { messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    assert.equal(localCaptured.length, 1);
  });
});

test('aiProvider: "openai" routes to the openai provider, not local', async () => {
  const localCaptured: JackChatRequest[] = [];
  const openaiCaptured: JackChatRequest[] = [];
  const registry: LlmProviderRegistry = {
    local: fakeProvider("available", localCaptured),
    openai: fakeProvider("available", openaiCaptured),
    anthropic: fakeProvider("available", []),
  };
  await withServer(registry, async (base) => {
    const res = await post(base, { messages: [{ role: "user", content: "hi" }], aiProvider: "openai" });
    assert.equal(res.status, 200);
    assert.equal(localCaptured.length, 0);
    assert.equal(openaiCaptured.length, 1);
  });
});

test('aiProvider: "anthropic" routes to the anthropic provider', async () => {
  const anthropicCaptured: JackChatRequest[] = [];
  const registry: LlmProviderRegistry = {
    local: fakeProvider("available", []),
    openai: fakeProvider("available", []),
    anthropic: fakeProvider("available", anthropicCaptured),
  };
  await withServer(registry, async (base) => {
    const res = await post(base, { messages: [{ role: "user", content: "hi" }], aiProvider: "anthropic" });
    assert.equal(res.status, 200);
    assert.equal(anthropicCaptured.length, 1);
  });
});

test('an unrecognized aiProvider value is a 400, never silently defaulted to local', async () => {
  const localCaptured: JackChatRequest[] = [];
  const registry: LlmProviderRegistry = {
    local: fakeProvider("available", localCaptured),
    openai: fakeProvider("available", []),
    anthropic: fakeProvider("available", []),
  };
  await withServer(registry, async (base) => {
    const res = await post(base, { messages: [{ role: "user", content: "hi" }], aiProvider: "bogus" });
    assert.equal(res.status, 400);
    assert.equal(localCaptured.length, 0, "must not silently fall back to local on an invalid selector");
  });
});

test("unavailable cloud provider with no key configured returns a provider-specific 503, no substitution", async () => {
  const localCaptured: JackChatRequest[] = [];
  const registry: LlmProviderRegistry = {
    local: fakeProvider("available", localCaptured),
    openai: fakeProvider("unavailable", []),
    anthropic: fakeProvider("available", []),
  };
  await withServer(registry, async (base) => {
    const res = await post(base, { messages: [{ role: "user", content: "hi" }], aiProvider: "openai" });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, "openai_unavailable");
    assert.equal(localCaptured.length, 0, "must not silently retry against local");
  });
});

test("a CredentialAuthError from the provider surfaces as 401 <provider>_unauthorized, not a generic 502", async () => {
  const registry: LlmProviderRegistry = {
    local: fakeProvider("available", []),
    openai: fakeProvider("available", [], new CredentialAuthError("openai", "bad key")),
    anthropic: fakeProvider("available", []),
  };
  await withServer(registry, async (base) => {
    const res = await post(base, { messages: [{ role: "user", content: "hi" }], aiProvider: "openai" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "openai_unauthorized");
  });
});

test("a full cloud AdmissionGate returns 429, never silently routed to local", async () => {
  const localCaptured: JackChatRequest[] = [];
  const registry: LlmProviderRegistry = {
    local: fakeProvider("available", localCaptured),
    openai: fakeProvider("available", []),
    anthropic: fakeProvider("available", []),
  };
  const fullGate = new AdmissionGate(1, 0);
  const release = fullGate.tryAcquire();
  assert.ok(release);
  await withServer(
    registry,
    async (base) => {
      const res = await post(base, { messages: [{ role: "user", content: "hi" }], aiProvider: "openai" });
      assert.equal(res.status, 429);
      assert.equal(localCaptured.length, 0);
    },
    { openai: fullGate },
  );
  release();
});
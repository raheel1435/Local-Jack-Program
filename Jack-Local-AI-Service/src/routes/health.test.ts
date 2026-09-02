import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { healthRouter } from "./health.ts";
import { ColibriProvider } from "../providers/colibri/ColibriProvider.ts";
import { LlamaCppProvider } from "../providers/llamacpp/LlamaCppProvider.ts";
import { WhisperProvider } from "../providers/whisper/WhisperProvider.ts";
import { KokoroProvider } from "../providers/kokoro/KokoroProvider.ts";
import type { AsrProvider, LlmProvider, ProviderStatus } from "../types/jack.ts";

// Every real local provider's checkHealth() is designed to never throw and
// to report "unavailable" on any unreachable/unconfigured backend (see each
// provider's own doc comment) -- constructing them with their real default
// config in a test environment where nothing is actually running exercises
// exactly that fail-safe path, not a fake.
function fakeAsrProvider(status: ProviderStatus): AsrProvider {
  return {
    id: "vibevoice",
    name: "Test · VibeVoice",
    checkHealth: async () => status,
    transcribe: async () => {
      throw new Error("not used in this test");
    },
  };
}

function fakeLlmProvider(status: ProviderStatus): LlmProvider {
  return {
    checkHealth: async () => status,
    chat: async () => {
      throw new Error("not used in this test");
    },
  };
}

async function withServer(
  openai: LlmProvider,
  anthropic: LlmProvider,
  fn: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(
    healthRouter(
      new ColibriProvider(),
      new LlamaCppProvider(),
      new WhisperProvider(),
      new KokoroProvider(),
      fakeAsrProvider("unavailable"),
      openai,
      anthropic,
    ),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET /health reports openai/anthropic as unavailable when neither has a key configured", async () => {
  await withServer(fakeLlmProvider("unavailable"), fakeLlmProvider("unavailable"), async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.gateway, "ok");
    assert.equal(body.openai, "unavailable");
    assert.equal(body.anthropic, "unavailable");
  });
});

test("GET /health reports each BYOK provider's own status independently -- one being available doesn't affect the other", async () => {
  await withServer(fakeLlmProvider("available"), fakeLlmProvider("unavailable"), async (base) => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    assert.equal(body.openai, "available");
    assert.equal(body.anthropic, "unavailable");
  });
});

test("GET /health includes the existing local-provider fields unchanged (whisper/vibevoice/colibri/llamacpp/kokoro/activeLlmProvider)", async () => {
  await withServer(fakeLlmProvider("unavailable"), fakeLlmProvider("unavailable"), async (base) => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    for (const key of ["colibri", "llamacpp", "whisper", "vibevoice", "kokoro", "activeLlmProvider"]) {
      assert.ok(key in body, `expected "${key}" to still be present in the health report`);
    }
  });
});
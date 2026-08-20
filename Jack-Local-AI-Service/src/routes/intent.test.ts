import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { intentRouter } from "./intent.ts";
import type { JackChatRequest, JackChatResponse, LlmProvider, ProviderStatus } from "../types/jack.ts";

// Coverage for the latency-fix milestone's Part 4 requirement: deterministic
// commands (next/previous/pause/continue/stop/take over/"I'll take it from
// here", ...) must never wait on the LLM. matchDeterministicCommand's own
// pattern coverage is already tested directly in commandRouter.test.ts; this
// file proves the ROUTE actually short-circuits before ever calling the LLM
// provider for those phrases, using a fake LlmProvider that records whether
// chat() was invoked at all.

class RecordingLlmProvider implements LlmProvider {
  chatCallCount = 0;

  async checkHealth(): Promise<ProviderStatus> {
    return "available";
  }

  async chat(_req: JackChatRequest): Promise<JackChatResponse> {
    this.chatCallCount++;
    return { content: '{"type":"unknown"}', model: "fake", latencyMs: 1, raw: null };
  }
}

async function withServer(llm: LlmProvider, fn: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use(intentRouter(llm));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("deterministic commands (next/previous/pause/continue/stop/take over/handoff) never call the LLM", async () => {
  const llm = new RecordingLlmProvider();
  const phrases = [
    "Next.",
    "Previous.",
    "Pause.",
    "Continue.",
    "Stop.",
    "Jack, take over.",
    "I'll take it from here.",
  ];
  await withServer(llm, async (base) => {
    for (const text of phrases) {
      const res = await fetch(`${base}/jack/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      assert.equal(res.status, 200, `expected 200 for "${text}"`);
      const body = await res.json();
      assert.equal(body.source, "deterministic", `expected a deterministic match for "${text}"`);
    }
    assert.equal(llm.chatCallCount, 0, "the LLM must never be called for phrases matchDeterministicCommand already resolves");
  });
});

test("a genuinely ambiguous phrase (no deterministic match) DOES fall through to the LLM", async () => {
  const llm = new RecordingLlmProvider();
  await withServer(llm, async (base) => {
    const res = await fetch(`${base}/jack/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "What does the pricing slide say about the enterprise tier?" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, "llm");
    assert.equal(llm.chatCallCount, 1);
  });
});

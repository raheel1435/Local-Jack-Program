import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { chatRouter } from "./chat.ts";
import type { JackChatRequest, LlmProvider } from "../types/jack.ts";

async function request(body: unknown, captured: JackChatRequest[]): Promise<Response> {
  const provider: LlmProvider = {
    checkHealth: async () => "available",
    chat: async (value) => {
      captured.push(value);
      return { content: "ok", model: "local", latencyMs: 1, raw: null };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(chatRouter(provider));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}/jack/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("public chat rejects role, prompt, tuning, model, and grammar violations", async () => {
  const badBodies = [
    { messages: [{ role: "tool", content: "x" }] },
    { messages: [{ role: "user", content: "x" }], max_tokens: 0 },
    { messages: [{ role: "user", content: "x" }], temperature: 3 },
    { messages: [{ role: "user", content: "x" }], model: "override" },
    { messages: [{ role: "user", content: "x" }], grammar: "root ::= .*" },
    { messages: [{ role: "user", content: "x".repeat(32_769) }] },
  ];
  for (const body of badBodies) assert.equal((await request(body, [])).status, 400);
});

test("public chat forwards only validated fields", async () => {
  const captured: JackChatRequest[] = [];
  const response = await request({
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 200,
    temperature: 0.4,
    ignored: "not forwarded",
  }, captured);
  assert.equal(response.status, 200);
  assert.deepEqual(captured, [{ messages: [{ role: "user", content: "hello" }], max_tokens: 200, temperature: 0.4 }]);
});

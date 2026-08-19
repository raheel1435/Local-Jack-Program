import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { transcriptionRouter } from "./transcription.ts";
import type { AsrProvider, JackTranscribeResponse, ProviderStatus } from "../types/jack.ts";

// Coverage for the dual-ASR provider selector (Phase 13-15 of the dual-ASR
// milestone): provider validation, per-engine selection, the "no silent
// fallback" guarantee, and the normalized response shape. Uses fake
// AsrProvider implementations (no real whisper.cpp/VibeASR.cpp binaries) so
// this runs fast and deterministically in CI.

class FakeAsrProvider implements AsrProvider {
  calls: string[] = [];
  id: "whisper" | "vibevoice";
  name: string;
  private health: ProviderStatus;
  private result?: Partial<JackTranscribeResponse>;

  constructor(id: "whisper" | "vibevoice", name: string, health: ProviderStatus, result?: Partial<JackTranscribeResponse>) {
    this.id = id;
    this.name = name;
    this.health = health;
    this.result = result;
  }

  async checkHealth(): Promise<ProviderStatus> {
    return this.health;
  }

  async transcribe(audioFilePath: string): Promise<JackTranscribeResponse> {
    this.calls.push(audioFilePath);
    return {
      text: "hello from " + this.id,
      provider: this.id,
      latencyMs: 42,
      ...this.result,
    };
  }
}

async function withServer(
  whisper: AsrProvider,
  vibevoice: AsrProvider,
  fn: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use(express.raw({ type: ["audio/wav"], limit: "25mb" }));
  app.use(transcriptionRouter(whisper as never, vibevoice));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("defaults to whisper when no provider is specified (JSON path)", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioFilePath: "C:/fake.wav" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, "whisper");
    assert.equal(whisper.calls.length, 1);
    assert.equal(vibevoice.calls.length, 0);
  });
});

test("routes to vibevoice when explicitly selected (JSON path)", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioFilePath: "C:/fake.wav", provider: "vibevoice" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, "vibevoice");
    assert.equal(whisper.calls.length, 0);
    assert.equal(vibevoice.calls.length, 1);
  });
});

test("unknown provider value is rejected with 400, neither engine is invoked", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioFilePath: "C:/fake.wav", provider: "gpt4o-transcribe" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_request");
    assert.equal(whisper.calls.length, 0);
    assert.equal(vibevoice.calls.length, 0);
  });
});

test("vibevoice unavailable returns a structured 503 and never falls back to whisper", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "unavailable");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioFilePath: "C:/fake.wav", provider: "vibevoice" }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, "vibevoice_unavailable");
    // The critical guarantee: an unavailable Test engine must NOT silently
    // route the request to Whisper.
    assert.equal(whisper.calls.length, 0);
    assert.equal(vibevoice.calls.length, 0);
  });
});

test("whisper unavailable returns a structured 503 and never falls back to vibevoice", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "unavailable");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioFilePath: "C:/fake.wav" }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, "whisper_unavailable");
    assert.equal(vibevoice.calls.length, 0);
  });
});

test("audio/wav upload path: provider selected via query string, normalized shape returned", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available", { language: "sv", confidence: 0.9 });
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe?provider=vibevoice`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["confidence", "language", "latencyMs", "provider", "text"].sort());
    assert.equal(body.provider, "vibevoice");
    assert.equal(body.language, "sv");
    // The gateway writes the upload to its own temp path -- the browser
    // never supplies a filesystem path.
    assert.equal(vibevoice.calls.length, 1);
    assert.match(vibevoice.calls[0], /jack-transcribe-.*\.wav$/);
  });
});

test("unknown provider on the upload path is also rejected with 400 before any temp file is written", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe?provider=nonsense`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(res.status, 400);
    assert.equal(whisper.calls.length, 0);
    assert.equal(vibevoice.calls.length, 0);
  });
});

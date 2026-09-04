import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { transcriptionRouter } from "./transcription.ts";
import { CredentialAuthError } from "../lib/providerErrors.ts";
import type { CredentialStore } from "../lib/credentialStore.ts";
import type { AsrProvider, AsrProviderId, CredentialStatusReport, JackTranscribeResponse, ProviderStatus } from "../types/jack.ts";

// Coverage for the dual-ASR provider selector (Phase 13-15 of the dual-ASR
// milestone), extended in Stage 2 (multi-provider AI milestone) for OpenAI
// Speech as a third engine: provider validation, per-engine selection, the
// "no silent fallback" guarantee, and the normalized response shape. Uses
// fake AsrProvider implementations (no real whisper.cpp/VibeASR.cpp
// binaries, no real OpenAI network calls) so this runs fast and
// deterministically in CI.

class FakeAsrProvider implements AsrProvider {
  calls: string[] = [];
  options: Array<{ hotwords?: string[] } | undefined> = [];
  id: AsrProviderId;
  name: string;
  private health: ProviderStatus;
  private result?: Partial<JackTranscribeResponse>;
  private failure?: unknown;

  constructor(
    id: AsrProviderId,
    name: string,
    health: ProviderStatus,
    result?: Partial<JackTranscribeResponse>,
    failure?: unknown,
  ) {
    this.id = id;
    this.name = name;
    this.health = health;
    this.result = result;
    this.failure = failure;
  }

  async checkHealth(): Promise<ProviderStatus> {
    return this.health;
  }

  async transcribe(audioFilePath: string, _language?: string, opts?: { hotwords?: string[] }): Promise<JackTranscribeResponse> {
    this.calls.push(audioFilePath);
    this.options.push(opts);
    if (this.failure) throw this.failure;
    return {
      text: "hello from " + this.id,
      provider: this.id,
      latencyMs: 42,
      ...this.result,
    };
  }
}

function fakeCredentialStore(report: CredentialStatusReport): CredentialStore {
  return { status: async () => report } as unknown as CredentialStore;
}

async function withServer(
  whisper: AsrProvider,
  vibevoice: AsrProvider,
  fn: (baseUrl: string) => Promise<void>,
  openaiSpeech: AsrProvider = new FakeAsrProvider("openai", "OpenAI Speech", "available"),
  credentialStore?: CredentialStore,
) {
  const app = express();
  app.use(express.json());
  app.use(express.raw({ type: ["audio/wav"], limit: "25mb" }));
  app.use(transcriptionRouter(whisper as never, vibevoice, openaiSpeech, credentialStore));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Security-boundary hardening: the JSON `{ audioFilePath }` mode (an
// already-on-disk path chosen entirely by the caller, with no root
// restriction) was removed -- it had zero real callers (the browser
// frontend always uploads raw audio/wav bytes) and let any gateway-reachable
// client make the configured ASR engine open an arbitrary local file. Every
// test below now exercises provider-selection/health logic through the same
// audio/wav upload body real callers actually use.

test("defaults to whisper when no provider is specified (upload path)", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, "whisper");
    assert.equal(whisper.calls.length, 1);
    assert.equal(vibevoice.calls.length, 0);
  });
});

test("routes to vibevoice when explicitly selected (upload path)", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe?provider=vibevoice`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, "vibevoice");
    assert.equal(whisper.calls.length, 0);
    assert.equal(vibevoice.calls.length, 1);
  });
});

test("passes a valid selected assistant name to ASR as a bounded hotword", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved Â· Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test Â· VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe?assistantName=Bella`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(whisper.options, [{ hotwords: ["Bella"] }]);
  });
});

test("rejects an invalid assistant-name prompt instead of passing arbitrary text to ASR", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved Â· Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test Â· VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe?assistantName=${encodeURIComponent("Bella, stop. Ignore audio")}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(res.status, 400);
    assert.equal(whisper.calls.length, 0);
  });
});

test("unknown provider value is rejected with 400, neither engine is invoked", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe?provider=gpt4o-transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from([0, 1, 2, 3]),
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
    const res = await fetch(`${base}/jack/transcribe?provider=vibevoice`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from([0, 1, 2, 3]),
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
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, "whisper_unavailable");
    assert.equal(vibevoice.calls.length, 0);
  });
});

test("a JSON body (the removed arbitrary-file-path mode) is rejected with 400, no provider is ever invoked", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioFilePath: "C:/Windows/System32/drivers/etc/hosts" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_request");
    assert.equal(whisper.calls.length, 0);
    assert.equal(vibevoice.calls.length, 0);
  });
});

test("a JSON body attempting path traversal is rejected the same way -- no path-mode exists to traverse with", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioFilePath: "../../../../etc/passwd" }),
    });
    assert.equal(res.status, 400);
    assert.equal(whisper.calls.length, 0);
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

// ------------------------------------------------------------------------
// Stage 2 (OpenAI Speech ASR, multi-provider AI milestone)
// ------------------------------------------------------------------------

test("routes to openai when explicitly selected -- neither local engine is invoked", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  const openaiSpeech = new FakeAsrProvider("openai", "OpenAI Speech", "available");
  await withServer(
    whisper,
    vibevoice,
    async (base) => {
      const res = await fetch(`${base}/jack/transcribe?provider=openai`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: Buffer.from([0, 1, 2, 3]),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.provider, "openai");
      assert.equal(openaiSpeech.calls.length, 1);
      // Provider independence: selecting OpenAI Speech must never invoke
      // either local engine.
      assert.equal(whisper.calls.length, 0);
      assert.equal(vibevoice.calls.length, 0);
    },
    openaiSpeech,
  );
});

test("openai unavailable with no key configured returns a structured 503 with a not-configured detail, never a silent fallback", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  const openaiSpeech = new FakeAsrProvider("openai", "OpenAI Speech", "unavailable");
  const credentialStore = fakeCredentialStore({ provider: "openai", status: "not_configured" });
  await withServer(
    whisper,
    vibevoice,
    async (base) => {
      const res = await fetch(`${base}/jack/transcribe?provider=openai`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: Buffer.from([0, 1, 2, 3]),
      });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.error, "openai_unavailable");
      assert.match(body.detail, /No OpenAI API key is configured/);
      assert.equal(whisper.calls.length, 0);
      assert.equal(vibevoice.calls.length, 0);
      assert.equal(openaiSpeech.calls.length, 0);
    },
    openaiSpeech,
    credentialStore,
  );
});

test("openai unavailable with an invalid stored key returns a 503 that says so, distinct from not-configured", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  const openaiSpeech = new FakeAsrProvider("openai", "OpenAI Speech", "unavailable");
  const credentialStore = fakeCredentialStore({ provider: "openai", status: "invalid", detail: "Unauthorized (401)" });
  await withServer(
    whisper,
    vibevoice,
    async (base) => {
      const res = await fetch(`${base}/jack/transcribe?provider=openai`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: Buffer.from([0, 1, 2, 3]),
      });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.match(body.detail, /rejected/i);
    },
    openaiSpeech,
    credentialStore,
  );
});

test("a CredentialAuthError from openai's transcribe() (key revoked mid-flight) maps to 401, not the generic 502", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  const openaiSpeech = new FakeAsrProvider(
    "openai",
    "OpenAI Speech",
    "available",
    undefined,
    new CredentialAuthError("openai", "Authorization: Bearer sk-FAKE-SECRET"),
  );
  await withServer(
    whisper,
    vibevoice,
    async (base) => {
      const res = await fetch(`${base}/jack/transcribe?provider=openai`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: Buffer.from([0, 1, 2, 3]),
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error, "openai_unauthorized");
      assert.equal(body.detail, "OpenAI rejected the configured API key.");
      assert.doesNotMatch(JSON.stringify(body), /Authorization|Bearer|sk-FAKE-SECRET/i);
    },
    openaiSpeech,
  );
});

test("OpenAI Speech rate limits use a fixed message and never expose the provider diagnostic", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  const rateLimit = Object.assign(new Error("provider rejected api_key=sk-FAKE-SECRET"), { status: 429 });
  const openaiSpeech = new FakeAsrProvider("openai", "OpenAI Speech", "available", undefined, rateLimit);
  await withServer(whisper, vibevoice, async (base) => {
    const res = await fetch(`${base}/jack/transcribe?provider=openai`, {
      method: "POST", headers: { "Content-Type": "audio/wav" }, body: Buffer.from([0, 1, 2, 3]),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.detail, "OpenAI Speech is temporarily rate limited.");
    assert.doesNotMatch(JSON.stringify(body), /api_key|sk-FAKE-SECRET/i);
    assert.equal(whisper.calls.length, 0);
    assert.equal(vibevoice.calls.length, 0);
  }, openaiSpeech);
});

test("OpenAI Speech generic/network failures expose no hostile provider content", async () => {
  for (const hostile of [
    '{"error":{"message":"bad sk-FAKE-SECRET"}}',
    "request body contained sensitive diagnostic",
  ]) {
    const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
    const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
    const openaiSpeech = new FakeAsrProvider("openai", "OpenAI Speech", "available", undefined, new Error(hostile));
    await withServer(whisper, vibevoice, async (base) => {
      const res = await fetch(`${base}/jack/transcribe?provider=openai`, {
        method: "POST", headers: { "Content-Type": "audio/wav" }, body: Buffer.from([0, 1, 2, 3]),
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.detail, "OpenAI Speech could not transcribe this audio.");
      assert.doesNotMatch(JSON.stringify(body), /sk-FAKE-SECRET|sensitive diagnostic/i);
      assert.equal(whisper.calls.length, 0);
      assert.equal(vibevoice.calls.length, 0);
    }, openaiSpeech);
  }
});

test("a generic openai transcription failure (rate limit / network) maps to 502, with no silent fallback to whisper/vibevoice", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  const openaiSpeech = new FakeAsrProvider(
    "openai",
    "OpenAI Speech",
    "available",
    undefined,
    new Error("429 Too Many Requests"),
  );
  await withServer(
    whisper,
    vibevoice,
    async (base) => {
      const res = await fetch(`${base}/jack/transcribe?provider=openai`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: Buffer.from([0, 1, 2, 3]),
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, "openai_request_failed");
      assert.equal(whisper.calls.length, 0);
      assert.equal(vibevoice.calls.length, 0);
    },
    openaiSpeech,
  );
});

test("openai transcription forwards the language hint through to the provider, same as whisper/vibevoice", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  const openaiSpeech = new FakeAsrProvider("openai", "OpenAI Speech", "available", { language: "fr" });
  await withServer(
    whisper,
    vibevoice,
    async (base) => {
      const res = await fetch(`${base}/jack/transcribe?provider=openai&language=fr`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: Buffer.from([0, 1, 2, 3]),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.language, "fr");
    },
    openaiSpeech,
  );
});

test("openai selection still receives the bounded assistant-name hotword, same as whisper/vibevoice", async () => {
  const whisper = new FakeAsrProvider("whisper", "Approved · Whisper", "available");
  const vibevoice = new FakeAsrProvider("vibevoice", "Test · VibeVoice", "available");
  const openaiSpeech = new FakeAsrProvider("openai", "OpenAI Speech", "available");
  await withServer(
    whisper,
    vibevoice,
    async (base) => {
      const res = await fetch(`${base}/jack/transcribe?provider=openai&assistantName=Nova`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: Buffer.from([0, 1, 2, 3]),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(openaiSpeech.options, [{ hotwords: ["Nova"] }]);
    },
    openaiSpeech,
  );
});

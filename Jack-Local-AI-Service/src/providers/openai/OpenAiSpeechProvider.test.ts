import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAiSpeechProvider } from "./OpenAiSpeechProvider.ts";
import { CredentialAuthError } from "../../lib/providerErrors.ts";
import type { CredentialStore } from "../../lib/credentialStore.ts";

// Stage 2 (OpenAI Speech ASR) unit coverage, mocked-fetch only -- mirrors
// OpenAiProvider.test.ts's exact pattern (the `openai` SDK's requests go
// through globalThis.fetch, so intercepting it there is enough; no real
// network access, no paid API calls, no real OpenAI key required).

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

/** The `openai` SDK sends multipart/form-data as a raw ReadableStream body
 * (confirmed empirically, not FormData/a Node stream) -- this drains it to
 * text and pulls out one field's value by name for assertions, without a
 * full multipart parser. */
async function readMultipartField(body: unknown, field: string): Promise<string | null> {
  if (!body || typeof (body as ReadableStream).getReader !== "function") return null;
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  const match = new RegExp(`name="${field}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`).exec(text);
  return match ? match[1] : null;
}

/** transcribe() reads its input via fs.createReadStream(audioFilePath), so
 * (unlike chat()) it needs a real file to exist on disk -- exactly the
 * temp .wav file transcription.ts's route already writes before calling
 * any AsrProvider. */
async function withTempAudioFile(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jack-openai-speech-test-"));
  const path = join(dir, "audio.wav");
  await writeFile(path, Buffer.from([0, 1, 2, 3]));
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("checkHealth returns unavailable with no network call when no key is configured", async () => {
  let called = false;
  await withMockedFetch(
    (async () => {
      called = true;
      throw new Error("fetch should never be called when no key is configured");
    }) as typeof fetch,
    async () => {
      const provider = new OpenAiSpeechProvider(fakeStore(null), "gpt-4o-mini-transcribe");
      assert.equal(await provider.checkHealth(), "unavailable");
    },
  );
  assert.equal(called, false);
});

test("checkHealth never throws -- returns unavailable on a non-2xx response", async () => {
  await withMockedFetch(
    (async () => new Response(JSON.stringify({ error: { message: "server error" } }), { status: 500 })) as typeof fetch,
    async () => {
      const provider = new OpenAiSpeechProvider(fakeStore("sk-test"), "gpt-4o-mini-transcribe");
      assert.equal(await provider.checkHealth(), "unavailable");
    },
  );
});

test("transcribe() throws CredentialAuthError (never a network attempt) when no key is configured", () =>
  withTempAudioFile(async (path) => {
    let called = false;
    await withMockedFetch(
      (async () => {
        called = true;
        throw new Error("should not be called");
      }) as typeof fetch,
      async () => {
        const provider = new OpenAiSpeechProvider(fakeStore(null), "gpt-4o-mini-transcribe");
        await assert.rejects(
          () => provider.transcribe(path),
          (err: unknown) => err instanceof CredentialAuthError && err.providerId === "openai",
        );
      },
    );
    assert.equal(called, false);
  }));

test("transcribe() normalizes the OpenAI response into a JackTranscribeResponse", () =>
  withTempAudioFile(async (path) => {
    await withMockedFetch(
      (async () =>
        new Response(JSON.stringify({ text: "Jack, next slide." }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      async () => {
        const provider = new OpenAiSpeechProvider(fakeStore("sk-test"), "gpt-4o-mini-transcribe");
        const result = await provider.transcribe(path);
        assert.equal(result.text, "Jack, next slide.");
        assert.equal(result.provider, "openai");
        assert.equal(typeof result.latencyMs, "number");
      },
    );
  }));

test("transcribe() throws CredentialAuthError on a 401 response, not a generic Error", () =>
  withTempAudioFile(async (path) => {
    await withMockedFetch(
      (async () =>
        new Response(
          JSON.stringify({ error: { message: "Incorrect API key provided.", type: "invalid_request_error" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      async () => {
        const provider = new OpenAiSpeechProvider(fakeStore("sk-bad"), "gpt-4o-mini-transcribe");
        await assert.rejects(
          () => provider.transcribe(path),
          (err: unknown) => err instanceof CredentialAuthError && err.providerId === "openai",
        );
      },
    );
  }));

test("transcribe() propagates a generic network failure as a plain error -- never swallowed, never silently substituted", () =>
  withTempAudioFile(async (path) => {
    await withMockedFetch(
      (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      async () => {
        const provider = new OpenAiSpeechProvider(fakeStore("sk-test"), "gpt-4o-mini-transcribe");
        await assert.rejects(() => provider.transcribe(path));
      },
    );
  }));

test("transcribe() forwards the language hint in the request body", () =>
  withTempAudioFile(async (path) => {
    let capturedBody: unknown;
    await withMockedFetch(
      (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body;
        return new Response(JSON.stringify({ text: "hej" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      async () => {
        const provider = new OpenAiSpeechProvider(fakeStore("sk-test"), "gpt-4o-mini-transcribe");
        await provider.transcribe(path, "sv");
      },
    );
    assert.equal(await readMultipartField(capturedBody, "language"), "sv");
  }));

test("transcribe() sends only the bounded word-list prompt, never a synthetic full command sentence", () =>
  withTempAudioFile(async (path) => {
    let capturedBody: unknown;
    await withMockedFetch(
      (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body;
        return new Response(JSON.stringify({ text: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      async () => {
        const provider = new OpenAiSpeechProvider(fakeStore("sk-test"), "gpt-4o-mini-transcribe");
        await provider.transcribe(path, undefined, { hotwords: ["Nova"] });
      },
    );
    const prompt = await readMultipartField(capturedBody, "prompt");
    assert.ok(prompt?.includes("Nova"));
    // The historic Whisper regression this must never repeat: a prompt
    // containing a COMPLETE command sentence can be regurgitated verbatim
    // from noise/near-silent audio -- see WhisperProvider.ts's doc comment.
    assert.doesNotMatch(prompt ?? "", /Nova,\s*(stop|pause|continue)/i);
  }));

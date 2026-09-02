import assert from "node:assert/strict";
import test from "node:test";
import { ASR_PROVIDER_OPTIONS, DEFAULT_ASR_PROVIDER_ID, normalizeAsrProviderId } from "../app/jack/asrProviderSettings.ts";

// Stage 2 (OpenAI Speech ASR, multi-provider AI milestone): the ASR
// equivalent of ai-provider-settings.test.mjs's option/normalizer coverage.

test("ASR_PROVIDER_OPTIONS lists exactly whisper, vibevoice, and openai -- in that order", () => {
  assert.deepEqual(
    ASR_PROVIDER_OPTIONS.map((o) => o.id),
    ["whisper", "vibevoice", "openai"],
  );
});

test("Whisper's label keeps the Approved qualifier", () => {
  const whisper = ASR_PROVIDER_OPTIONS.find((o) => o.id === "whisper");
  assert.equal(whisper.label, "Approved · Whisper");
  assert.equal(whisper.requiresKey, false);
});

test("VibeVoice's label keeps the Test qualifier", () => {
  const vibevoice = ASR_PROVIDER_OPTIONS.find((o) => o.id === "vibevoice");
  assert.equal(vibevoice.label, "Test · VibeVoice");
  assert.equal(vibevoice.requiresKey, false);
});

test("OpenAI Speech is a distinct, independent ASR option -- not nested under or merged with the AI Assistant axis", () => {
  const openai = ASR_PROVIDER_OPTIONS.find((o) => o.id === "openai");
  assert.equal(openai.label, "OpenAI Speech");
  assert.equal(openai.requiresKey, true);
});

test("privacy copy: whisper and vibevoice both say transcription stays local", () => {
  for (const id of ["whisper", "vibevoice"]) {
    const option = ASR_PROVIDER_OPTIONS.find((o) => o.id === id);
    assert.match(option.description, /stays local/i);
  }
});

test("privacy copy: openai says captured speech is sent to OpenAI", () => {
  const openai = ASR_PROVIDER_OPTIONS.find((o) => o.id === "openai");
  assert.match(openai.description, /sent to OpenAI/);
});

test("normalizeAsrProviderId accepts every real option id", () => {
  for (const option of ASR_PROVIDER_OPTIONS) {
    assert.equal(normalizeAsrProviderId(option.id), option.id);
  }
});

test("normalizeAsrProviderId safely defaults to whisper for garbage/removed values", () => {
  assert.equal(normalizeAsrProviderId("bogus"), DEFAULT_ASR_PROVIDER_ID);
  assert.equal(normalizeAsrProviderId(undefined), DEFAULT_ASR_PROVIDER_ID);
  assert.equal(normalizeAsrProviderId(null), DEFAULT_ASR_PROVIDER_ID);
  assert.equal(normalizeAsrProviderId(42), DEFAULT_ASR_PROVIDER_ID);
});

test("DEFAULT_ASR_PROVIDER_ID is whisper (Approved), never vibevoice or openai", () => {
  assert.equal(DEFAULT_ASR_PROVIDER_ID, "whisper");
});

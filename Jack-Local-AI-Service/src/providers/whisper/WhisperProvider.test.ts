import assert from "node:assert/strict";
import test from "node:test";
import { buildWhisperArgs, WHISPER_THREADS } from "./WhisperProvider.ts";

// Regression coverage for the Whisper-approved-baseline audit's confirmed
// fix: without --prompt, ggml-base.en mis-transcribed "Jack, stop." as
// "Jackstomp.", "Jack, pause." as "Jack Paws" (a real homophone), and
// "Jack, explain this slide." as "Jack explained the slide." -- each one
// broke the command it was trying to give. Verified live against the full
// 20-phrase command corpus: 3/20 broken without --prompt, 20/20 correct
// with it, zero false insertions into unrelated speech.

test("buildWhisperArgs always includes --prompt with the command-vocabulary bias", () => {
  const args = buildWhisperArgs("models/ggml-base.en.bin", "C:/tmp/audio.wav");
  assert.deepEqual(args.slice(0, 8), [
    "-m",
    "models/ggml-base.en.bin",
    "-f",
    "C:/tmp/audio.wav",
    "-nt",
    "-np",
    "-t",
    String(WHISPER_THREADS),
  ]);
  const promptIndex = args.indexOf("--prompt");
  assert.notEqual(promptIndex, -1, "--prompt must always be passed");
  const prompt = args[promptIndex + 1];
  // Spot-check the three confirmed-broken words are actually in the prompt,
  // not just that a prompt of some kind exists.
  assert.match(prompt, /\bstop\b/i);
  assert.match(prompt, /\bpause\b/i);
  assert.match(prompt, /\bexplain\b/i);
});

test("buildWhisperArgs appends -l only when a language is explicitly given", () => {
  const withoutLanguage = buildWhisperArgs("model.bin", "audio.wav");
  assert.equal(withoutLanguage.includes("-l"), false);

  const withLanguage = buildWhisperArgs("model.bin", "audio.wav", "en");
  const lIndex = withLanguage.indexOf("-l");
  assert.notEqual(lIndex, -1);
  assert.equal(withLanguage[lIndex + 1], "en");
});

test("buildWhisperArgs appends caller-supplied hotwords to the prompt, never replacing the baseline command vocabulary", () => {
  const args = buildWhisperArgs("model.bin", "audio.wav", undefined, { hotwords: ["StageMind", "Kokoro"] });
  const prompt = args[args.indexOf("--prompt") + 1];
  assert.match(prompt, /\bstop\b/i); // baseline vocabulary still present
  assert.match(prompt, /StageMind/);
  assert.match(prompt, /Kokoro/);
});

test("buildWhisperArgs with empty hotwords behaves the same as no hotwords at all", () => {
  const withEmpty = buildWhisperArgs("model.bin", "audio.wav", undefined, { hotwords: [] });
  const withNone = buildWhisperArgs("model.bin", "audio.wav");
  assert.deepEqual(withEmpty, withNone);
});

// WHISPER SAFETY CORRECTION milestone, Part 10: -t is now explicitly pinned
// (confirmed via repeated timed real whisper-cli runs to be byte-identical
// output and statistically indistinguishable latency vs. the old implicit
// default) rather than left to whisper.cpp's own CLI default.
test("buildWhisperArgs explicitly pins the thread count", () => {
  assert.equal(WHISPER_THREADS, 4);
  const args = buildWhisperArgs("model.bin", "audio.wav");
  const tIndex = args.indexOf("-t");
  assert.notEqual(tIndex, -1, "-t must always be passed");
  assert.equal(args[tIndex + 1], "4");
});

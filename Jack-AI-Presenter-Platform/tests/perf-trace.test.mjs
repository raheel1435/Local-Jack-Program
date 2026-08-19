import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  __resetTracesForTests,
  abortTrace,
  buildSegments,
  collectMetric,
  computeDerived,
  computeStats,
  findBottleneck,
  finishTrace,
  getTraceHistory,
  mark,
  rateSlideToSpeech,
  segmentTotal,
  setTraceProvider,
  startTrace,
} from "../app/jack/perfTrace.ts";

// Regression coverage for the latency-observatory milestone's trace
// utilities: derived-latency math, per-kind segment breakdown, the
// interrupted-trace fix (speechPlayer.stop() never fires onEnded -- see
// JackProvider.tsx's activeSpeechTraceIdRef), and session statistics.
// perfTrace's history is module-level shared state, so each test resets it
// first -- otherwise traces from an earlier test bleed into a later test's
// collectMetric() results.
beforeEach(() => __resetTracesForTests());

test("a slide_narration trace computes slideVisibleToSpeaking as playbackStart - slideMutationDone", () => {
  const id = startTrace("slide_narration", "test slide");
  mark(id, "slideMutationDone", 1000);
  mark(id, "contextBuildStart", 1005);
  mark(id, "contextBuildReady", 1020);
  mark(id, "llmRequestStart", 1020);
  mark(id, "llmResponseReady", 2500);
  mark(id, "ttsRequestStart", 2500);
  mark(id, "ttsResponseReady", 3800);
  mark(id, "playbackStart", 3820);
  mark(id, "playbackComplete", 6000);
  finishTrace(id);

  const t = getTraceHistory()[0];
  assert.equal(t.traceId, id);
  assert.equal(t.ok, true);
  const derived = computeDerived(t);
  assert.equal(derived.slideVisibleToSpeaking, 2820); // 3820 - 1000
  assert.equal(derived.contextBuildLatency, 15); // 1020 - 1005
  assert.equal(derived.llmTotalGeneration, 1480); // 2500 - 1020
  assert.equal(derived.ttsTimeToAudio, 1300); // 3800 - 2500
  // T13 (llmFirstToken) was never marked -- non-streaming jackApi.chat --
  // so this must stay undefined, never a fabricated 0.
  assert.equal(derived.llmTimeToFirstToken, undefined);
});

test("segments for a narration trace sum exactly to the headline total, with no fabricated stages", () => {
  const id = startTrace("slide_narration");
  mark(id, "slideMutationDone", 0);
  mark(id, "contextBuildStart", 40);
  mark(id, "contextBuildReady", 60);
  mark(id, "llmRequestStart", 60);
  mark(id, "llmResponseReady", 2900);
  mark(id, "ttsRequestStart", 2900);
  mark(id, "ttsResponseReady", 4600);
  mark(id, "playbackStart", 4700);
  finishTrace(id);

  const t = getTraceHistory()[0];
  const segments = buildSegments(t);
  const total = segmentTotal(segments);
  assert.equal(total, 4700); // playbackStart - slideMutationDone
  const bottleneck = findBottleneck(segments);
  assert.equal(bottleneck.label, "LLM");
  assert.equal(bottleneck.ms, 2840); // 2900 - 60
});

test("rateSlideToSpeech applies the exact excellent/good/acceptable/poor/unacceptable thresholds", () => {
  assert.equal(rateSlideToSpeech(999), "excellent");
  assert.equal(rateSlideToSpeech(1999), "good");
  assert.equal(rateSlideToSpeech(2999), "acceptable");
  assert.equal(rateSlideToSpeech(4999), "poor");
  assert.equal(rateSlideToSpeech(5001), "unacceptable");
  assert.equal(rateSlideToSpeech(undefined), "n/a");
});

test("a voice_command trace tags its ASR provider and computes end-to-end turn latency", () => {
  const id = startTrace("voice_command");
  setTraceProvider(id, "vibevoice");
  mark(id, "speechStart", 0);
  mark(id, "speechEnd", 600);
  mark(id, "captureFinalized", 650);
  mark(id, "asrRequestStart", 660);
  mark(id, "asrTranscriptReady", 10800); // VibeVoice's real measured order-of-magnitude on this machine
  mark(id, "intentRequestStart", 10800);
  mark(id, "intentResultReady", 10825);
  mark(id, "slideMutationStart", 10825);
  mark(id, "slideMutationDone", 10826);
  mark(id, "playbackStart", 10826);
  finishTrace(id);

  const t = getTraceHistory()[0];
  assert.equal(t.asrProvider, "vibevoice");
  const segments = buildSegments(t);
  const asrRow = segments.find((s) => s.label.startsWith("ASR"));
  assert.equal(asrRow.label, "ASR VibeVoice");
  assert.equal(asrRow.ms, 10140);
  const derived = computeDerived(t);
  assert.equal(derived.totalTurnLatency, 10226); // playbackStart(10826) - speechEnd(600)
});

test("interrupted speech is recorded as a failed trace, not silently lost (the activeSpeechTraceIdRef fix)", () => {
  // Mirrors JackProvider.tsx's stopJackAudio(): speechPlayer.stop() never
  // fires the onEnded callback that would normally call finishTrace(), so
  // the caller (stopJackAudio) must finish it explicitly with ok=false.
  const id = startTrace("wake_greeting");
  mark(id, "ttsRequestStart", 0);
  mark(id, "ttsResponseReady", 300);
  mark(id, "playbackStart", 310);
  // ...interrupted here, before playbackComplete is ever marked...
  finishTrace(id, false);

  const t = getTraceHistory()[0];
  assert.equal(t.ok, false);
  assert.equal(t.marks.playbackComplete, undefined);
});

test("finishTrace is idempotent -- a second call (e.g. from both onEnded and an interrupt) does not corrupt history", () => {
  const before = getTraceHistory().length;
  const id = startTrace("typed_command");
  mark(id, "intentRequestStart", 0);
  mark(id, "intentResultReady", 20);
  finishTrace(id, true);
  finishTrace(id, false); // late/duplicate call -- must be a no-op
  assert.equal(getTraceHistory().length, before + 1);
  assert.equal(getTraceHistory()[0].ok, true); // the FIRST finish wins
});

test("abortTrace drops a trace entirely -- used when a barge-in is superseded before it ever produced a transcript", () => {
  const before = getTraceHistory().length;
  const id = startTrace("voice_command");
  mark(id, "speechStart", 0);
  abortTrace(id);
  finishTrace(id); // already gone -- must be a no-op, not re-add it
  assert.equal(getTraceHistory().length, before);
});

test("computeStats reports count/avg/median/p95/min/max, and collectMetric filters by kind and provider", () => {
  const ids = [];
  for (const [provider, ms] of [
    ["whisper", 1000],
    ["whisper", 1200],
    ["vibevoice", 9000],
    ["vibevoice", 11000],
  ]) {
    const id = startTrace("voice_command");
    setTraceProvider(id, provider);
    mark(id, "speechEnd", 0);
    mark(id, "playbackStart", ms);
    finishTrace(id);
    ids.push(id);
  }

  const history = getTraceHistory();
  const whisperTotals = collectMetric(history, (d) => d.totalTurnLatency, { kind: "voice_command", asrProvider: "whisper" });
  const vibeTotals = collectMetric(history, (d) => d.totalTurnLatency, { kind: "voice_command", asrProvider: "vibevoice" });
  assert.deepEqual(whisperTotals.sort((a, b) => a - b), [1000, 1200]);
  assert.deepEqual(vibeTotals.sort((a, b) => a - b), [9000, 11000]);

  const stats = computeStats(vibeTotals);
  assert.equal(stats.count, 2);
  assert.equal(stats.avg, 10000);
  assert.equal(stats.min, 9000);
  assert.equal(stats.max, 11000);

  assert.equal(computeStats([]), null);
});

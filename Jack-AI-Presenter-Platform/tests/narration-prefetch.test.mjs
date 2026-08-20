import assert from "node:assert/strict";
import test from "node:test";
import { isPrefetchValid } from "../app/jack/narration.ts";

// Regression coverage for the latency-fix milestone's next-slide prefetch:
// isPrefetchValid is the ONE place that decides whether a speculatively
// generated opening is safe to speak, so a slide is never narrated from a
// stale prefetch (pause/interrupt/jump/handoff/stop, or simply landing on a
// different slide than the one prefetched for).

test("a prefetch for the exact same generation and slide index is valid", () => {
  const prefetch = { generation: 3, slideIndex: 2 };
  assert.equal(isPrefetchValid(prefetch, { isOpening: false, generation: 3, slideIndex: 2 }), true);
});

test("a prefetch from a stale generation (pause/interrupt/jump/handoff/stop happened) is rejected", () => {
  const prefetch = { generation: 3, slideIndex: 2 };
  assert.equal(isPrefetchValid(prefetch, { isOpening: false, generation: 4, slideIndex: 2 }), false);
});

test("a prefetch for a different slide index is rejected", () => {
  const prefetch = { generation: 3, slideIndex: 2 };
  assert.equal(isPrefetchValid(prefetch, { isOpening: false, generation: 3, slideIndex: 5 }), false);
});

test("no prefetch at all is never valid", () => {
  assert.equal(isPrefetchValid(null, { isOpening: false, generation: 1, slideIndex: 0 }), false);
});

test("a prefetch is never used for the very first (opening) slide, even with matching generation/index", () => {
  const prefetch = { generation: 1, slideIndex: 0 };
  assert.equal(isPrefetchValid(prefetch, { isOpening: true, generation: 1, slideIndex: 0 }), false);
});

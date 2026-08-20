import assert from "node:assert/strict";
import test from "node:test";
import { buildPresentationContext } from "../app/jack/presentationContext.ts";
import { narrationSystemPrompt, isRedundantContinuation } from "../app/jack/narration.ts";
import { ok, fail } from "../app/jack/presentationController.ts";

// Slide-sync regression tests (Phase 28 of the slide-sync milestone) --
// covers the pure, non-React pieces of the fix: buildPresentationContext's
// explicit-index override (the actual root-cause fix for Jack narrating
// "slide 2" while slide 3 was on screen) and the opening/continuation
// narration prompt split (the fix for "Continue" replaying the full
// audience introduction).

const TITLES = ["Welcome", "Growth", "Pricing", "Roadmap", "Thank You"];

/** Minimal PresentationController double -- "current" always reports index 2
 * (slide 3), so any test that instead sees slide-1/slide-4 content proves
 * the explicit override, not the controller's own "current", was used. */
function makeController(currentIndex = 2) {
  return {
    modeName: "Test",
    getPresentationContext: () => ok({ title: "Test Deck", totalSlides: TITLES.length, currentSlideIndex: currentIndex, mode: "present" }),
    startPresentation: () => ok({ started: true }),
    pausePresentation: () => ok({ paused: true }),
    resumePresentation: () => ok({ resumed: true }),
    endPresentation: () => ok({ ended: true }),
    goToNextSlide: () => fail("not needed"),
    goToPreviousSlide: () => fail("not needed"),
    goToSlide: () => fail("not needed"),
    getCurrentSlide: () => ok({ index: currentIndex, total: TITLES.length, title: TITLES[currentIndex] }),
    getSlideContent: (index) => {
      const i = index ?? currentIndex;
      return TITLES[i] === undefined ? fail("out of range") : ok({ index: i, title: TITLES[i], text: `${TITLES[i]} content` });
    },
    getSpeakerNotes: (index) => ok({ index: index ?? currentIndex, notes: null }),
    showSpeakerNotes: () => ok({ shown: true }),
    hideSpeakerNotes: () => ok({ shown: false }),
    takePresentationControl: () => ok({ owner: "jack" }),
    handControlToPresenter: () => ok({ owner: "presenter" }),
    setPresentationPace: (pace) => ok({ pace }),
    getRemainingTime: () => ok({ remainingMs: null }),
    searchUploadedDocuments: () => ok({ matches: [] }),
    showRelevantSource: () => ok({ shown: true }),
    queueAudienceQuestion: () => ok({ id: "q1" }),
    markQuestionForFollowUp: () => ok({ id: "q1" }),
    syncJackToCurrentSlide: () => ok({ index: currentIndex, total: TITLES.length }),
    setAudienceQuestionPolicy: (policy) => ok({ policy }),
  };
}

test("buildPresentationContext uses the controller's current index when no explicit index is given", () => {
  const ctx = buildPresentationContext(makeController(2));
  assert.equal(ctx.currentSlideNumber, 3); // 0-based index 2 -> human slide 3
  assert.equal(ctx.currentSlideTitle, "Pricing");
});

test("buildPresentationContext uses the EXPLICIT index over the controller's stale 'current' -- the slide 3 -> spoken 'slide 2' fix", () => {
  // Controller still reports index 1 (slide 2) as "current" -- simulating
  // the exact race: goToNextSlide() already returned the new index (2, i.e.
  // slide 3), but the ref/state backing getPresentationContext() hasn't
  // caught up yet. The explicit override must win regardless.
  const ctx = buildPresentationContext(makeController(1), 2);
  assert.equal(ctx.currentSlideNumber, 3); // NOT 2 -- that was the bug
  assert.equal(ctx.currentSlideTitle, "Pricing"); // slide 3's title, not slide 2's ("Growth")
});

test("buildPresentationContext explicit index 0-based -> 1-based human number is exact, not off-by-one in either direction", () => {
  assert.equal(buildPresentationContext(makeController(0), 0).currentSlideNumber, 1);
  assert.equal(buildPresentationContext(makeController(0), 2).currentSlideNumber, 3);
  assert.equal(buildPresentationContext(makeController(0), 4).currentSlideNumber, 5);
});

test("buildPresentationContext with explicit index pulls THAT slide's title/text, not the controller's current one", () => {
  const ctx = buildPresentationContext(makeController(0), 3); // controller says slide 1, explicit says slide 4
  assert.equal(ctx.currentSlideTitle, "Roadmap");
  assert.equal(ctx.currentSlideText, "Roadmap content");
});

test("narration prompt for the opening includes a self-introduction instruction", () => {
  const prompt = narrationSystemPrompt(true, false);
  assert.match(prompt, /very first thing you will say/i);
  assert.match(prompt, /self-introduction/i);
});

test("narration prompt for a continuation explicitly forbids re-introducing Jack -- the 'Continue restarts the intro' fix", () => {
  const prompt = narrationSystemPrompt(false, false);
  assert.match(prompt, /ALREADY introduced yourself/);
  assert.doesNotMatch(prompt, /very first thing you will say/i);
});

test("narration prompt discourages stating the slide number regardless of opening/continuation", () => {
  assert.match(narrationSystemPrompt(true, false), /Do not state the slide/i);
  assert.match(narrationSystemPrompt(false, false), /Do not state the slide/i);
});

test("narration prompt keeps the agenda-slide exception for previewing upcoming content", () => {
  assert.match(narrationSystemPrompt(true, false), /agenda\/overview slide/);
  assert.match(narrationSystemPrompt(false, false), /agenda\/overview slide/);
});

test("humour only changes the opening prompt, never silently added to continuation narration instructions", () => {
  const openingHumour = narrationSystemPrompt(true, true);
  const openingNoHumour = narrationSystemPrompt(true, false);
  assert.match(openingHumour, /light touch of humour/i);
  assert.doesNotMatch(openingNoHumour, /light touch of humour/i);
  // Continuation prompt text is identical regardless of humourEnabled --
  // humour belongs to the opening/greeting/ack lines, not fabricated into
  // ordinary slide narration.
  assert.equal(narrationSystemPrompt(false, true), narrationSystemPrompt(false, false));
});

// Regression coverage for the latency-fix milestone's progressive-narration
// backstop -- confirmed live that the small local model (Qwen2.5-1.5B)
// sometimes paraphrases the opening sentence instead of adding new
// information, despite being explicitly told not to.
test("isRedundantContinuation catches a paraphrased restatement of the opening fact", () => {
  const opening = "The addressable market for last-mile delivery automation is estimated at $40 billion by 2030.";
  const paraphrase = "The addressable market is expected to reach $40 billion by 2030, highlighting significant growth potential.";
  assert.equal(isRedundantContinuation(opening, paraphrase), true);
});

test("isRedundantContinuation allows a genuinely new sentence through", () => {
  const opening = "The addressable market for last-mile delivery automation is estimated at $40 billion by 2030.";
  const newInfo = "Regulatory approval in the EU is expected to open an additional 12 billion dollars of that market by 2027.";
  assert.equal(isRedundantContinuation(opening, newInfo), false);
});

test("isRedundantContinuation treats an empty continuation as not redundant (the caller already drops empties separately)", () => {
  assert.equal(isRedundantContinuation("Some opening sentence.", ""), false);
});

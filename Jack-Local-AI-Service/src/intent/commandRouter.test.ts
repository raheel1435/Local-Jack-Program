import assert from "node:assert/strict";
import test from "node:test";
import { matchDeterministicCommand } from "./commandRouter.ts";

// Regression coverage for the slide-sync/lifecycle milestone's deterministic
// router fixes -- all confirmed live via Chrome DevTools MCP against the
// running gateway before being added here.

test("all Phase 8 takeover phrasings resolve to start_presentation deterministically", () => {
  const phrases = [
    "Jack take over.",
    "Jack take over from here.",
    "Jack, you take over.",
    "Take over, Jack.",
    "You can present from here.",
    "Jack, present this.",
    "Jack, continue the presentation.",
    "Jack, you handle it.",
  ];
  for (const phrase of phrases) {
    const result = matchDeterministicCommand(phrase);
    assert.deepEqual(result, { type: "action", action: "start_presentation" }, `expected start_presentation for "${phrase}"`);
  }
});

test("all Phase 9 handoff phrasings resolve to handoff_to_presenter deterministically", () => {
  const phrases = ["I'll take it from here.", "Let me take over.", "I've got it.", "Give it back to me.", "Jack, I'll continue."];
  for (const phrase of phrases) {
    const result = matchDeterministicCommand(phrase);
    assert.deepEqual(result, { type: "action", action: "handoff_to_presenter" }, `expected handoff_to_presenter for "${phrase}"`);
  }
});

// Regression coverage for the Whisper-approved-baseline audit: "Jack, I'll
// take it from here." (verbatim from this milestone's own test corpus)
// transcribed perfectly but fell through to the LLM fallback un-anchored by
// "jack,", which classified it as plain conversation -- control was never
// handed back. Confirmed live via curl and the real browser UI after adding
// the same "Hey/Ok/Okay/Yo Jack" prefix tolerance already used elsewhere.
test("leading 'Jack,' / 'Hey Jack,' handoff phrasings resolve to handoff_to_presenter deterministically", () => {
  const phrases = [
    "Jack, I'll take it from here.",
    "Hey Jack, I'll take it from here.",
    "Jack, I'll take over.",
    "Jack, I'll take over now.",
  ];
  for (const phrase of phrases) {
    const result = matchDeterministicCommand(phrase);
    assert.deepEqual(result, { type: "action", action: "handoff_to_presenter" }, `expected handoff_to_presenter for "${phrase}"`);
  }
});

test("'Jack take over again.' resolves to start_presentation, not handoff -- confirmed live the LLM fallback inverted this", () => {
  assert.deepEqual(matchDeterministicCommand("Jack take over again."), { type: "action", action: "start_presentation" });
  assert.deepEqual(matchDeterministicCommand("Take over again, Jack."), { type: "action", action: "start_presentation" });
});

// Regression coverage for the real user-reported bug (latency-fix
// milestone follow-up): "Hey Jack, take over" fell through the
// deterministic router entirely (only a bare leading "jack" was
// recognized), landed in the LLM fallback, which inverted it to
// handoff_to_presenter -- "Absolutely. It's yours.", then silence, because
// control had just been handed BACK to the presenter instead of TO Jack.
test("'Hey Jack, take over' resolves to start_presentation deterministically, not the LLM's inverted handoff_to_presenter", () => {
  const phrases = [
    "Hey Jack, take over",
    "Hey Jack take over.",
    "Ok Jack, take over.",
    "Okay Jack, take over.",
    "Yo Jack, take over.",
  ];
  for (const phrase of phrases) {
    assert.deepEqual(matchDeterministicCommand(phrase), { type: "action", action: "start_presentation" }, `expected start_presentation for "${phrase}"`);
  }
});

test("a 'hey/ok/okay/yo Jack' greeting prefix is accepted on every jack-addressed action, not just start_presentation", () => {
  assert.deepEqual(matchDeterministicCommand("Hey Jack, next slide."), { type: "action", action: "next_slide" });
  assert.deepEqual(matchDeterministicCommand("Hey Jack, pause."), { type: "action", action: "pause_presentation" });
  assert.deepEqual(matchDeterministicCommand("Hey Jack, previous slide."), { type: "action", action: "previous_slide" });
  assert.deepEqual(matchDeterministicCommand("Okay Jack, stop presenting."), { type: "action", action: "stop_presentation" });
  assert.deepEqual(matchDeterministicCommand("Hey Jack, resume the presentation."), { type: "action", action: "resume_presentation" });
});

test("bracketed non-speech Whisper artifacts fail safe to unknown, never reach the LLM -- confirmed live via barge-in picking up real ambient noise", () => {
  const artifacts = [
    "(screams) (screams) (screams)",
    "(indistinct chatter) (indistinct chatter)",
    "[Music]",
    "(laughing)",
    "(door slam)",
  ];
  for (const text of artifacts) {
    assert.deepEqual(matchDeterministicCommand(text), { type: "unknown" }, `expected unknown for "${text}"`);
  }
});

test("real speech alongside a bracketed annotation is NOT treated as a non-speech artifact", () => {
  // Falls through to the LLM (returns null) rather than being force-classified
  // here -- the point is only that it must not be swallowed as noise.
  const result = matchDeterministicCommand("next slide (laughs)");
  assert.notDeepEqual(result, { type: "unknown" });
});

test("a single bare word still fails safe to unknown (pre-existing fragment-safety regression)", () => {
  for (const word of ["you.", "the.", "jack.", "from."]) {
    assert.deepEqual(matchDeterministicCommand(word), { type: "unknown" });
  }
});

test("legitimate one-word commands are unaffected by the fragment/artifact safety nets", () => {
  assert.deepEqual(matchDeterministicCommand("Next."), { type: "action", action: "next_slide" });
  assert.deepEqual(matchDeterministicCommand("Pause."), { type: "action", action: "pause_presentation" });
  assert.deepEqual(matchDeterministicCommand("Continue."), { type: "action", action: "resume_presentation" });
  assert.deepEqual(matchDeterministicCommand("Back."), { type: "action", action: "previous_slide" });
});

// WHISPER SAFETY CORRECTION milestone, Part 4: none of these may execute the
// positive command -- checked BEFORE ACTION_RULES, deterministically, so
// they never even reach the LLM (which has no negation handling of its
// own and could invert the meaning, the same class of bug this file's
// history already documents for un-negated phrasings).
test("negated commands never execute the positive action -- deterministic, fails safe to conversation", () => {
  const phrases = [
    "Jack, don't stop.",
    "Jack, do not stop.",
    "Jack, don't pause.",
    "Jack, do not continue.",
    "Jack, don't go to the next slide.",
    "Jack, I don't want you to take over.",
    "Jack, please don't hand it back to me.",
  ];
  for (const phrase of phrases) {
    assert.deepEqual(matchDeterministicCommand(phrase), { type: "conversation" }, `expected conversation (not an action) for "${phrase}"`);
  }
});

// Part 15: "Jack, summarize this slide." previously reached the LLM
// fallback only, where the Vibe-milestone corpus run recorded it as a
// classification miss on a perfect transcript -- a routing gap, not an ASR
// failure. Both explain/summarize are now deterministic, matching
// explain_slide's existing (correct) deterministic status implicitly
// expected by that corpus.
test("'Jack, explain this slide.' and 'Jack, summarize this slide.' resolve deterministically", () => {
  assert.deepEqual(matchDeterministicCommand("Jack, explain this slide."), { type: "action", action: "explain_slide" });
  assert.deepEqual(matchDeterministicCommand("Jack, explain the slide."), { type: "action", action: "explain_slide" });
  assert.deepEqual(matchDeterministicCommand("Hey Jack, summarize this slide."), { type: "action", action: "summarize_slide" });
  assert.deepEqual(matchDeterministicCommand("Jack, summarise this slide."), { type: "action", action: "summarize_slide" });
});

// Part 3/14 adversarial corpus: Jackson/Jackie are a different word
// entirely (word-boundary regex), and plain "next slide"/"pause" with no
// Jack at all are the pre-existing, intentional one-word-command UX -- both
// must keep resolving exactly as before, not be broken by this milestone's
// negation/addressing work.
test("adversarial corpus: no false destructive action from name-confusables or bare non-addressed commands", () => {
  assert.deepEqual(matchDeterministicCommand("Jackson, next slide."), null);
  assert.deepEqual(matchDeterministicCommand("Jackie, pause."), null);
  assert.deepEqual(matchDeterministicCommand("next slide"), { type: "action", action: "next_slide" });
  assert.deepEqual(matchDeterministicCommand("pause"), { type: "action", action: "pause_presentation" });
});

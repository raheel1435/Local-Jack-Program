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

test("'Jack take over again.' resolves to start_presentation, not handoff -- confirmed live the LLM fallback inverted this", () => {
  assert.deepEqual(matchDeterministicCommand("Jack take over again."), { type: "action", action: "start_presentation" });
  assert.deepEqual(matchDeterministicCommand("Take over again, Jack."), { type: "action", action: "start_presentation" });
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

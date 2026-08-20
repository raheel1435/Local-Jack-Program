import assert from "node:assert/strict";
import test from "node:test";
import { classifyAddress, hasNegation, hasSuspiciousRepetition } from "./addressing.ts";

// WHISPER SAFETY CORRECTION milestone: mirrors
// Jack-AI-Presenter-Platform/app/jack/addressing.test's coverage for
// classifyAddress (kept in sync by hand, see this module's own comment),
// plus this file's gateway-only additions: hasNegation and
// hasSuspiciousRepetition.

test("classifyAddress: direct vs mention vs none", () => {
  assert.equal(classifyAddress("Jack, next slide."), "direct");
  assert.equal(classifyAddress("Hey Jack, pause."), "direct");
  assert.equal(classifyAddress("Are you listening, Jack?"), "direct");
  assert.equal(classifyAddress("Jack?"), "direct");
  assert.equal(classifyAddress("The next slide explains why Jack stopped."), "mention");
  assert.equal(classifyAddress("My friend Jack works in London."), "mention");
  assert.equal(classifyAddress("Why did Jack stop yesterday?"), "mention");
  assert.equal(classifyAddress("Please continue."), "none");
  assert.equal(classifyAddress("Jackson, next slide."), "none");
  assert.equal(classifyAddress("Jackie, pause."), "none");
});

// Part 4's full adversarial negation corpus.
test("hasNegation catches every Part 4 negated-command phrasing", () => {
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
    assert.equal(hasNegation(phrase), true, `expected negation detected in "${phrase}"`);
  }
});

test("hasNegation is false for ordinary positive commands and unrelated negations", () => {
  assert.equal(hasNegation("Jack, stop."), false);
  assert.equal(hasNegation("Jack, next slide."), false);
  // Negation word present, but no command verb nearby -- not a negated command.
  assert.equal(hasNegation("Jack, I don't like this color scheme."), false);
});

// Part 17: the distinguishing signal is Jack's name repeating, not the verb.
test("hasSuspiciousRepetition flags Jack's name repeating, not the command verb repeating", () => {
  assert.equal(hasSuspiciousRepetition("Jack, stop. Jack, stop. Jack, stop."), true);
  assert.equal(hasSuspiciousRepetition("Jack, stop, stop, stop!"), false);
  assert.equal(hasSuspiciousRepetition("Jack, next slide."), false);
});

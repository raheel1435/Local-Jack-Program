import assert from "node:assert/strict";
import test from "node:test";
import { classifyJackAddress, isDirectlyAddressedToJack } from "../app/jack/addressing.ts";

// WHISPER SAFETY CORRECTION milestone: regression coverage for the fix to
// the ambient barge-in gate, which used to be a bare `/\bjack\b/i` test --
// see addressing.ts's module comment for the live false-stop an independent
// Codex review reproduced from this gap.

test("direct address: leading 'Jack,'", () => {
  assert.equal(classifyJackAddress("Jack, next slide."), "direct");
});

test("direct address: greeting filler + Jack", () => {
  assert.equal(classifyJackAddress("Hey Jack, pause."), "direct");
  assert.equal(classifyJackAddress("Okay Jack, continue."), "direct");
});

test("direct address: leading Jack followed by a question", () => {
  assert.equal(classifyJackAddress("Jack, can you explain this?"), "direct");
});

test("direct address: bare wake word, with or without a question mark", () => {
  assert.equal(classifyJackAddress("Jack?"), "direct");
  assert.equal(classifyJackAddress("Jack"), "direct");
});

test("direct address: trailing vocative after a comma", () => {
  assert.equal(classifyJackAddress("Are you listening, Jack?"), "direct");
});

test("mention, not address: Jack named mid-sentence as the subject of someone else's story", () => {
  assert.equal(classifyJackAddress("The next slide explains why Jack stopped."), "mention");
  assert.equal(classifyJackAddress("My friend Jack works in London."), "mention");
  assert.equal(classifyJackAddress("I mentioned Jack earlier."), "mention");
  assert.equal(classifyJackAddress("This graph shows what Jack described."), "mention");
  assert.equal(classifyJackAddress("Why did Jack stop yesterday?"), "mention");
});

test("no Jack at all", () => {
  assert.equal(classifyJackAddress("Please continue to the next slide."), "none");
});

test("word-boundary regex: Jackson/Jackie/Jacky never match, not even as a mention", () => {
  assert.equal(classifyJackAddress("Jackson, next slide."), "none");
  assert.equal(classifyJackAddress("Jackie, pause."), "none");
  assert.equal(classifyJackAddress("I saw Jacky at the store."), "none");
});

test("isDirectlyAddressedToJack is true only for 'direct', false for 'mention'/'none'", () => {
  assert.equal(isDirectlyAddressedToJack("Jack, stop."), true);
  assert.equal(isDirectlyAddressedToJack("The next slide explains why Jack stopped."), false);
  assert.equal(isDirectlyAddressedToJack("Next slide please."), false);
});

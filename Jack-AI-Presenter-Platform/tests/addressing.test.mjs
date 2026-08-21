import assert from "node:assert/strict";
import test from "node:test";
import { classifyJackAddress, isDirectlyAddressedToJack, isSelfEcho } from "../app/jack/addressing.ts";

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

// WHISPER FALSE-DESTRUCTIVE-COMMAND ROOT-CAUSE milestone: regression
// coverage for the self-echo guard, added after live real-hardware-mic
// testing captured "Jack, I'll take it from here." (a real command match)
// moments after Jack himself said "Got it. I'll take it from here." via TTS.

test("self-echo: a near-verbatim echo of Jack's own recent speech is flagged", () => {
  const recent = [{ text: "Got it. I'll take it from here.", at: Date.now() }];
  assert.equal(isSelfEcho("Jack, I'll take it from here.", recent), true);
});

test("self-echo: a genuinely independent short command is never flagged, even with incidental word overlap", () => {
  const recent = [{ text: "Let's look at the next slide about our roadmap.", at: Date.now() }];
  // Shares "next"/"slide" with Jack's own narration, but only 2 content
  // words total -- below the minimum-shared-words floor, so short commands
  // can never be self-echo-suppressed no matter what Jack just said.
  assert.equal(isSelfEcho("Jack, next slide.", recent), false);
  assert.equal(isSelfEcho("Jack, stop.", recent), false);
});

test("self-echo: a longer independent utterance with only partial/incidental overlap is not flagged", () => {
  const recent = [{ text: "This slide covers our pricing strategy for the enterprise tier.", at: Date.now() }];
  assert.equal(isSelfEcho("Jack, what is the refund policy for annual plans?", recent), false);
});

test("self-echo: history entries older than the retention window are the caller's responsibility to prune, not silently ignored by content alone", () => {
  // isSelfEcho itself doesn't look at timestamps -- callers (JackProvider)
  // are expected to prune old entries before calling. Confirms it still
  // matches purely on text if a stale entry is passed in.
  const recent = [{ text: "Got it. I'll take it from here.", at: Date.now() - 10 * 60_000 }];
  assert.equal(isSelfEcho("Jack, I'll take it from here.", recent), true);
});

test("self-echo: empty history never flags anything", () => {
  assert.equal(isSelfEcho("Jack, I'll take it from here.", []), false);
});

// Independent-attack-review finding: a real, independent navigation command
// that happens to reuse the same low-impact deck-navigation vocabulary as
// Jack's own narration (both legitimately talk about "next"/"slide"/
// "continue" -- this app's whole domain) must NOT be silently swallowed as
// self-echo just because every one of its content words also appears in
// Jack's last utterance. Fixed via GENERIC_OVERLAP_WORDS -- see the module
// comment on isSelfEcho.
test("self-echo: a real command sharing only generic navigation/deck-topic vocabulary with narration is never flagged", () => {
  const recent = [{ text: "Let's continue to the next slide now.", at: Date.now() }];
  assert.equal(isSelfEcho("Jack, continue to the next slide.", recent), false);

  const recent2 = [{ text: "This slide covers our pricing and the product roadmap.", at: Date.now() }];
  assert.equal(isSelfEcho("Jack, summarize the pricing and roadmap slide.", recent2), false);
});

// The generic-vocabulary exclusion must not blind the guard to the actual
// motivating case -- "take"/"from"/"i'll" are not navigation/deck-topic
// words, so this must still be caught.
test("self-echo: the exclusion list does not defeat detection of the original motivating case", () => {
  const recent = [{ text: "Got it. I'll take it from here.", at: Date.now() }];
  assert.equal(isSelfEcho("Jack, I'll take it from here.", recent), true);
});

// Multi-persona milestone: the wake word follows whichever assistant name is
// currently selected, passed as the optional second argument (default
// "jack"), so classifyJackAddress/isDirectlyAddressedToJack/isSelfEcho work
// identically for any persona.
test("classifyJackAddress and isDirectlyAddressedToJack follow a non-default assistant name", () => {
  assert.equal(classifyJackAddress("Nova, next slide.", "Nova"), "direct");
  assert.equal(classifyJackAddress("Hey Nova, pause.", "Nova"), "direct");
  assert.equal(classifyJackAddress("My friend Nova works in London.", "Nova"), "mention");
  assert.equal(classifyJackAddress("Jack, stop.", "Nova"), "none");
  assert.equal(isDirectlyAddressedToJack("Nova, stop.", "Nova"), true);
  assert.equal(isDirectlyAddressedToJack("Jack, stop.", "Nova"), false);
});

test("isSelfEcho excludes the currently selected assistant name from content-word overlap, same as the default 'jack'", () => {
  const recent = [{ text: "Nova, I'll take it from here.", at: Date.now() }];
  assert.equal(isSelfEcho("Nova, I'll take it from here.", recent, "Nova"), true);
});

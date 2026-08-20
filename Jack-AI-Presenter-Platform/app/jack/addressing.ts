/**
 * Semantic addressing: distinguishes Jack being ADDRESSED ("Jack, stop.",
 * "Hey Jack, pause.", "Are you listening, Jack?") from Jack merely being
 * MENTIONED ("The next slide explains why Jack stopped.", "My friend Jack
 * works in London."). The old gate here was a bare `/\bjack\b/i.test(...)`
 * -- WHISPER SAFETY CORRECTION milestone: an independent Codex review found
 * this let any incidental mention of the word "Jack" through the ambient
 * barge-in gate exactly like a real command, and reproduced a live false
 * "stop_presentation" from ambient noise Whisper transcribed as "Jack, stop.
 * Jack, stop. Jack, stop." -- see WHISPER_APPROVED_BASELINE.md.
 *
 * Deliberately structural, not a lookup table of the specific example
 * sentences from that review: a mention is Jack's name appearing somewhere
 * in the middle of a sentence about him; an address is Jack's name in
 * vocative position -- leading the utterance (optionally after a greeting
 * filler), trailing it after a comma, or the whole utterance being just his
 * name. `\bjack\b` still requires a real word boundary, so "Jackson"/
 * "Jackie"/"Jacky" never match at all (word-boundary regex, not
 * substring) -- those aren't even a "mention", they're a different word.
 *
 * This module is intentionally duplicated (not imported) from
 * Jack-Local-AI-Service/src/intent/addressing.ts -- the frontend and gateway
 * are separate npm packages with no shared workspace package today. Keep the
 * two in sync by hand; each has its own test coverage.
 */
export type AddressClassification = "direct" | "mention" | "none";

const GREETING = "(?:hey|ok(?:ay)?|yo)[,]?\\s+";
const LEADING_JACK = new RegExp(`^(?:${GREETING})?jack\\b`);
const TRAILING_JACK = /,\s*jack[.?!]?$/;
const BARE_JACK = /^jack[.?!]?$/;
const ANY_JACK = /\bjack\b/;

export function classifyJackAddress(rawText: string): AddressClassification {
  const text = rawText.trim().toLowerCase();
  if (!ANY_JACK.test(text)) return "none";
  if (BARE_JACK.test(text)) return "direct";
  if (LEADING_JACK.test(text)) return "direct";
  if (TRAILING_JACK.test(text)) return "direct";
  return "mention";
}

/** Convenience wrapper matching the old boolean gate's call sites. */
export function isDirectlyAddressedToJack(rawText: string): boolean {
  return classifyJackAddress(rawText) === "direct";
}

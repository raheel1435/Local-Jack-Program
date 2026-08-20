/**
 * Semantic addressing + negation + repetition-suspicion signals for the
 * gateway's intent layer. WHISPER SAFETY CORRECTION milestone: an
 * independent Codex review reproduced a live false stop_presentation in
 * Present mode from ambient noise Whisper transcribed as "Jack, stop. Jack,
 * stop. Jack, stop." -- that transcript is multi-sentence and doesn't match
 * any anchored ACTION_RULES pattern in commandRouter.ts, so it fell through
 * to the LLM fallback in routes/intent.ts, which inferred stop_presentation
 * from it. This module's exports gate that fallback: classifyAddress
 * distinguishes Jack being ADDRESSED from merely MENTIONED, hasNegation
 * catches "Jack, don't stop." before any positive command executes, and
 * hasSuspiciousRepetition catches the specific hallmark of THIS incident --
 * Jack's name itself repeated multiple times in one utterance, which a real
 * single utterance addressed to one person essentially never does (a real
 * user repeats the VERB for emphasis -- "Jack, stop, stop, stop!" -- not the
 * address; see hasSuspiciousRepetition's own comment).
 *
 * Intentionally duplicated (not imported) from
 * Jack-AI-Presenter-Platform/app/jack/addressing.ts's classifyJackAddress --
 * the frontend and gateway are separate npm packages with no shared
 * workspace package today. Keep the two in sync by hand; each has its own
 * test coverage.
 */
export type AddressClassification = "direct" | "mention" | "none";

const GREETING = "(?:hey|ok(?:ay)?|yo)[,]?\\s+";
const LEADING_JACK = new RegExp(`^(?:${GREETING})?jack\\b`);
const TRAILING_JACK = /,\s*jack[.?!]?$/;
const BARE_JACK = /^jack[.?!]?$/;
const ANY_JACK = /\bjack\b/;
const ALL_JACK_OCCURRENCES = /\bjack\b/g;

export function classifyAddress(rawText: string): AddressClassification {
  const text = rawText.trim().toLowerCase();
  if (!ANY_JACK.test(text)) return "none";
  if (BARE_JACK.test(text)) return "direct";
  if (LEADING_JACK.test(text)) return "direct";
  if (TRAILING_JACK.test(text)) return "direct";
  return "mention";
}

// Negation markers checked as their own words/phrases -- deliberately not
// "stripped out" before command matching (Part 4's explicit requirement):
// this function is the thing that LOOKS for them, nothing upstream is
// allowed to normalize them away first.
const NEGATION_RE = /\b(don't|do not|doesn't|does not|won't|will not|never|shouldn't|should not|can't|cannot|didn't want|don't want|do not want)\b/;

// Deliberately broad rather than a fixed phrase list: any negation word
// combined with any command-family verb anywhere in the utterance. A false
// positive here (swallowing a real trailing command buried in a longer
// negated sentence) fails SAFE -- the utterance falls to "conversation"
// instead of matching a positive action -- which is exactly the asymmetry
// Part 4 asks for ("NONE may execute the positive command").
const COMMAND_VERB_RE =
  /\b(stop|pause|continue|resume|next|previous|back|take ?over|takeover|hand(?:off|s)?( it)?( back)?|control|present|explain|summarize)\b/;

export function hasNegation(rawText: string): boolean {
  const text = rawText.trim().toLowerCase();
  return NEGATION_RE.test(text) && COMMAND_VERB_RE.test(text);
}

/**
 * The Codex-reproduced hallucination repeated the FULL "Jack, stop." unit
 * three times, not just the verb -- a real user emphasizing urgency repeats
 * the command word ("Jack, stop, stop, stop!") but names the person they're
 * talking to exactly once, the same way a real spoken sentence always does.
 * Counting "jack" occurrences (not command-verb occurrences) is what lets
 * this module tell those two apart: "Jack, stop, stop, stop!" has one
 * address and passes; "Jack, stop. Jack, stop. Jack, stop." has three and is
 * flagged, matching Part 17's explicit requirement not to penalize the
 * former while catching the latter.
 */
export function hasSuspiciousRepetition(rawText: string): boolean {
  const text = rawText.trim().toLowerCase();
  const matches = text.match(ALL_JACK_OCCURRENCES);
  return (matches?.length ?? 0) >= 2;
}

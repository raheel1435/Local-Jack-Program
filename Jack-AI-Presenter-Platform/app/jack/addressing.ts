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

// Multi-persona milestone: the wake word is whichever assistant name is
// currently selected (Jack or Nova), not always literally "Jack" -- see
// voiceSettings.ts's VOICE_OPTIONS, which
// this name is resolved from in JackProvider. Regex-escaped since a label
// is presenter-facing text, not a hand-written pattern. Kept in sync by
// hand with Jack-Local-AI-Service/src/intent/addressing.ts's classifyAddress
// (see this module's own header comment on why it's duplicated, not shared).
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function classifyJackAddress(rawText: string, name = "jack"): AddressClassification {
  const text = rawText.trim().toLowerCase();
  const n = escapeRegExp(name.trim().toLowerCase());
  const leading = new RegExp(`^(?:${GREETING})?${n}\\b`);
  const trailing = new RegExp(`,\\s*${n}[.?!]?$`);
  const bare = new RegExp(`^${n}[.?!]?$`);
  const any = new RegExp(`\\b${n}\\b`);
  if (!any.test(text)) return "none";
  if (bare.test(text)) return "direct";
  if (leading.test(text)) return "direct";
  if (trailing.test(text)) return "direct";
  return "mention";
}

/** Convenience wrapper matching the old boolean gate's call sites. */
export function isDirectlyAddressedToJack(rawText: string, name = "jack"): boolean {
  return classifyJackAddress(rawText, name) === "direct";
}

/**
 * Self-echo guard. WHISPER FALSE-DESTRUCTIVE-COMMAND ROOT-CAUSE milestone:
 * live real-hardware-microphone testing while Jack was actively narrating
 * (TTS through real speakers, picked up by the same real mic despite
 * echoCancellation/noiseSuppression/autoGainControl all being requested)
 * measured a MUCH higher false-trigger rate than a silent-room baseline
 * (~10 false transcripts in 2.5 minutes narrating vs. 2 in 4+ minutes
 * silent), including "Jack, I'll take it from here." -- a near-verbatim
 * echo of what Jack himself had just said via TTS moments earlier ("Got it.
 * I'll take it from here."). That phrase matches commandRouter.ts's
 * handoff_to_presenter pattern deterministically -- confidence-based
 * filtering does NOT help here (a well-captured self-echo is a genuinely
 * HIGH-confidence, CORRECT transcription -- just of the wrong speaker, not
 * a low-confidence hallucination the prompt-redesign fix targets).
 *
 * Jack already knows exactly what text he's spoken recently (JackProvider's
 * currentCaption). This compares an incoming transcript against that
 * history and flags a match ONLY when there's substantial, specific overlap
 * -- deliberately conservative in two ways so a real independent command
 * is never swallowed: (1) transcripts shorter than 3 non-trivial words are
 * never flagged at all (a real 2-word command like "Jack, next slide."
 * could coincidentally share a word or two with Jack's own recent
 * presentation-content narration -- e.g. "slide" -- without meaning
 * anything), (2) even for longer transcripts, at least 3 shared words AND
 * 60%+ of the transcript's own content words must appear in that one prior
 * utterance, not scattered across several.
 *
 * Independent-review fix: an adversarial review of this exact design found
 * that (2) alone still had a real false-positive mode -- Jack's own
 * narration is ABOUT the same deck-navigation vocabulary his commands use
 * ("next", "slide", "continue"...), so a genuine "Jack, continue to the
 * next slide." can share 100% of its content words with narration like
 * "Let's continue to the next slide now." and get wrongly swallowed as
 * self-echo, with no error shown to the user. Fixed by also excluding the
 * generic navigation/deck-topic vocabulary (the LOW_IMPACT/informational
 * words from commandRouter.ts's own action set, plus the deck-topic nouns
 * from the ASR prompt) from counting as self-echo evidence -- these are
 * exactly the words legitimate commands and ordinary narration both use
 * naturally, so they're weak signal either way. The words that motivated
 * this guard in the first place ("I'll take it from here", "take over") are
 * NOT navigation/topic vocabulary and are unaffected.
 */
const TRIVIAL_WORDS = new Set([
  "jack",
  "the",
  "a",
  "an",
  "it",
  "to",
  "is",
  "was",
  "i",
  "you",
  "this",
  "that",
  "here",
]);

const GENERIC_OVERLAP_WORDS = new Set([
  "next",
  "previous",
  "slide",
  "continue",
  "explain",
  "summarize",
  "pricing",
  "roadmap",
  "presentation",
]);

function contentWords(text: string, name: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, "")
    .split(/\s+/)
    .filter((w) => w && w !== name.trim().toLowerCase() && !TRIVIAL_WORDS.has(w) && !GENERIC_OVERLAP_WORDS.has(w));
}

export interface RecentSpeech {
  text: string;
  /** ms since epoch */
  at: number;
}

const SELF_ECHO_MIN_SHARED_WORDS = 3;
const SELF_ECHO_MIN_CONTAINMENT = 0.6;

export function isSelfEcho(transcript: string, recentSpeech: readonly RecentSpeech[], name = "jack"): boolean {
  const transcriptWords = contentWords(transcript, name);
  if (transcriptWords.length < SELF_ECHO_MIN_SHARED_WORDS) return false;
  for (const { text } of recentSpeech) {
    const spokenWordSet = new Set(contentWords(text, name));
    const shared = transcriptWords.filter((w) => spokenWordSet.has(w));
    if (shared.length >= SELF_ECHO_MIN_SHARED_WORDS && shared.length / transcriptWords.length >= SELF_ECHO_MIN_CONTAINMENT) {
      return true;
    }
  }
  return false;
}

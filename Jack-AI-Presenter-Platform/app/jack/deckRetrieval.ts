import { findRelevantSections, tokenize } from "../lib/askJackProvider";
import type { ParsedDocument, ParsedSection } from "../session/types";
import type { PresentationContext } from "./presentationContext";

export interface RetrievalMatch {
  slideIndex: number;
  title: string;
  text: string;
  score: number;
  /** Human-readable reason this match was included -- current/previous/named
   * slide resolution, or the underlying keyword score. Not shown to the end
   * user; exists so retrieval decisions can be inspected/tested. */
  reason: string;
}

export type RetrievalConfidence = "high" | "medium" | "low";

export interface RetrievalResult {
  matches: RetrievalMatch[];
  confidence: RetrievalConfidence;
}

const CURRENT_SLIDE_RE = /\b(this|current)\s+slide\b/i;
const PREVIOUS_SLIDE_RE = /\b(previous|last|prior)\s+slide\b|\bslide\s+before\b/i;
const NAMES_A_SLIDE_RE = /\bslide\b|\bpage\b/i;

function scopedSections(docs: ParsedDocument[], activeFileId: string | null): ParsedSection[] {
  const scoped = activeFileId ? docs.filter((d) => d.fileId === activeFileId) : docs;
  return scoped.flatMap((d) => d.sections);
}

/**
 * Matches a query against known slide titles -- "what did the pricing slide
 * say?" -> the slide titled "Pricing". Only fires when the question actually
 * names a slide (contains "slide"/"page") to avoid an ordinary content word
 * that happens to coincide with a one-word slide title (e.g. a slide titled
 * "Team") hijacking an unrelated question. Requires a real, non-generic
 * title to work at all -- see pdf.ts's font-size heuristic for PDF decks.
 */
function findNamedSlide(question: string, docs: ParsedDocument[], activeFileId: string | null): RetrievalMatch | null {
  if (!NAMES_A_SLIDE_RE.test(question)) return null;
  const queryTerms = new Set(tokenize(question));
  if (queryTerms.size === 0) return null;

  let best: { section: ParsedSection; score: number } | null = null;
  for (const section of scopedSections(docs, activeFileId)) {
    if (!section.title) continue;
    const titleTerms = tokenize(section.title);
    if (titleTerms.length === 0) continue;
    const overlap = titleTerms.filter((t) => queryTerms.has(t)).length;
    if (overlap === 0) continue;
    const score = overlap / titleTerms.length; // fraction of the title's own words the question used
    if (!best || score > best.score) best = { section, score };
  }
  // At least half the title's words must appear in the question -- a
  // deliberately simple, explainable bar rather than a fuzzy similarity score.
  if (!best || best.score < 0.5) return null;

  return {
    slideIndex: best.section.index,
    title: best.section.title ?? `Slide ${best.section.index + 1}`,
    text: best.section.text,
    score: 999,
    reason: `named slide match: "${best.section.title}"`,
  };
}

/**
 * Single retrieval entry point for Jack's deck-aware Q&A. Tries deterministic
 * positional/named resolution first (cheap, explainable, no scoring needed);
 * falls back to the shared keyword scorer for everything else. Confidence is
 * derived from retrieval evidence alone -- the caller must not ask the LLM to
 * decide whether the deck covers the question when confidence is "low".
 */
// Real-time narration Q&A (Present/Practice) deliberately stays lean -- see
// PresentationContext's doc comment ("no whole-deck dump"). Ask Jack mode has
// no such constraint (no live narration to keep pace with) and its entire
// purpose is deep material knowledge, so it gets a much wider slice of the
// deck instead of just the top 3 keyword hits -- confirmed live that asking
// broad questions in Ask Jack was getting shallow answers grounded in only
// one or two slides when the deck had far more relevant material.
const DEFAULT_MATCH_LIMIT = 3;
const COMPREHENSIVE_MATCH_LIMIT = 10;

export function retrieveForQuestion(
  question: string,
  context: PresentationContext | null,
  docs: ParsedDocument[],
  activeFileId: string | null,
  comprehensive = false,
): RetrievalResult {
  // Guarded on real current-slide text existing, same as the previous-slide
  // branch below guards on previousSlideTitle -- Ask Jack mode's controller
  // always returns a non-null context (currentSlideNumber: 1) but always
  // fails getSlideContent, so currentSlideText is always "". Without this
  // guard, "what does this slide say?" in Ask Jack hijacked retrieval with a
  // bogus high-confidence EMPTY match before ever reaching the comprehensive
  // keyword search below, defeating the whole-deck-knowledge fix entirely.
  if (context && context.currentSlideText && CURRENT_SLIDE_RE.test(question)) {
    return {
      matches: [
        {
          slideIndex: context.currentSlideNumber - 1,
          title: context.currentSlideTitle ?? `Slide ${context.currentSlideNumber}`,
          text: context.currentSlideText,
          score: 999,
          reason: "current slide (explicit reference)",
        },
      ],
      confidence: "high",
    };
  }

  if (context && PREVIOUS_SLIDE_RE.test(question) && context.previousSlideTitle) {
    return {
      matches: [
        {
          slideIndex: context.currentSlideNumber - 2,
          title: context.previousSlideTitle,
          text: context.previousSlideText || "",
          score: 999,
          reason: "previous slide (explicit reference)",
        },
      ],
      confidence: context.previousSlideText ? "high" : "low",
    };
  }

  const named = findNamedSlide(question, docs, activeFileId);
  if (named) return { matches: [named], confidence: "high" };

  const terms = tokenize(question);
  const scored = findRelevantSections(question, docs, activeFileId, comprehensive ? COMPREHENSIVE_MATCH_LIMIT : DEFAULT_MATCH_LIMIT);
  if (terms.length === 0 || scored.length === 0) return { matches: [], confidence: "low" };

  const matches: RetrievalMatch[] = scored.map((s) => ({
    slideIndex: s.sectionIndex,
    title: s.title ?? `Slide ${s.sectionIndex + 1}`,
    text: s.text,
    score: s.score,
    reason: `keyword match (score ${s.score})`,
  }));

  // "high": several term hits or a title-boosted hit -- strong signal.
  // "medium": some overlap, but thin -- let the LLM hedge with inference language.
  // ("low" was already returned above when nothing scored at all.)
  const confidence: RetrievalConfidence = matches[0].score >= terms.length * 2 ? "high" : "medium";

  return { matches, confidence };
}

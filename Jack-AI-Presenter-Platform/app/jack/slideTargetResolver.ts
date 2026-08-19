import { tokenize } from "../lib/askJackProvider";
import type { ParsedSection } from "../session/types";

export type SlideTargetResolution =
  | { status: "resolved"; slideIndex: number; reason: "numeric" | "title-match" }
  | { status: "ambiguous"; candidates: { index: number; title?: string }[] }
  | { status: "not_found" };

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10,
};

/** "slide 5", "page 3", "slide five", "the 2nd slide" -> a 1-based slide number, or null.
 * Exported for deckRetrieval.ts, which uses this same extraction for Q&A
 * questions that reference a slide by number ("what does slide 12 say?"),
 * not just for jump_to_slide navigation. */
export function extractExplicitNumber(utterance: string): number | null {
  const lower = utterance.toLowerCase();

  const digitMatch = lower.match(/\b(?:slide|page|section)\s*(?:number|num|no\.?)?\s*#?\s*(\d+)\b/);
  if (digitMatch) return Number(digitMatch[1]);

  const digitOrdinalMatch = lower.match(/\b(\d+)(?:st|nd|rd|th)?\s*(?:slide|page|section)\b/);
  if (digitOrdinalMatch) return Number(digitOrdinalMatch[1]);

  const words = Object.keys(WORD_NUMBERS).join("|");
  // Same "number"/"no."/"num" infix tolerance as the digit regex above --
  // confirmed live that "Jack moves to slide number five" failed to resolve
  // (fell through to the LLM's target guess instead) because this regex
  // only ever matched "slide five", never "slide number five".
  const wordMatch = lower.match(new RegExp(`\\b(?:slide|page|section)\\s*(?:number|num|no\\.?)?\\s*(${words})\\b`));
  if (wordMatch) return WORD_NUMBERS[wordMatch[1]];

  const wordOrdinalMatch = lower.match(new RegExp(`\\b(${words})\\s*(?:slide|page|section)\\b`));
  if (wordOrdinalMatch) return WORD_NUMBERS[wordOrdinalMatch[1]];

  return null;
}

/**
 * Best-effort semantic query when the LLM didn't return a `target`: strip
 * common command verbs/fillers so "go back to the introduction" -> "introduction".
 */
function extractSemanticQuery(utterance: string): string {
  return utterance
    .replace(/\bjack\b/gi, "")
    .replace(/\b(go|jump|take me|navigate|move|show|go back|head)\b/gi, "")
    .replace(/\b(to|the|me|slide|page|section|please)\b/gi, "")
    .replace(/[.,!?]/g, "")
    .trim();
}

const TITLE_MATCH_WEIGHT = 3;
const TEXT_MATCH_WEIGHT = 1;

function scoreSection(queryTerms: string[], section: ParsedSection): number {
  if (queryTerms.length === 0) return 0;
  let score = 0;
  const titleHaystack = (section.title ?? "").toLowerCase();
  for (const term of queryTerms) {
    if (titleHaystack.includes(term)) score += TITLE_MATCH_WEIGHT;
  }
  // Text/notes only break ties when nothing matched a title at all --
  // "prefer strong title match" per spec, not an equal-weight signal.
  if (score === 0) {
    const textHaystack = `${section.text} ${section.speakerNotes ?? ""}`.toLowerCase();
    for (const term of queryTerms) {
      if (textHaystack.includes(term)) score += TEXT_MATCH_WEIGHT;
    }
  }
  return score;
}

/**
 * The one place jump_to_slide targets get resolved. Never guesses: an
 * unresolvable or multi-way-tied query returns not_found/ambiguous rather
 * than picking an arbitrary slide.
 */
export function resolveSlideTarget(
  utterance: string,
  llmTarget: string | undefined,
  sections: ParsedSection[],
): SlideTargetResolution {
  const explicitNumber = extractExplicitNumber(utterance);
  if (explicitNumber !== null) {
    const index = explicitNumber - 1;
    if (index >= 0 && index < sections.length) {
      return { status: "resolved", slideIndex: index, reason: "numeric" };
    }
    return { status: "not_found" };
  }

  const query = (llmTarget && llmTarget.trim()) || extractSemanticQuery(utterance);
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return { status: "not_found" };

  const scored = sections
    .map((section) => ({ index: section.index, title: section.title, score: scoreSection(queryTerms, section) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { status: "not_found" };

  const topScore = scored[0].score;
  const topCandidates = scored.filter((s) => s.score === topScore);

  if (topCandidates.length === 1) {
    return { status: "resolved", slideIndex: topCandidates[0].index, reason: "title-match" };
  }
  return {
    status: "ambiguous",
    candidates: topCandidates.map((c) => ({ index: c.index, title: c.title })),
  };
}

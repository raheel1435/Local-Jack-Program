import type { ParsedDocument } from "../session/types";

export interface AskJackAnswer {
  text: string;
  sourceExcerpts: { fileId: string; sectionIndex: number; snippet: string }[];
  confidence: "local-match" | "none";
}

export interface AskJackContext {
  docs: ParsedDocument[];
  activeFileId: string | null;
}

export interface AskJackProvider {
  ask(question: string, ctx: AskJackContext): Promise<AskJackAnswer>;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "what", "which", "who",
  "how", "does", "do", "did", "to", "of", "in", "on", "for", "and", "or",
  "about", "can", "you", "tell", "me", "this", "that", "with", "it",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

export function snippetAround(text: string, term: string, radius = 90): string {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export interface ScoredSection {
  fileId: string;
  sectionIndex: number;
  title?: string;
  text: string;
  score: number;
}

/** Shared scoring core reused by both the offline AskJackProvider fallback and Jack's real-time searchUploadedDocuments tool — one retrieval implementation, not two. */
export function findRelevantSections(
  query: string,
  docs: ParsedDocument[],
  activeFileId: string | null,
  limit = 3,
): ScoredSection[] {
  const terms = tokenize(query);
  const scopedDocs = activeFileId ? docs.filter((d) => d.fileId === activeFileId) : docs;
  if (terms.length === 0 || scopedDocs.length === 0) return [];

  const scored: ScoredSection[] = [];
  for (const doc of scopedDocs) {
    for (const section of doc.sections) {
      const haystack = `${section.title ?? ""} ${section.text}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        const matches = haystack.split(term).length - 1;
        score += matches * (section.title?.toLowerCase().includes(term) ? 3 : 1);
      }
      if (score > 0) {
        scored.push({ fileId: doc.fileId, sectionIndex: section.index, title: section.title, text: section.text, score });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Local, in-browser keyword search over already-extracted document text.
 * This is explicitly NOT an AI model — it's a transparent fallback used
 * because no real Jack API backend is connected yet. `getAskJackProvider()`
 * is the single seam to swap in a real backend later without touching the UI.
 */
export class LocalSearchAskJackProvider implements AskJackProvider {
  async ask(question: string, ctx: AskJackContext): Promise<AskJackAnswer> {
    const terms = tokenize(question);
    if (terms.length === 0 || ctx.docs.length === 0) {
      return {
        text: "I couldn't find anything to search — try asking about a specific topic from your uploaded material.",
        sourceExcerpts: [],
        confidence: "none",
      };
    }

    const top = findRelevantSections(question, ctx.docs, ctx.activeFileId);

    if (top.length === 0) {
      return {
        text: "I searched your uploaded material but couldn't find anything matching that question. Try rephrasing, or ask about one of the suggested topics.",
        sourceExcerpts: [],
        confidence: "none",
      };
    }

    const leadTerm = terms[0];

    const summary = top
      .map((s) => (s.title ? `In "${s.title}": ${snippetAround(s.text, leadTerm)}` : snippetAround(s.text, leadTerm)))
      .join("\n\n");

    return {
      text: `Here's what I found in your material (local keyword search, not an AI-generated answer):\n\n${summary}`,
      sourceExcerpts: top.map((s) => ({
        fileId: s.fileId,
        sectionIndex: s.sectionIndex,
        snippet: snippetAround(s.text, leadTerm),
      })),
      confidence: "local-match",
    };
  }
}

export function getAskJackProvider(): AskJackProvider {
  return new LocalSearchAskJackProvider();
}

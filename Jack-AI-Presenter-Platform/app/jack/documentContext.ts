import { findRelevantSections, snippetAround, tokenize } from "../lib/askJackProvider";
import type { DocumentSearchMatch } from "./presentationController";
import type { ParsedDocument } from "../session/types";

/** Wraps the existing local-search scoring (app/lib/askJackProvider.ts) for Jack's searchUploadedDocuments tool — no separate retrieval/chunking system. */
export function searchDocuments(
  query: string,
  docs: ParsedDocument[],
  activeFileId: string | null,
): DocumentSearchMatch[] {
  const terms = tokenize(query);
  const leadTerm = terms[0] ?? query;
  return findRelevantSections(query, docs, activeFileId).map((s) => {
    const doc = docs.find((d) => d.fileId === s.fileId);
    return {
      fileTitle: doc?.title ?? "Uploaded file",
      sectionTitle: s.title,
      snippet: snippetAround(s.text, leadTerm),
    };
  });
}

/** A compact, honest summary of what's actually available — used in Jack's system instructions. Never invents section counts. */
export function summarizeDocuments(docs: ParsedDocument[]): string {
  if (docs.length === 0) return "No documents have been uploaded yet.";
  return docs
    .map((doc) => `- "${doc.title}" (${doc.format}, ${doc.sectionCount} section${doc.sectionCount === 1 ? "" : "s"})`)
    .join("\n");
}

import type { FileKind, ParsedDocument } from "../../session/types";
import { parseDocx } from "./docx";
import { parsePdf } from "./pdf";
import { parsePptx } from "./pptx";
import { parseTxt } from "./txt";

const MAX_SUGGESTED_QUESTIONS = 6;

function deriveSuggestedQuestions(doc: ParsedDocument): string[] {
  const titled = doc.sections.filter((s) => s.title && s.title.trim().length > 0);
  const source = titled.length > 0 ? titled : doc.sections;
  return source.slice(0, MAX_SUGGESTED_QUESTIONS).map((s) => {
    const label = s.title?.trim() || `section ${s.index + 1}`;
    return `What can you tell me about "${label}"?`;
  });
}

function unsupportedDoc(file: File, format: ParsedDocument["format"], reason: string): ParsedDocument {
  return {
    fileId: "",
    format,
    title: file.name.replace(/\.[^.]+$/, ""),
    sectionCount: 0,
    sections: [],
    warnings: [reason],
    suggestedQuestions: [],
  };
}

/**
 * Parses a file into a ParsedDocument. Never runs on the server — callers
 * must only invoke this from client-side effects/event handlers.
 */
export async function parseFile(file: File, kind: FileKind): Promise<ParsedDocument> {
  let doc: ParsedDocument;

  switch (kind) {
    case "pdf":
      doc = await parsePdf(file);
      break;
    case "docx":
      doc = await parseDocx(file);
      break;
    case "pptx":
      doc = await parsePptx(file);
      break;
    case "txt":
      doc = await parseTxt(file);
      break;
    case "doc":
      return unsupportedDoc(
        file,
        "doc-unsupported",
        "Legacy .doc files use a binary format that can't be read in the browser. The file is kept in your session, but Jack can't extract its text — try re-saving it as .docx for full support.",
      );
    case "ppt":
      return unsupportedDoc(
        file,
        "doc-unsupported",
        "Legacy .ppt files use a binary format that can't be read in the browser. The file is kept in your session, but Jack can't extract its text — try re-saving it as .pptx for full support.",
      );
    default:
      return unsupportedDoc(file, "doc-unsupported", "This file format isn't supported.");
  }

  doc.suggestedQuestions = deriveSuggestedQuestions(doc);
  return doc;
}

export function isUnsupportedFormat(doc: ParsedDocument): boolean {
  return doc.format === "doc-unsupported";
}

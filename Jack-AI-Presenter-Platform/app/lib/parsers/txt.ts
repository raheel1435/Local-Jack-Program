import type { ParsedDocument, ParsedSection } from "../../session/types";

const MAX_WORDS_PER_SECTION = 120;

export async function parseTxt(file: File): Promise<ParsedDocument> {
  const text = await file.text();
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const sections: ParsedSection[] = [];
  if (paragraphs.length > 1) {
    paragraphs.forEach((text, i) => {
      sections.push({ id: crypto.randomUUID(), index: i, text, kind: "heading-section" });
    });
  } else {
    const words = text.split(/\s+/).filter(Boolean);
    for (let i = 0; i * MAX_WORDS_PER_SECTION < words.length; i++) {
      const chunk = words
        .slice(i * MAX_WORDS_PER_SECTION, (i + 1) * MAX_WORDS_PER_SECTION)
        .join(" ");
      sections.push({ id: crypto.randomUUID(), index: i, text: chunk, kind: "heading-section" });
    }
  }
  if (sections.length === 0) {
    sections.push({ id: crypto.randomUUID(), index: 0, text: "(This file is empty.)", kind: "heading-section" });
  }

  return {
    fileId: "",
    format: "txt",
    title: file.name.replace(/\.txt$/i, ""),
    sectionCount: sections.length,
    sections,
    warnings: [],
    suggestedQuestions: [],
  };
}

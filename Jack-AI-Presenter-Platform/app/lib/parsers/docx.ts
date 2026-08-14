import type { ParsedDocument, ParsedSection } from "../../session/types";

const MAX_WORDS_PER_FALLBACK_SECTION = 120;

export async function parseDocx(file: File): Promise<ParsedDocument> {
  const mammoth = (await import("mammoth")).default;
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });

  const doc = new DOMParser().parseFromString(result.value, "text/html");
  const sections: ParsedSection[] = [];

  const headingNodes = Array.from(doc.body.querySelectorAll("h1, h2, h3"));

  if (headingNodes.length > 0) {
    headingNodes.forEach((heading, i) => {
      const title = heading.textContent?.trim() || `Section ${i + 1}`;
      const textParts: string[] = [];
      let node = heading.nextElementSibling;
      while (node && !/^H[1-3]$/.test(node.tagName)) {
        const t = node.textContent?.trim();
        if (t) textParts.push(t);
        node = node.nextElementSibling;
      }
      sections.push({
        id: crypto.randomUUID(),
        index: i,
        title,
        text: textParts.join("\n\n") || title,
        kind: "heading-section",
      });
    });
  } else {
    const fullText = doc.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const words = fullText.split(" ").filter(Boolean);
    if (words.length === 0) {
      sections.push({
        id: crypto.randomUUID(),
        index: 0,
        text: "(No extractable text found in this document.)",
        kind: "heading-section",
      });
    } else {
      for (let i = 0; i * MAX_WORDS_PER_FALLBACK_SECTION < words.length; i++) {
        const chunk = words
          .slice(i * MAX_WORDS_PER_FALLBACK_SECTION, (i + 1) * MAX_WORDS_PER_FALLBACK_SECTION)
          .join(" ");
        sections.push({ id: crypto.randomUUID(), index: i, text: chunk, kind: "heading-section" });
      }
    }
  }

  const warnings: string[] = [];
  if (headingNodes.length === 0) {
    warnings.push(
      "No headings were detected, so this document was split into evenly sized reading chunks instead of true sections.",
    );
  }
  if (result.messages.some((m) => m.type === "warning")) {
    warnings.push("Some formatting could not be converted from the original document.");
  }

  return {
    fileId: "",
    format: "docx",
    title: file.name.replace(/\.docx$/i, ""),
    sectionCount: sections.length,
    sections,
    warnings,
    suggestedQuestions: [],
  };
}

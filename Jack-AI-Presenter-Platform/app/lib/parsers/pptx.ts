import type { ParsedDocument, ParsedSection } from "../../session/types";

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

function textOfSlideXml(doc: Document): { title: string | null; paragraphs: string[] } {
  let title: string | null = null;

  const shapes = Array.from(doc.getElementsByTagName("p:sp"));
  for (const shape of shapes) {
    const ph = shape.getElementsByTagName("p:ph")[0];
    const type = ph?.getAttribute("type");
    if (type === "title" || type === "ctrTitle") {
      const runs = Array.from(shape.getElementsByTagNameNS(A_NS, "t"));
      const text = runs.map((r) => r.textContent ?? "").join("").trim();
      if (text) title = text;
      break;
    }
  }

  const paragraphNodes = Array.from(doc.getElementsByTagNameNS(A_NS, "p"));
  const paragraphs: string[] = [];
  for (const p of paragraphNodes) {
    const runs = Array.from(p.getElementsByTagNameNS(A_NS, "t"));
    const text = runs.map((r) => r.textContent ?? "").join("").trim();
    if (text) paragraphs.push(text);
  }

  return { title, paragraphs };
}

export async function parsePptx(file: File): Promise<ParsedDocument> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const warnings: string[] = [];

  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path));

  if (slidePaths.length === 0) {
    return {
      fileId: "",
      format: "pptx",
      title: file.name.replace(/\.pptx?$/i, ""),
      sectionCount: 0,
      sections: [
        {
          id: crypto.randomUUID(),
          index: 0,
          text: "No slides could be found inside this file.",
          kind: "slide",
        },
      ],
      warnings: ["This file could not be read as a standard PowerPoint package."],
      suggestedQuestions: [],
    };
  }

  let orderedPaths = slidePaths;
  try {
    const presentationXml = await zip.file("ppt/presentation.xml")?.async("text");
    const relsXml = await zip.file("ppt/_rels/presentation.xml.rels")?.async("text");
    if (presentationXml && relsXml) {
      const presDoc = parseXml(presentationXml);
      const relsDoc = parseXml(relsXml);
      const relIdToTarget = new Map<string, string>();
      Array.from(relsDoc.getElementsByTagName("Relationship")).forEach((rel) => {
        const id = rel.getAttribute("Id");
        const target = rel.getAttribute("Target");
        if (id && target) relIdToTarget.set(id, `ppt/${target.replace(/^\.?\//, "")}`);
      });
      const sldIds = Array.from(presDoc.getElementsByTagName("p:sldId"));
      const ordered = sldIds
        .map((el) => el.getAttributeNS(REL_NS, "id") || el.getAttribute("r:id"))
        .map((rId) => (rId ? relIdToTarget.get(rId) : undefined))
        .filter((p): p is string => !!p && slidePaths.includes(p));
      if (ordered.length === slidePaths.length) orderedPaths = ordered;
    }
  } catch {
    // Fall back to filename order below; this is a best-effort ordering pass.
  }

  if (orderedPaths === slidePaths) {
    orderedPaths = [...slidePaths].sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      return na - nb;
    });
  }

  const sections: ParsedSection[] = [];
  for (let i = 0; i < orderedPaths.length; i++) {
    const path = orderedPaths[i];
    const xmlText = await zip.file(path)?.async("text");
    if (!xmlText) continue;
    const { title, paragraphs } = textOfSlideXml(parseXml(xmlText));

    const slideNumMatch = path.match(/slide(\d+)\.xml$/);
    const notesPath = slideNumMatch
      ? `ppt/notesSlides/notesSlide${slideNumMatch[1]}.xml`
      : null;
    let speakerNotes: string | undefined;
    if (notesPath && zip.file(notesPath)) {
      const notesXml = await zip.file(notesPath)!.async("text");
      const { paragraphs: notesParagraphs } = textOfSlideXml(parseXml(notesXml));
      const notesText = notesParagraphs.join("\n").trim();
      if (notesText) speakerNotes = notesText;
    }

    sections.push({
      id: crypto.randomUUID(),
      index: i,
      title: title ?? `Slide ${i + 1}`,
      text: paragraphs.join("\n") || "(No text on this slide.)",
      kind: "slide",
      speakerNotes,
    });
  }

  // No unconditional fallback warning here anymore -- this parser only ever
  // produces the semantic (Jack-context) reading, never the audience-facing
  // visual. PresentStage attempts a real PowerPoint-COM PPTX -> PDF
  // conversion for the visual and only shows a "simplified reading view"
  // warning if that conversion is actually unavailable or fails, so the
  // warning is never shown once real visual fidelity is working.

  return {
    fileId: "",
    format: "pptx",
    title: file.name.replace(/\.pptx?$/i, ""),
    sectionCount: sections.length,
    sections,
    warnings,
    suggestedQuestions: [],
  };
}

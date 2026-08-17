import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ParsedDocument, ParsedSection } from "../../session/types";

let workerConfigured = false;

/** Minimal shape we rely on from pdf.js's TextItem -- not importing the
 * library's internal type since it isn't re-exported from the package root. */
interface PdfTextRun {
  str: string;
  transform: number[];
}

/**
 * Picks a page title from the largest-font text run near the top of the
 * page. Presentation-exported PDFs (PowerPoint/Keynote/Slides -> PDF) are
 * almost always one slide per page with the heading as the biggest text on
 * the page, so this is a cheap, dependency-free stand-in for real slide
 * titles -- without it every PDF section title was the literal string
 * "Page N", which made title-boosted search and named-slide lookup
 * ("what did the pricing slide say?") silently useless for any PDF deck.
 */
function titleFromPageItems(items: PdfTextRun[]): string | null {
  const candidates = items
    .map((item) => ({ text: item.str.trim(), height: Math.abs(item.transform[3]) }))
    .filter((c) => c.text.length >= 3 && c.height > 0);
  if (candidates.length === 0) return null;

  const maxHeight = Math.max(...candidates.map((c) => c.height));
  // Runs within the same font-size band as the biggest text on the page,
  // in document order, joined -- a heading is often split into multiple
  // text runs (kerning/spacing) by pdf.js.
  const titleRuns = candidates.filter((c) => c.height >= maxHeight * 0.95);
  const title = titleRuns
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return title.length >= 3 ? title.slice(0, 120) : null;
}

async function loadPdfjs() {
  const pdfjsLib = await import("pdfjs-dist");
  if (!workerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).href;
    workerConfigured = true;
  }
  return pdfjsLib;
}

export async function parsePdf(file: File): Promise<ParsedDocument> {
  const pdfjsLib = await loadPdfjs();
  const data = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;

  const sections: ParsedSection[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const textRuns: PdfTextRun[] = textContent.items
        .filter((item) => "str" in item)
        .map((item) => ({ str: item.str, transform: item.transform }));
      const text = textRuns
        .map((item) => item.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      sections.push({
        id: crypto.randomUUID(),
        index: pageNumber - 1,
        title: titleFromPageItems(textRuns) ?? `Page ${pageNumber}`,
        text: text || "(No extractable text on this page.)",
        kind: "page",
      });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  return {
    fileId: "",
    format: "pdf",
    title: file.name.replace(/\.pdf$/i, ""),
    sectionCount: sections.length,
    sections,
    warnings: [],
    suggestedQuestions: [],
  };
}

export interface PdfRenderHandle {
  pdf: PDFDocumentProxy;
  destroy(): Promise<void>;
}

/**
 * Opens a fresh pdfjs document for rendering pages to canvas in PresentStage.
 * Caller must call `.destroy()` on unmount. Accepts any Blob, not just a
 * File -- a PPTX-origin PDF converted server-side (see jackApi.convertPptxToPdf)
 * renders through this exact same path as a native PDF upload.
 */
export async function openPdfForRender(file: Blob): Promise<PdfRenderHandle> {
  const pdfjsLib = await loadPdfjs();
  const data = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  return { pdf, destroy: () => loadingTask.destroy() };
}

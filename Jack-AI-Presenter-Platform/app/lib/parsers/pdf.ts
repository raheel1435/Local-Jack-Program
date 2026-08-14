import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ParsedDocument, ParsedSection } from "../../session/types";

let workerConfigured = false;

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
      const text = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      sections.push({
        id: crypto.randomUUID(),
        index: pageNumber - 1,
        title: `Page ${pageNumber}`,
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

/** Opens a fresh pdfjs document for rendering pages to canvas in PresentStage. Caller must call `.destroy()` on unmount. */
export async function openPdfForRender(file: File): Promise<PdfRenderHandle> {
  const pdfjsLib = await loadPdfjs();
  const data = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  return { pdf, destroy: () => loadingTask.destroy() };
}

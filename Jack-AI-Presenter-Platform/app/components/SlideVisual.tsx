"use client";

import { useEffect, useRef, useState } from "react";
import { jackApi } from "../lib/jackApi";
import { openPdfForRender, type PdfRenderHandle } from "../lib/parsers/pdf";
import type { ParsedDocument, ParsedSection, UploadedFile } from "../session/types";

/**
 * Real slide visual fidelity, shared by every mode that shows a slide
 * (Present, Practice) -- extracted from PresentStage so Practice mode gets
 * the exact same PDF/PowerPoint-COM rendering instead of a plain text-only
 * fallback. A native PDF upload renders directly; a .pptx upload attempts a
 * real PowerPoint-COM PPTX -> PDF conversion (see jackApi.convertPptxToPdf)
 * and renders THAT through the same canvas path, falling back to the
 * semantic-parser text view only if that conversion is unavailable or fails.
 */
export function SlideVisual({
  doc,
  activeFile,
  sectionIndex,
  currentSection,
}: {
  doc: ParsedDocument;
  activeFile: UploadedFile;
  sectionIndex: number;
  currentSection: ParsedSection | undefined;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdfHandle, setPdfHandle] = useState<PdfRenderHandle | null>(null);
  // Computed directly from doc.format at mount, not set synchronously inside
  // the conversion effect below -- see PresentStage's original comment on
  // this pattern (react-hooks/set-state-in-effect).
  const [pptxVisualStatus, setPptxVisualStatus] = useState<"idle" | "converting" | "ready" | "failed">(
    doc.format === "pptx" ? "converting" : "idle",
  );
  const [pptxVisualError, setPptxVisualError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (doc.format === "pdf") {
      openPdfForRender(activeFile.file).then((handle) => {
        if (cancelled) void handle.destroy();
        else setPdfHandle(handle);
      });
      return () => {
        cancelled = true;
      };
    }
    if (doc.format === "pptx") {
      jackApi
        .convertPptxToPdf(activeFile.file)
        .then((pdfBlob) => openPdfForRender(pdfBlob))
        .then((handle) => {
          if (cancelled) {
            void handle.destroy();
            return;
          }
          setPdfHandle(handle);
          setPptxVisualStatus("ready");
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setPptxVisualStatus("failed");
          setPptxVisualError(err instanceof Error ? err.message : "PPTX visual conversion failed.");
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [doc.format, activeFile]);

  useEffect(() => {
    return () => {
      void pdfHandle?.destroy();
    };
  }, [pdfHandle]);

  useEffect(() => {
    if (!pdfHandle) return;
    let cancelled = false;
    (async () => {
      const page = await pdfHandle.pdf.getPage(sectionIndex + 1);
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const containerWidth = canvas.parentElement?.clientWidth ?? 900;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, containerWidth / base.width) });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfHandle, sectionIndex]);

  if (doc.format === "pdf" || (doc.format === "pptx" && pptxVisualStatus === "ready")) {
    return <canvas ref={canvasRef} className="present-pdf-canvas" />;
  }
  if (doc.format === "pptx" && pptxVisualStatus === "converting") {
    return (
      <div className="present-text-slide present-visual-preparing">
        <p>Preparing your slides…</p>
      </div>
    );
  }
  return (
    <div className="present-text-slide">
      {currentSection?.title && <h2>{currentSection.title}</h2>}
      <p>{currentSection?.text}</p>
      {doc.format === "pptx" && pptxVisualStatus === "failed" && (
        <p className="present-warning" title={pptxVisualError ?? undefined}>
          Original PowerPoint formatting, images, and layout are not fully preserved — slide text and speaker notes are shown in a simplified reading view.
        </p>
      )}
    </div>
  );
}

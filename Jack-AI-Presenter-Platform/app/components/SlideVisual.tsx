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

// Council engineering audit finding: without this cache, every mount of this
// component for a .pptx file re-ran the full PowerPoint-COM conversion --
// switching Practice <-> Present for the SAME file, or leaving and
// re-entering Present mode, each burned one of the gateway's 3 AdmissionGate
// slots on a conversion whose result was already sitting unused in the
// component that just unmounted. Cached by Blob, not by PdfRenderHandle:
// PdfRenderHandle wraps a pdfjs document with its own destroy() lifecycle
// that this component's cleanup calls unconditionally on unmount, so sharing
// a live handle across mounts would need reference counting to avoid one
// mount destroying a handle another mount is still rendering from. Caching
// the Blob instead sidesteps that entirely -- each mount still calls
// openPdfForRender() itself to get its OWN independent handle, and only the
// expensive network/COM round trip is shared. Keyed by name+size+lastModified
// (not content hash -- files are re-uploaded fresh per session, never
// persisted, so this is a stable-enough identity within one browser tab's
// lifetime). Capped like this file's other session-scoped caches
// (JackProvider's asrDiagnostics) so re-uploading many different large decks
// across a long session can't grow this unboundedly.
const MAX_CACHED_PPTX_CONVERSIONS = 10;
const pptxConversionCache = new Map<string, Promise<Blob>>();

function pptxCacheKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

const MAX_VISIBLE_ERROR_LENGTH = 160;

/** Never let a failure reason (whatever produced it -- the gateway, a raw
 * COM/OS exception that slipped through some upstream layer, a future
 * failure mode nobody's anticipated yet) grow into an unbounded wall of
 * text inside the presentation view. The full string is still reachable
 * via the `title` tooltip this is paired with, so nothing is lost -- only
 * what's always-visible is capped. */
function truncateForDisplay(text: string): string {
  const singleLine = text.split(/\r?\n/)[0]?.trim() ?? text;
  return singleLine.length > MAX_VISIBLE_ERROR_LENGTH ? `${singleLine.slice(0, MAX_VISIBLE_ERROR_LENGTH)}…` : singleLine;
}

function getOrConvertPptxToPdf(file: File): Promise<Blob> {
  const key = pptxCacheKey(file);
  const cached = pptxConversionCache.get(key);
  if (cached) return cached;
  const promise = jackApi.convertPptxToPdf(file);
  // A failed conversion (busy gate, timeout, transient COM error) must NOT
  // poison the cache -- the next mount (or the same mount's own retry path)
  // should get a genuinely fresh attempt, not a cached rejection forever.
  promise.catch(() => {
    pptxConversionCache.delete(key);
  });
  if (pptxConversionCache.size >= MAX_CACHED_PPTX_CONVERSIONS) {
    const oldestKey = pptxConversionCache.keys().next().value;
    if (oldestKey !== undefined) pptxConversionCache.delete(oldestKey);
  }
  pptxConversionCache.set(key, promise);
  return promise;
}
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
      getOrConvertPptxToPdf(activeFile.file)
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
        <p className="present-warning">
          Original PowerPoint formatting, images, and layout are not fully preserved — slide text and speaker notes are shown in a simplified reading view.
          {/* Council engineering audit finding: this reason used to be captured
              (pptxVisualError) but only ever exposed via the HTML title
              tooltip, so a presenter had no visible way to tell "the local
              gateway isn't running" (fixable, actionable) apart from "your
              file is password-protected" (not fixable here) -- both showed
              the exact same generic sentence above. Now shown directly.
              PPTX visual-fallback fix (found live): the gateway is now the
              primary choke point for keeping this short (see
              pptxConvert.ts/convert-pptx-to-pdf.ps1), but this is a second,
              independent line of defense -- a raw multi-line COM exception
              was confirmed to render here as an unbounded wall of text that
              visually blended into the slide content above it. Truncating
              for display (full text still reachable via the title tooltip,
              so nothing is actually lost) means that can never recur here
              even from an unanticipated future failure mode upstream. */}
          {pptxVisualError && (
            <>
              <br />
              <span className="present-warning-reason" title={pptxVisualError}>
                Reason: {truncateForDisplay(pptxVisualError)}
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

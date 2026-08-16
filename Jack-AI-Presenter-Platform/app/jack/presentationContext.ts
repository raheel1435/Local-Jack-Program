import type { PresentationController } from "./presentationController";

/**
 * Compact, slide-aware context for Jack's local explain/summarize prompts.
 * Deliberately just the current/adjacent slide text + notes -- no whole-deck
 * dump, no vector retrieval. Built from the same PresentationController every
 * mode already exposes, so it works identically in Present/Practice.
 */
export interface PresentationContext {
  deckTitle: string;
  currentSlideNumber: number;
  totalSlides: number;
  currentSlideTitle?: string;
  currentSlideText: string;
  currentSlideNotes?: string | null;
  previousSlideTitle?: string;
  nextSlideTitle?: string;
}

export function buildPresentationContext(controller: PresentationController): PresentationContext | null {
  const ctx = controller.getPresentationContext();
  if (!ctx.success) return null;
  const { title, totalSlides, currentSlideIndex } = ctx.data;

  const current = controller.getSlideContent(currentSlideIndex);
  const notes = controller.getSpeakerNotes(currentSlideIndex);
  const prev = currentSlideIndex > 0 ? controller.getSlideContent(currentSlideIndex - 1) : null;
  const next = currentSlideIndex < totalSlides - 1 ? controller.getSlideContent(currentSlideIndex + 1) : null;

  return {
    deckTitle: title,
    currentSlideNumber: currentSlideIndex + 1,
    totalSlides,
    currentSlideTitle: current.success ? current.data.title : undefined,
    currentSlideText: current.success ? current.data.text : "",
    currentSlideNotes: notes.success ? notes.data.notes : null,
    previousSlideTitle: prev?.success ? prev.data.title : undefined,
    nextSlideTitle: next?.success ? next.data.title : undefined,
  };
}

export function formatContextForPrompt(ctx: PresentationContext): string {
  const lines = [
    `Deck: "${ctx.deckTitle}" -- slide ${ctx.currentSlideNumber} of ${ctx.totalSlides}${ctx.currentSlideTitle ? ` ("${ctx.currentSlideTitle}")` : ""}.`,
    `Slide content: ${ctx.currentSlideText || "(no extracted text)"}`,
  ];
  if (ctx.currentSlideNotes) lines.push(`Speaker notes: ${ctx.currentSlideNotes}`);
  if (ctx.previousSlideTitle) lines.push(`Previous slide: "${ctx.previousSlideTitle}"`);
  if (ctx.nextSlideTitle) lines.push(`Next slide: "${ctx.nextSlideTitle}"`);
  return lines.join("\n");
}

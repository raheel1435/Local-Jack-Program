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
  /** Full text of the previous slide, not just its title -- needed to actually
   * ground "what was on the previous slide?" instead of only being able to
   * name it. */
  previousSlideText?: string;
  nextSlideTitle?: string;
}

/**
 * `explicitSlideIndex` (0-based) overrides whatever the controller reports as
 * "current" -- required for the auto-advance narration loop, which calls
 * goToNextSlide() and must narrate the slide THAT CALL just moved to, not
 * whatever a still-not-yet-refreshed "current slide" ref happens to say a
 * moment later. React state updates (and the ref mirrors some callers use to
 * read them synchronously) are not visible until after the next render, so
 * querying "current" again immediately after changing it is a real race, not
 * a hypothetical one -- confirmed live as the cause of Jack narrating "slide
 * 2" while slide 3 was already on screen. goToNextSlide()/goToPreviousSlide()/
 * goToSlide() already return the authoritative new index in their result;
 * callers that just changed the slide must pass THAT value here rather than
 * letting this function re-derive "current" from the controller.
 */
export function buildPresentationContext(controller: PresentationController, explicitSlideIndex?: number): PresentationContext | null {
  const ctx = controller.getPresentationContext();
  if (!ctx.success) return null;
  const { title, totalSlides } = ctx.data;
  const currentSlideIndex = explicitSlideIndex ?? ctx.data.currentSlideIndex;

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
    previousSlideText: prev?.success ? prev.data.text : undefined,
    nextSlideTitle: next?.success ? next.data.title : undefined,
  };
}

/** Lean context for narration/explain/summarize -- previous/next slide are named only, not
 * dumped in full, so a small local model stays focused on narrating the CURRENT slide. */
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

/** Richer context for Q&A -- includes the previous slide's full text, since
 * "what was on the previous slide?" cannot be honestly answered from a title alone. */
export function formatContextForQA(ctx: PresentationContext): string {
  const lines = [
    `Deck: "${ctx.deckTitle}" -- slide ${ctx.currentSlideNumber} of ${ctx.totalSlides}${ctx.currentSlideTitle ? ` ("${ctx.currentSlideTitle}")` : ""}.`,
    `Current slide content: ${ctx.currentSlideText || "(no extracted text)"}`,
  ];
  if (ctx.currentSlideNotes) lines.push(`Speaker notes: ${ctx.currentSlideNotes}`);
  if (ctx.previousSlideTitle) {
    lines.push(`Previous slide ("${ctx.previousSlideTitle}"): ${ctx.previousSlideText || "(no extracted text)"}`);
  }
  if (ctx.nextSlideTitle) lines.push(`Next slide: "${ctx.nextSlideTitle}"`);
  return lines.join("\n");
}

import { tool } from "@openai/agents-realtime";
import { z } from "zod";
import type { PresentationController, ToolResult } from "./presentationController";

function toolOutput<T>(result: ToolResult<T>): string {
  return JSON.stringify(result);
}

/**
 * Builds Jack's presentation tools against whichever PresentationController is
 * currently registered. Tools are defined once; `getController` always returns
 * the live controller for the active stage (Present/Practice/Ask Jack), so
 * switching modes never requires redefining the tool set.
 */
export function createPresentationTools(getController: () => PresentationController) {
  return [
    tool({
      name: "getPresentationContext",
      description: "Get the presentation title, total slide/section count, current position, and active mode.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().getPresentationContext()),
    }),
    tool({
      name: "startPresentation",
      description: "Begin the presentation after the opening sequence has been confirmed by the presenter.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().startPresentation()),
    }),
    tool({
      name: "pausePresentation",
      description: "Pause the presentation and any auto-advance. Use when the presenter says 'pause', 'wait', or 'stop there'.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().pausePresentation()),
    }),
    tool({
      name: "resumePresentation",
      description: "Resume a paused presentation. Use when the presenter says 'continue' or 'resume'.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().resumePresentation()),
    }),
    tool({
      name: "endPresentation",
      description: "End the presentation session.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().endPresentation()),
    }),
    tool({
      name: "goToNextSlide",
      description: "Advance to the next slide or section.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().goToNextSlide()),
    }),
    tool({
      name: "goToPreviousSlide",
      description: "Go back to the previous slide or section.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().goToPreviousSlide()),
    }),
    tool({
      name: "goToSlide",
      description: "Jump directly to a specific slide or section by its 0-based index.",
      parameters: z.object({ index: z.number().int().min(0).describe("0-based slide/section index") }),
      execute: async (input) => toolOutput(getController().goToSlide(input.index)),
    }),
    tool({
      name: "getCurrentSlide",
      description: "Get the index and title of the slide currently being displayed.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().getCurrentSlide()),
    }),
    tool({
      name: "getSlideContent",
      description: "Get the extracted text content of a slide or section. Omit index to use the current slide.",
      parameters: z.object({ index: z.number().int().min(0).nullable().optional() }),
      execute: async (input) => toolOutput(getController().getSlideContent(input.index ?? undefined)),
    }),
    tool({
      name: "getSpeakerNotes",
      description: "Get the speaker notes for a slide, if any were extracted from the file. Omit index to use the current slide.",
      parameters: z.object({ index: z.number().int().min(0).nullable().optional() }),
      execute: async (input) => toolOutput(getController().getSpeakerNotes(input.index ?? undefined)),
    }),
    tool({
      name: "showSpeakerNotes",
      description: "Reveal the speaker notes panel to the presenter. Notes are never shown to the audience by default.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().showSpeakerNotes()),
    }),
    tool({
      name: "hideSpeakerNotes",
      description: "Hide the speaker notes panel.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().hideSpeakerNotes()),
    }),
    tool({
      name: "takePresentationControl",
      description: "Take control of slide navigation. Only valid in 'jackLeads' or 'shared' control mode, and only after an explicit handoff in shared mode.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().takePresentationControl()),
    }),
    tool({
      name: "handControlToPresenter",
      description: "Hand control of slide navigation back to the presenter.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().handControlToPresenter()),
    }),
    tool({
      name: "setPresentationPace",
      description: "Adjust how quickly you move through material for the rest of the session.",
      parameters: z.object({ pace: z.enum(["slower", "normal", "faster"]) }),
      execute: async (input) => toolOutput(getController().setPresentationPace(input.pace)),
    }),
    tool({
      name: "getRemainingTime",
      description: "Get the remaining time in the session, if a time budget was set. Returns null honestly if no timer is configured.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().getRemainingTime()),
    }),
    tool({
      name: "searchUploadedDocuments",
      description: "Search the presenter's uploaded documents for a topic. Use this before answering any question about the material's content.",
      parameters: z.object({ query: z.string().min(1) }),
      execute: async (input) => toolOutput(getController().searchUploadedDocuments(input.query)),
    }),
    tool({
      name: "showRelevantSource",
      description: "Highlight/display a specific source slide or section that answers a question, identified by file title and section title.",
      parameters: z.object({ fileTitle: z.string(), sectionTitle: z.string() }),
      execute: async (input) => toolOutput(getController().showRelevantSource(input.fileTitle, input.sectionTitle)),
    }),
    tool({
      name: "queueAudienceQuestion",
      description: "Record an audience question for moderated or deferred handling.",
      parameters: z.object({ question: z.string().min(1) }),
      execute: async (input) => toolOutput(getController().queueAudienceQuestion(input.question)),
    }),
    tool({
      name: "markQuestionForFollowUp",
      description: "Mark a previously queued question as needing follow-up after the session, by its id.",
      parameters: z.object({ id: z.string().min(1) }),
      execute: async (input) => toolOutput(getController().markQuestionForFollowUp(input.id)),
    }),
    tool({
      name: "syncJackToCurrentSlide",
      description: "Re-point your own context to whatever slide is currently displayed, resolving an out-of-sync state.",
      parameters: z.object({}),
      execute: async () => toolOutput(getController().syncJackToCurrentSlide()),
    }),
    tool({
      name: "setAudienceQuestionPolicy",
      description: "Change how audience questions are handled for the rest of the session.",
      parameters: z.object({ policy: z.enum(["askPresenterFirst", "jackAnswers", "presenterAnswers", "moderatedQueue"]) }),
      execute: async (input) => toolOutput(getController().setAudienceQuestionPolicy(input.policy)),
    }),
  ];
}

export type ToolResult<T> = { success: true; data: T } | { success: false; error: string };

export function ok<T>(data: T): ToolResult<T> {
  return { success: true, data };
}
export function fail<T = never>(error: string): ToolResult<T> {
  return { success: false, error };
}

export interface SlideInfo {
  index: number;
  total: number;
  title?: string;
}

export interface DocumentSearchMatch {
  fileTitle: string;
  sectionTitle?: string;
  snippet: string;
}

/**
 * The surface a stage (Present/Practice/Ask Jack) exposes to Jack's tools.
 * Every method returns a structured result — the model only learns an action
 * "succeeded" from this return value, never by assuming its own tool call worked.
 * Modes that don't support a given action return an honest failure rather than
 * silently no-opping.
 */
export interface PresentationController {
  readonly modeName: string;

  getPresentationContext(): ToolResult<{ title: string; totalSlides: number; currentSlideIndex: number; mode: string }>;
  startPresentation(): ToolResult<{ started: true }>;
  pausePresentation(): ToolResult<{ paused: true }>;
  resumePresentation(): ToolResult<{ resumed: true }>;
  endPresentation(): ToolResult<{ ended: true }>;

  goToNextSlide(): ToolResult<SlideInfo>;
  goToPreviousSlide(): ToolResult<SlideInfo>;
  goToSlide(index: number): ToolResult<SlideInfo>;
  getCurrentSlide(): ToolResult<SlideInfo>;
  getSlideContent(index?: number): ToolResult<{ index: number; title?: string; text: string }>;
  getSpeakerNotes(index?: number): ToolResult<{ index: number; notes: string | null }>;
  showSpeakerNotes(): ToolResult<{ shown: true }>;
  hideSpeakerNotes(): ToolResult<{ shown: false }>;

  takePresentationControl(): ToolResult<{ owner: "jack" }>;
  handControlToPresenter(): ToolResult<{ owner: "presenter" }>;
  setPresentationPace(pace: "slower" | "normal" | "faster"): ToolResult<{ pace: string }>;
  getRemainingTime(): ToolResult<{ remainingMs: number | null; message?: string }>;

  searchUploadedDocuments(query: string): ToolResult<{ matches: DocumentSearchMatch[] }>;
  showRelevantSource(fileTitle: string, sectionTitle: string): ToolResult<{ shown: true }>;

  queueAudienceQuestion(question: string): ToolResult<{ id: string }>;
  markQuestionForFollowUp(id: string): ToolResult<{ id: string }>;
  syncJackToCurrentSlide(): ToolResult<SlideInfo>;
  setAudienceQuestionPolicy(policy: string): ToolResult<{ policy: string }>;
}

export function unsupportedController(modeName: string): PresentationController {
  const notSupported = <T>(action: string) => fail<T>(`${action} isn't available in ${modeName} mode.`);
  return {
    modeName,
    getPresentationContext: () => notSupported("Getting presentation context"),
    startPresentation: () => notSupported("Starting the presentation"),
    pausePresentation: () => notSupported("Pausing"),
    resumePresentation: () => notSupported("Resuming"),
    endPresentation: () => notSupported("Ending the presentation"),
    goToNextSlide: () => notSupported("Moving to the next slide"),
    goToPreviousSlide: () => notSupported("Moving to the previous slide"),
    goToSlide: () => notSupported("Jumping to a slide"),
    getCurrentSlide: () => notSupported("Reading the current slide"),
    getSlideContent: () => notSupported("Reading slide content"),
    getSpeakerNotes: () => notSupported("Reading speaker notes"),
    showSpeakerNotes: () => notSupported("Showing speaker notes"),
    hideSpeakerNotes: () => notSupported("Hiding speaker notes"),
    takePresentationControl: () => notSupported("Taking control"),
    handControlToPresenter: () => notSupported("Handing back control"),
    setPresentationPace: () => notSupported("Changing pace"),
    getRemainingTime: () => notSupported("Reading remaining time"),
    searchUploadedDocuments: () => notSupported("Searching documents"),
    showRelevantSource: () => notSupported("Showing a source"),
    queueAudienceQuestion: () => notSupported("Queueing a question"),
    markQuestionForFollowUp: () => notSupported("Marking a question for follow-up"),
    syncJackToCurrentSlide: () => notSupported("Syncing to the current slide"),
    setAudienceQuestionPolicy: () => notSupported("Setting the audience question policy"),
  };
}

import type { JackState } from "../JackOrb";

export type StageId =
  | "upload"
  | "analysis"
  | "modeSelect"
  | "practice"
  | "present"
  | "askJack";

export type FileKind = "pdf" | "pptx" | "ppt" | "docx" | "doc" | "txt";

export type FileStatus = "queued" | "parsing" | "ready" | "unsupported" | "error";

export interface UploadedFile {
  id: string;
  file: File;
  name: string;
  size: number;
  kind: FileKind;
  status: FileStatus;
  error?: string;
}

export interface ParsedSection {
  id: string;
  index: number;
  title?: string;
  text: string;
  kind: "page" | "slide" | "heading-section";
  speakerNotes?: string;
}

export type ParsedFormat = "pdf" | "pptx" | "docx" | "txt" | "doc-unsupported";

export interface ParsedDocument {
  fileId: string;
  format: ParsedFormat;
  title: string;
  sectionCount: number;
  sections: ParsedSection[];
  warnings: string[];
  suggestedQuestions: string[];
}

export type AnalysisStep =
  | "reading"
  | "detecting-structure"
  | "preparing-guidance"
  | "identifying-questions"
  | "done"
  | "failed";

export interface AnalysisProgress {
  fileId: string;
  step: AnalysisStep;
  error?: string;
}

export type PresentMode = "practice" | "present" | "askJack";

/** "ready" is the PresentSetup screen (before the presenter clicks Start); PresentSession itself only ever holds presenting/paused/completed. */
export type PresentationStatus = "ready" | "presenting" | "paused" | "completed";

export interface SessionState {
  stage: StageId;
  jackState: JackState;
  files: UploadedFile[];
  parsedDocs: Record<string, ParsedDocument>;
  analysis: {
    started: boolean;
    activeFileId: string | null;
    progressByFile: Record<string, AnalysisProgress>;
    failedFileIds: string[];
  };
  activeMode: PresentMode | null;
  activeFileId: string | null;
}

export type SessionAction =
  | { type: "ADD_FILES"; files: UploadedFile[] }
  | { type: "REMOVE_FILE"; id: string }
  | { type: "START_ANALYSIS" }
  | { type: "ANALYSIS_FILE_ACTIVE"; fileId: string }
  | { type: "ANALYSIS_STEP"; fileId: string; step: AnalysisStep }
  | { type: "ANALYSIS_FILE_DONE"; fileId: string; doc: ParsedDocument }
  | { type: "ANALYSIS_FILE_UNSUPPORTED"; fileId: string; doc: ParsedDocument }
  | { type: "ANALYSIS_FILE_FAILED"; fileId: string; error: string }
  | { type: "ANALYSIS_RETRY_FILE"; fileId: string }
  | { type: "ANALYSIS_COMPLETE" }
  | { type: "SELECT_MODE"; mode: PresentMode }
  | { type: "SET_ACTIVE_FILE"; fileId: string }
  | { type: "BACK_TO_UPLOAD" }
  | { type: "BACK_TO_MODE_SELECT" }
  | { type: "SET_JACK_STATE"; jackState: JackState };

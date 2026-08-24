import type { SessionAction, SessionState } from "./types";

export const initialSessionState: SessionState = {
  stage: "upload",
  jackState: "available",
  files: [],
  parsedDocs: {},
  analysis: {
    started: false,
    activeFileId: null,
    progressByFile: {},
    failedFileIds: [],
  },
  activeMode: null,
  activeFileId: null,
};

export function sessionReducer(
  state: SessionState,
  action: SessionAction,
): SessionState {
  switch (action.type) {
    case "ADD_FILES": {
      if (action.files.length === 0) return state;
      return { ...state, files: [...state.files, ...action.files] };
    }

    case "REMOVE_FILE": {
      if (!state.files.some((f) => f.id === action.id)) return state;
      const files = state.files.filter((f) => f.id !== action.id);
      const parsedDocs = { ...state.parsedDocs };
      delete parsedDocs[action.id];
      const progressByFile = { ...state.analysis.progressByFile };
      delete progressByFile[action.id];
      const failedFileIds = state.analysis.failedFileIds.filter(
        (id) => id !== action.id,
      );
      if (files.length === 0) {
        return {
          ...initialSessionState,
        };
      }
      return {
        ...state,
        files,
        parsedDocs,
        analysis: { ...state.analysis, progressByFile, failedFileIds },
      };
    }

    case "START_ANALYSIS": {
      if (state.analysis.started) return state;
      return {
        ...state,
        stage: "analysis",
        jackState: "thinking",
        analysis: {
          started: true,
          activeFileId: null,
          progressByFile: {},
          failedFileIds: [],
        },
      };
    }

    case "ANALYSIS_FILE_ACTIVE": {
      return {
        ...state,
        analysis: { ...state.analysis, activeFileId: action.fileId },
        files: state.files.map((f) =>
          f.id === action.fileId ? { ...f, status: "parsing" } : f,
        ),
      };
    }

    case "ANALYSIS_STEP": {
      return {
        ...state,
        analysis: {
          ...state.analysis,
          progressByFile: {
            ...state.analysis.progressByFile,
            [action.fileId]: {
              fileId: action.fileId,
              step: action.step,
              detail: action.detail,
              narrationDone: action.narrationDone,
              narrationTotal: action.narrationTotal,
            },
          },
        },
      };
    }

    case "ANALYSIS_FILE_DONE": {
      return {
        ...state,
        parsedDocs: { ...state.parsedDocs, [action.fileId]: action.doc },
        files: state.files.map((f) =>
          f.id === action.fileId ? { ...f, status: "ready" } : f,
        ),
        analysis: {
          ...state.analysis,
          progressByFile: {
            ...state.analysis.progressByFile,
            [action.fileId]: { fileId: action.fileId, step: "done" },
          },
          failedFileIds: state.analysis.failedFileIds.filter(
            (id) => id !== action.fileId,
          ),
        },
      };
    }

    case "ANALYSIS_FILE_UNSUPPORTED": {
      return {
        ...state,
        parsedDocs: { ...state.parsedDocs, [action.fileId]: action.doc },
        files: state.files.map((f) =>
          f.id === action.fileId ? { ...f, status: "unsupported" } : f,
        ),
        analysis: {
          ...state.analysis,
          progressByFile: {
            ...state.analysis.progressByFile,
            [action.fileId]: { fileId: action.fileId, step: "done" },
          },
          failedFileIds: state.analysis.failedFileIds.filter(
            (id) => id !== action.fileId,
          ),
        },
      };
    }

    case "ANALYSIS_FILE_FAILED": {
      return {
        ...state,
        files: state.files.map((f) =>
          f.id === action.fileId
            ? { ...f, status: "error", error: action.error }
            : f,
        ),
        analysis: {
          ...state.analysis,
          progressByFile: {
            ...state.analysis.progressByFile,
            [action.fileId]: {
              fileId: action.fileId,
              step: "failed",
              error: action.error,
            },
          },
          failedFileIds: state.analysis.failedFileIds.includes(action.fileId)
            ? state.analysis.failedFileIds
            : [...state.analysis.failedFileIds, action.fileId],
        },
      };
    }

    case "ANALYSIS_RETRY_FILE": {
      return {
        ...state,
        files: state.files.map((f) =>
          f.id === action.fileId
            ? { ...f, status: "queued", error: undefined }
            : f,
        ),
        analysis: {
          ...state.analysis,
          failedFileIds: state.analysis.failedFileIds.filter(
            (id) => id !== action.fileId,
          ),
        },
      };
    }

    case "ANALYSIS_COMPLETE": {
      return { ...state, stage: "modeSelect", jackState: "available" };
    }

    case "SELECT_MODE": {
      const firstReadyFile =
        state.files.find(
          (f) => f.status === "ready" || f.status === "unsupported",
        )?.id ?? state.files[0]?.id ?? null;
      return {
        ...state,
        stage: action.mode,
        activeMode: action.mode,
        activeFileId: state.activeFileId ?? firstReadyFile,
      };
    }

    case "SET_ACTIVE_FILE": {
      return { ...state, activeFileId: action.fileId };
    }

    case "BACK_TO_UPLOAD": {
      // Reset analysis back to its pre-START_ANALYSIS shape (confirmed bug
      // fix): without this, `analysis.started` stayed true after returning
      // here, so a later START_ANALYSIS's own `if (state.analysis.started)
      // return state;` guard made "Next ->" a silent no-op forever -- the
      // only way out was removing every file (REMOVE_FILE's full-state
      // reset). Files/parsedDocs are untouched -- already-parsed content
      // shouldn't be thrown away just because the presenter went back to
      // add one more file.
      //
      // Found live (Chrome DevTools verification of the fix above): a file
      // interrupted mid-parse is left at status "parsing" forever -- the
      // in-flight AnalysisStage instance's own AbortController-equivalent
      // (cancelledRef) correctly stops it from ever dispatching
      // ANALYSIS_FILE_DONE for a stage the user already left, but nothing
      // else ever moves that file off "parsing" either. A LATER
      // AnalysisStage instance's effect only picks up files whose status is
      // exactly "queued" (`session.files.find(f => f.status === "queued")`),
      // so a "parsing" file is invisible to it -- re-entering Analysis then
      // shows "Waiting…" forever, forever, for that one file. Reset any
      // still-in-flight file back to "queued" so it's picked up again by
      // the next analysis run; already-resolved files (ready/unsupported/
      // error) are untouched.
      return {
        ...state,
        stage: "upload",
        jackState: "available",
        files: state.files.map((f) => (f.status === "parsing" ? { ...f, status: "queued" } : f)),
        analysis: {
          started: false,
          activeFileId: null,
          progressByFile: {},
          failedFileIds: [],
        },
      };
    }

    case "BACK_TO_MODE_SELECT": {
      return {
        ...state,
        stage: "modeSelect",
        activeMode: null,
        jackState: "available",
      };
    }

    case "SET_JACK_STATE": {
      if (state.jackState === action.jackState) return state;
      return { ...state, jackState: action.jackState };
    }

    default:
      return state;
  }
}

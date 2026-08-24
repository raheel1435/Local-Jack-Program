import assert from "node:assert/strict";
import test from "node:test";
import { sessionReducer, initialSessionState } from "../app/session/sessionReducer.ts";

// Regression coverage for CLAUDE-11: BACK_TO_UPLOAD used to leave
// analysis.started === true, which made a later START_ANALYSIS's own
// `if (state.analysis.started) return state;` guard a permanent no-op --
// "Next ->" silently did nothing after returning from Analysis to Upload.

function fakeFile(id, status = "ready") {
  return { id, file: {}, name: `${id}.pdf`, size: 1, kind: "pdf", status };
}

test("Analysis -> Back to Upload -> Next -> Analysis works, repeatedly", () => {
  let state = initialSessionState;
  state = sessionReducer(state, { type: "ADD_FILES", files: [fakeFile("a", "queued")] });
  state = sessionReducer(state, { type: "START_ANALYSIS" });
  assert.equal(state.stage, "analysis");
  assert.equal(state.analysis.started, true);

  // Presenter backs out to add another file.
  state = sessionReducer(state, { type: "BACK_TO_UPLOAD" });
  assert.equal(state.stage, "upload");
  assert.equal(state.analysis.started, false, "analysis.started must be reset so START_ANALYSIS isn't a no-op");

  // "Next ->" must actually re-enter analysis, not silently do nothing.
  state = sessionReducer(state, { type: "START_ANALYSIS" });
  assert.equal(state.stage, "analysis");
  assert.equal(state.analysis.started, true);

  // And the same cycle must work a second time, not just once.
  state = sessionReducer(state, { type: "BACK_TO_UPLOAD" });
  assert.equal(state.analysis.started, false);
  state = sessionReducer(state, { type: "START_ANALYSIS" });
  assert.equal(state.stage, "analysis");
});

test("BACK_TO_UPLOAD resets analysis progress/failure tracking but preserves already-parsed files/docs", () => {
  let state = initialSessionState;
  state = sessionReducer(state, { type: "ADD_FILES", files: [fakeFile("a", "queued")] });
  state = sessionReducer(state, { type: "START_ANALYSIS" });
  state = sessionReducer(state, { type: "ANALYSIS_FILE_ACTIVE", fileId: "a" });
  state = sessionReducer(state, {
    type: "ANALYSIS_FILE_DONE",
    fileId: "a",
    doc: { fileId: "a", format: "pdf", title: "A", sectionCount: 1, sections: [], warnings: [], suggestedQuestions: [] },
  });
  assert.equal(state.parsedDocs.a.title, "A");

  state = sessionReducer(state, { type: "BACK_TO_UPLOAD" });
  assert.deepEqual(state.analysis, { started: false, activeFileId: null, progressByFile: {}, failedFileIds: [] });
  // Already-parsed content must NOT be thrown away just because the
  // presenter went back to (e.g.) add one more file.
  assert.equal(state.parsedDocs.a.title, "A");
  assert.equal(state.files.length, 1);
});

test("BACK_TO_UPLOAD resets an interrupted 'parsing' file back to 'queued' so re-entering Analysis actually processes it (found live via Chrome DevTools verification of the fix above)", () => {
  let state = initialSessionState;
  state = sessionReducer(state, { type: "ADD_FILES", files: [fakeFile("a", "queued"), fakeFile("b", "ready")] });
  state = sessionReducer(state, { type: "START_ANALYSIS" });
  // Interrupted mid-parse: ANALYSIS_FILE_ACTIVE ran, but ANALYSIS_FILE_DONE
  // never did (the user backed out before it finished).
  state = sessionReducer(state, { type: "ANALYSIS_FILE_ACTIVE", fileId: "a" });
  assert.equal(state.files.find((f) => f.id === "a").status, "parsing");

  state = sessionReducer(state, { type: "BACK_TO_UPLOAD" });
  assert.equal(
    state.files.find((f) => f.id === "a").status,
    "queued",
    "an interrupted 'parsing' file must become visible to AnalysisStage's `session.files.find(f => f.status === 'queued')` again",
  );
  // An already-resolved file must be left alone -- no need to reprocess it.
  assert.equal(state.files.find((f) => f.id === "b").status, "ready");

  // And the full cycle actually re-processes it.
  state = sessionReducer(state, { type: "START_ANALYSIS" });
  assert.equal(state.stage, "analysis");
});

test("REMOVE_FILE is a genuine no-op (same state reference) for an id that doesn't exist", () => {
  const state = sessionReducer(initialSessionState, { type: "ADD_FILES", files: [fakeFile("a")] });
  const next = sessionReducer(state, { type: "REMOVE_FILE", id: "does-not-exist" });
  assert.equal(next, state, "expected the exact same state reference back for a no-op removal");
});

test("REMOVE_FILE of the last file fully resets to initialSessionState", () => {
  const state = sessionReducer(initialSessionState, { type: "ADD_FILES", files: [fakeFile("a")] });
  const next = sessionReducer(state, { type: "REMOVE_FILE", id: "a" });
  assert.deepEqual(next, initialSessionState);
});

import assert from "node:assert/strict";
import test from "node:test";
import { retrieveForQuestion } from "../app/jack/deckRetrieval.ts";
import { sessionReducer, initialSessionState } from "../app/session/sessionReducer.ts";

// Regression coverage for CLAUDE-10: AskJackStage's "Ask about:" dropdown
// used to update only local component state, never the global
// session.activeFileId that the real answer path (runLocalCommand ->
// answerDeckQuestion -> retrieveForQuestion) actually reads -- so picking a
// different file in the dropdown never changed which document actually
// grounded the answer. The fix makes session.activeFileId (dispatched via
// SET_ACTIVE_FILE) the single source of truth; these tests cover both
// halves of that fix: the reducer action, and the retrieval scoping it now
// correctly drives.

const docA = {
  fileId: "file-a",
  format: "pdf",
  title: "Alpha Deck",
  sectionCount: 1,
  sections: [{ id: "a1", index: 0, kind: "slide", title: "Alpha Pricing", text: "Alpha costs 99 SEK per month." }],
  warnings: [],
  suggestedQuestions: [],
};
const docB = {
  fileId: "file-b",
  format: "pdf",
  title: "Beta Deck",
  sectionCount: 1,
  sections: [{ id: "b1", index: 0, kind: "slide", title: "Beta Pricing", text: "Beta costs 249 SEK per month." }],
  warnings: [],
  suggestedQuestions: [],
};
const bothDocs = [docA, docB];
const noContext = { deckTitle: "", currentSlideNumber: 0, totalSlides: 0, currentSlideText: "" };

test("SET_ACTIVE_FILE dispatches to the global session state, accepting both a real id and null (\"all files\")", () => {
  let state = sessionReducer(initialSessionState, { type: "SET_ACTIVE_FILE", fileId: "file-a" });
  assert.equal(state.activeFileId, "file-a");
  state = sessionReducer(state, { type: "SET_ACTIVE_FILE", fileId: null });
  assert.equal(state.activeFileId, null);
});

test("scoping to file-a only ever surfaces file-a's content, never file-b's", () => {
  const result = retrieveForQuestion("What does it cost?", noContext, bothDocs, "file-a");
  assert.ok(result.matches.length > 0, "expected at least one match");
  for (const match of result.matches) {
    assert.equal(match.title, "Alpha Pricing", `expected every match to come from file-a's "Alpha Pricing" slide, got "${match.title}"`);
  }
});

test("scoping to file-b only ever surfaces file-b's content, never file-a's", () => {
  const result = retrieveForQuestion("What does it cost?", noContext, bothDocs, "file-b");
  assert.ok(result.matches.length > 0, "expected at least one match");
  for (const match of result.matches) {
    assert.equal(match.title, "Beta Pricing", `expected every match to come from file-b's "Beta Pricing" slide, got "${match.title}"`);
  }
});

test("with activeFileId null (\"All uploaded files\"), matches may come from either document", () => {
  const resultA = retrieveForQuestion("What is Alpha's price?", noContext, bothDocs, null);
  assert.ok(resultA.matches.some((m) => m.title === "Alpha Pricing"), "expected an Alpha-specific question to surface Alpha's slide even with no file scoped");
  const resultB = retrieveForQuestion("What is Beta's price?", noContext, bothDocs, null);
  assert.ok(resultB.matches.some((m) => m.title === "Beta Pricing"), "expected a Beta-specific question to surface Beta's slide even with no file scoped");
});

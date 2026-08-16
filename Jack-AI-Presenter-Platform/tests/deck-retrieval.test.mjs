import assert from "node:assert/strict";
import test from "node:test";
import { retrieveForQuestion } from "../app/jack/deckRetrieval.ts";
import { tokenize } from "../app/lib/askJackProvider.ts";

const sections = [
  { id: "s1", index: 0, kind: "slide", title: "Company Overview", text: "Acme operates in Sweden, Germany and France." },
  { id: "s2", index: 1, kind: "slide", title: "Revenue", text: "Revenue increased 18 percent in 2025. Europe increased 31 percent." },
  { id: "s3", index: 2, kind: "slide", title: "Customer Growth", text: "New customer acquisition increased 12 percent." },
  { id: "s4", index: 3, kind: "slide", title: "Pricing", text: "Starter: 99 SEK. Professional: 249 SEK. Enterprise: custom pricing." },
  { id: "s5", index: 4, kind: "slide", title: "Roadmap", text: "Roadmap includes mobile support and multilingual Jack." },
];

const docs = [
  { fileId: "test-deck", format: "pdf", title: "Acme Test Deck", sectionCount: sections.length, sections, warnings: [], suggestedQuestions: [] },
];

function contextAtSlide(i) {
  const s = sections[i];
  const prev = i > 0 ? sections[i - 1] : null;
  return {
    deckTitle: docs[0].title,
    currentSlideNumber: i + 1,
    totalSlides: sections.length,
    currentSlideTitle: s.title,
    currentSlideText: s.text,
    previousSlideTitle: prev?.title,
    previousSlideText: prev?.text,
    nextSlideTitle: sections[i + 1]?.title,
  };
}

function topTitle(question, atSlide = 0) {
  const result = retrieveForQuestion(question, contextAtSlide(atSlide), docs, "test-deck");
  return { title: result.matches[0]?.title, confidence: result.confidence };
}

test("finds the revenue slide for a direct revenue question", () => {
  assert.equal(topTitle("What was the revenue increase?").title, "Revenue");
});

test("finds the revenue slide for the Europe sub-fact, not just the top-level metric", () => {
  assert.equal(topTitle("What happened in Europe?").title, "Revenue");
});

test("finds the pricing slide for a plan-name question", () => {
  assert.equal(topTitle("How much is Professional?").title, "Pricing");
});

test("finds the overview slide for a geography question", () => {
  assert.equal(topTitle("Which countries does Acme operate in?").title, "Company Overview");
});

test("finds the roadmap slide for a feature-plan question", () => {
  assert.equal(topTitle("What is planned for mobile?").title, "Roadmap");
});

test("named-slide resolver: 'the customer slide' resolves via title, not just keyword overlap", () => {
  const result = retrieveForQuestion("What does the customer slide say?", contextAtSlide(0), docs, "test-deck");
  assert.equal(result.matches[0]?.title, "Customer Growth");
  assert.match(result.matches[0]?.reason ?? "", /named slide match/);
});

test("named-slide resolver: 'which slide talks about X' identifies the slide", () => {
  const result = retrieveForQuestion("Which slide talks about the roadmap?", contextAtSlide(0), docs, "test-deck");
  assert.equal(result.matches[0]?.title, "Roadmap");
});

test("unsupported question yields low confidence and no matches", () => {
  const result = retrieveForQuestion("What is the CEO's birthday?", contextAtSlide(0), docs, "test-deck");
  assert.equal(result.confidence, "low");
  assert.equal(result.matches.length, 0);
});

test("current-slide question deterministically resolves to the slide actually on screen", () => {
  // Standing on slide 4 (Pricing) but asking a generic "this slide" question --
  // must NOT fall through to keyword search, which would find nothing for "mean".
  const result = retrieveForQuestion("What does this slide mean?", contextAtSlide(3), docs, "test-deck");
  assert.equal(result.matches[0]?.title, "Pricing");
  assert.equal(result.confidence, "high");
});

test("previous-slide question uses real previous-slide TEXT, not just its title", () => {
  // Standing on slide 3 (Customer Growth); previous is Revenue.
  const result = retrieveForQuestion("What was on the previous slide?", contextAtSlide(2), docs, "test-deck");
  assert.equal(result.matches[0]?.title, "Revenue");
  assert.match(result.matches[0]?.text ?? "", /18 percent/);
  assert.equal(result.confidence, "high");
});

test("previous-slide question on slide 1 (no previous slide) yields low confidence, not a crash", () => {
  const result = retrieveForQuestion("What was on the previous slide?", contextAtSlide(0), docs, "test-deck");
  assert.equal(result.confidence, "low");
});

test("exact numeric fact (18 vs 17 percent) resolves to the slide that actually states it", () => {
  const result = retrieveForQuestion("Was revenue growth 17 or 18 percent?", contextAtSlide(0), docs, "test-deck");
  assert.equal(result.matches[0]?.title, "Revenue");
  assert.match(result.matches[0]?.text ?? "", /18 percent/);
});

test("tokenizer keeps numeric tokens usable for scoring (18% and 18 percent both yield '18')", () => {
  assert.ok(tokenize("18%").includes("18"));
  assert.ok(tokenize("18 percent").includes("18"));
});

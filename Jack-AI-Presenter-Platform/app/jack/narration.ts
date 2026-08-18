import { jackApi } from "../lib/jackApi";
import type { ParsedDocument } from "../session/types";
import { retrieveForQuestion } from "./deckRetrieval";
import { formatContextForPrompt, formatContextForQA, type PresentationContext } from "./presentationContext";

const NARRATION_SYSTEM_PROMPT_BASE =
  "You are Jack, an AI co-presenter narrating a slide deck out loud to a live audience. " +
  "Given the current slide's content, generate a short, natural spoken narration -- present " +
  "the ideas conversationally, don't read bullet points verbatim or list them mechanically. " +
  "Weave the key facts into 1-3 short sentences at presentation-appropriate pacing, faithful " +
  "to the slide content, and never invent facts not present on the slide. No preamble, no " +
  "\"Sure, here's...\", just the narration itself as if speaking live. Do not state the slide " +
  "number (e.g. \"slide 3\" or \"here we are at slide 2\") unless the slide content itself " +
  "makes that genuinely useful -- an audience doesn't need a running slide count. Stay grounded " +
  "in what THIS slide actually says; do not preview, summarize, or invent content belonging to " +
  "slides that haven't been shown yet, UNLESS this slide is itself an agenda/overview slide " +
  "whose whole purpose is to preview what's coming.";

/**
 * Opening vs continuation is a real, separate instruction to the model, not
 * just a UI-side flag (Phase 8-11/19 of the slide-sync milestone) --
 * confirmed live that without this distinction, "Continue" after a pause
 * could produce a fresh "Hello everyone, today we're excited to..." because
 * nothing ever told the model it had already introduced itself.
 */
export function narrationSystemPrompt(isOpening: boolean, humourEnabled: boolean): string {
  if (isOpening) {
    return (
      NARRATION_SYSTEM_PROMPT_BASE +
      " This is the very first thing you will say to the audience for this presentation -- " +
      "start with one brief self-introduction (e.g. \"Hello everyone, I'm Jack, and I'll be " +
      "helping present today.\")" +
      (humourEnabled ? ", with one light touch of humour if it fits naturally" : "") +
      ", then move straight into narrating this slide. Keep the introduction to one short sentence."
    );
  }
  return (
    NARRATION_SYSTEM_PROMPT_BASE +
    " You have ALREADY introduced yourself for this presentation earlier -- do NOT say hello to " +
    "the audience again, do NOT reintroduce yourself as Jack, do NOT say anything like \"today " +
    "we're excited to...\" or any other opening-style line. Go straight into narrating this " +
    "slide's content as a natural continuation of an already-running presentation."
  );
}

/** Central narration generator -- the only place that turns a slide into spoken words. */
export async function generateSlideNarration(
  context: PresentationContext,
  isOpening: boolean,
  humourEnabled: boolean,
): Promise<string> {
  const prompt = `${formatContextForPrompt(context)}\n\nNarrate this slide now.`;
  const result = await jackApi.chat(
    [
      { role: "system", content: narrationSystemPrompt(isOpening, humourEnabled) },
      { role: "user", content: prompt },
    ],
    { maxTokens: 160, temperature: 0.5 },
  );
  return result.content.trim();
}

const NOT_COVERED_ANSWER = "That isn't covered in this presentation.";

const QA_SYSTEM_PROMPT_HIGH =
  "You are Jack, an AI co-presenter answering a question about the current deck during a " +
  "live presentation. The material below has been confirmed to directly relate to this " +
  "question -- use it to answer directly and concisely (1-3 sentences). Preserve exact " +
  "numbers, percentages, and prices from the material exactly as written -- never round, " +
  "recalculate, or substitute a different figure. If the material only supports a reasonable " +
  "inference rather than a directly stated fact, say so briefly (e.g. \"The slide suggests...\"). " +
  "Never invent facts not present in the material provided.";

const QA_SYSTEM_PROMPT_MEDIUM =
  "You are Jack, an AI co-presenter answering a question about the current deck during a " +
  "live presentation. You are given the current slide's content plus the most relevant " +
  "matching sections found elsewhere in the deck. Answer using ONLY this material. If the " +
  "answer is directly stated, answer directly and concisely (1-3 sentences), preserving exact " +
  "numbers, percentages, and prices exactly as written. If it's a reasonable inference from " +
  'the material, say so briefly. If, after reviewing the material, it genuinely does not ' +
  'address the question, say plainly: "' + NOT_COVERED_ANSWER + '" Never invent facts not ' +
  "present in the material provided.";

/**
 * Used when retrieval found nothing relevant AND the remark itself doesn't
 * even reference the deck (see DECK_REFERENCE_RE / QA_SYSTEM_PROMPT_NO_MATERIAL
 * below for the other half of this split). Deliberately does not mention
 * NOT_COVERED_ANSWER anywhere in this prompt: confirmed live against the
 * small local model (qwen2.5-1.5b) that simply INCLUDING that exact phrase
 * as a quoted "if genuinely unrelated, say X" escape hatch was enough for
 * the model to default to it even for a plain "Jack, are you listening?" --
 * a weak model gravitates to the lowest-risk literal string handed to it in
 * the prompt, regardless of the surrounding conditional logic. The fix is
 * structural, not a wording tweak: keep this prompt entirely free of that
 * phrase so there's nothing for the model to default to.
 */
const QA_SYSTEM_PROMPT_CONVERSATIONAL =
  "You are Jack, a friendly AI co-presenter. The presenter or an audience member just said " +
  "something to you during a live presentation -- a remark, greeting, or check-in, not a " +
  "question about the slide deck's content. Respond naturally and briefly (1-2 short " +
  "sentences), the way a helpful co-presenter would when spoken to directly.";

/**
 * Used when retrieval found nothing relevant, but the remark itself
 * references the deck (contains "slide", "presentation", etc.) -- likely a
 * genuine content question the deck just doesn't answer, so NOT_COVERED_ANSWER
 * stays available here as the deliberate outcome, not a lazy default.
 */
const QA_SYSTEM_PROMPT_NO_MATERIAL =
  "You are Jack, an AI co-presenter answering a question about the current deck during a live " +
  "presentation. Nothing in the slide deck matched this question well enough to quote from. If, " +
  "after considering it, this genuinely seems to be asking about the deck's content, say plainly: " +
  '"' +
  NOT_COVERED_ANSWER +
  '" Never invent facts about the deck\'s content. Keep the reply to 1-2 short sentences.';

/** Cheap, deterministic signal for whether an unmatched remark is even
 * trying to ask about the deck at all -- see QA_SYSTEM_PROMPT_CONVERSATIONAL's
 * comment for why this split exists instead of a single LLM-judged prompt. */
const DECK_REFERENCE_RE = /\b(slide|slides|deck|presentation|page|pages|section|sections)\b/i;

export interface DeckAnswer {
  answer: string;
  /** True if retrieval found material beyond a bare current-slide fallback. */
  grounded: boolean;
  confidence: "high" | "medium" | "low";
}

/**
 * Deterministic/lightweight retrieval (see deckRetrieval.ts) + LLM answer
 * grounded in it -- no vector DB. Whether the deck "covers" the question is
 * decided by retrieval evidence, not the LLM's guess: when nothing matches,
 * we never call the model at all, so it can't hedge, hallucinate, or ignore
 * weak material and still return the honest unsupported answer directly.
 */
export async function answerDeckQuestion(
  question: string,
  context: PresentationContext,
  docs: ParsedDocument[],
  activeFileId: string | null,
  comprehensive = false,
): Promise<DeckAnswer> {
  const retrieval = retrieveForQuestion(question, context, docs, activeFileId, comprehensive);
  const matches = retrieval.matches;

  // No deck material matched -- still let the LLM assess and answer (see
  // QA_SYSTEM_PROMPT_NO_MATERIAL's comment): a lot of real speech directed
  // at Jack was never a deck question in the first place.
  if (retrieval.confidence === "low") {
    const soundsLikeDeckQuestion = DECK_REFERENCE_RE.test(question);
    const systemPrompt = soundsLikeDeckQuestion ? QA_SYSTEM_PROMPT_NO_MATERIAL : QA_SYSTEM_PROMPT_CONVERSATIONAL;
    const prompt = soundsLikeDeckQuestion
      ? `${formatContextForQA(context)}\n\nSomething was said that didn't match any deck content:\n"${question}"`
      : `Something was just said to you during the presentation:\n"${question}"`;
    const result = await jackApi.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      { maxTokens: 120, temperature: 0.4 },
    );
    return { answer: result.content.trim(), grounded: false, confidence: "low" };
  }

  const materialParts = [formatContextForQA(context)];
  if (matches.length > 0) {
    materialParts.push(
      "Relevant material found in the deck:\n" +
        matches.map((m) => `- "${m.title}": ${m.text}`).join("\n"),
    );
  }
  const prompt = `${materialParts.join("\n\n")}\n\nQuestion: ${question}`;
  const systemPrompt = retrieval.confidence === "high" ? QA_SYSTEM_PROMPT_HIGH : QA_SYSTEM_PROMPT_MEDIUM;
  const result = await jackApi.chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    // Comprehensive mode (Ask Jack) draws on more material and deserves room
    // for a fuller answer -- capping it at the same 180 tokens used for a
    // lean, single-slide, real-time narration answer risked truncating a
    // genuinely thorough answer mid-sentence.
    { maxTokens: comprehensive ? 320 : 180, temperature: 0.3 },
  );
  return { answer: result.content.trim(), grounded: matches.length > 0, confidence: retrieval.confidence };
}

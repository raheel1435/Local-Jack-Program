import { jackApi } from "../lib/jackApi";
import type { ParsedDocument } from "../session/types";
import { retrieveForQuestion } from "./deckRetrieval";
import { formatContextForPrompt, formatContextForQA, type PresentationContext } from "./presentationContext";

const NARRATION_SYSTEM_PROMPT =
  "You are Jack, an AI co-presenter narrating a slide deck out loud to a live audience. " +
  "Given the current slide's content, generate a short, natural spoken narration -- present " +
  "the ideas conversationally, don't read bullet points verbatim or list them mechanically. " +
  "Weave the key facts into 1-3 short sentences at presentation-appropriate pacing, faithful " +
  "to the slide content, and never invent facts not present on the slide. No preamble, no " +
  "\"Sure, here's...\", just the narration itself as if speaking live.";

/** Central narration generator -- the only place that turns a slide into spoken words. */
export async function generateSlideNarration(context: PresentationContext): Promise<string> {
  const prompt = `${formatContextForPrompt(context)}\n\nNarrate this slide now.`;
  const result = await jackApi.chat(
    [
      { role: "system", content: NARRATION_SYSTEM_PROMPT },
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
): Promise<DeckAnswer> {
  const retrieval = retrieveForQuestion(question, context, docs, activeFileId);

  if (retrieval.confidence === "low") {
    return { answer: NOT_COVERED_ANSWER, grounded: false, confidence: "low" };
  }

  const materialParts = [formatContextForQA(context)];
  const matches = retrieval.matches;
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
    { maxTokens: 180, temperature: 0.3 },
  );
  return { answer: result.content.trim(), grounded: matches.length > 0, confidence: retrieval.confidence };
}

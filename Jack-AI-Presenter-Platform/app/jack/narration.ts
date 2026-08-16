import { findRelevantSections } from "../lib/askJackProvider";
import { jackApi } from "../lib/jackApi";
import type { ParsedDocument } from "../session/types";
import { formatContextForPrompt, type PresentationContext } from "./presentationContext";

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

const QA_SYSTEM_PROMPT =
  "You are Jack, an AI co-presenter answering a question about the current deck during a " +
  "live presentation. You are given the current slide's content plus the most relevant " +
  "matching sections found elsewhere in the deck. Answer using ONLY this material. If the " +
  "answer is directly stated, answer directly and concisely (1-3 sentences). If it's a " +
  'reasonable inference from the material, say so briefly. If the material does not cover ' +
  'the question at all, say plainly: "That isn\'t covered in this presentation." Never ' +
  "invent facts not present in the material provided.";

export interface DeckAnswer {
  answer: string;
  /** True if lightweight keyword search found supporting material beyond the current slide. */
  grounded: boolean;
}

/** Deterministic/lightweight retrieval (existing keyword scorer) + LLM answer grounded in it -- no vector DB. */
export async function answerDeckQuestion(
  question: string,
  context: PresentationContext,
  docs: ParsedDocument[],
  activeFileId: string | null,
): Promise<DeckAnswer> {
  const matches = findRelevantSections(question, docs, activeFileId, 3);
  const materialParts = [formatContextForPrompt(context)];
  if (matches.length > 0) {
    materialParts.push(
      "Other relevant sections found in the deck:\n" +
        matches.map((m) => `- ${m.title ? `"${m.title}": ` : ""}${m.text}`).join("\n"),
    );
  }
  const prompt = `${materialParts.join("\n\n")}\n\nQuestion: ${question}`;
  const result = await jackApi.chat(
    [
      { role: "system", content: QA_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    { maxTokens: 180, temperature: 0.3 },
  );
  return { answer: result.content.trim(), grounded: matches.length > 0 };
}

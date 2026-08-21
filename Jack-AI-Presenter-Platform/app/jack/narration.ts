import { jackApi } from "../lib/jackApi";
import type { ParsedDocument } from "../session/types";
import { retrieveForQuestion } from "./deckRetrieval";
import { formatContextForPrompt, formatContextForQA, type PresentationContext } from "./presentationContext";

/**
 * Pure validity check for a prefetched next-slide opening (latency-fix
 * milestone) -- kept here (not in JackProvider.tsx, which uses it) so it's
 * importable from a plain .ts test without needing a JSX-capable loader. A
 * prefetch is only ever usable for the EXACT (generation, slideIndex) it
 * was started for: generation already changes on every pause/interrupt/
 * jump/handoff/stop (see JackProvider's cancelAutonomousPresenting), so
 * this alone is what guarantees a slide is never narrated from a stale
 * prefetch. Never valid for the very first (isOpening) slide -- nothing
 * precedes it to prefetch during.
 */
export function isPrefetchValid(
  prefetch: { generation: number; slideIndex: number } | null,
  current: { isOpening: boolean; generation: number; slideIndex: number },
): boolean {
  if (current.isOpening || !prefetch) return false;
  return prefetch.generation === current.generation && prefetch.slideIndex === current.slideIndex;
}

// Comprehensive mode (Ask Jack) can include up to 10 full-section matches in
// one prompt (see deckRetrieval's COMPREHENSIVE_MATCH_LIMIT) -- with no cap,
// a handful of genuinely long slides could bloat the assembled prompt well
// past the small local model's context window, silently truncating material
// server-side or degrading answer quality, defeating the whole point of
// giving Ask Jack more material to draw on. Capping each match's own text
// keeps the total bounded regardless of match count or slide length.
const MAX_MATCH_TEXT_CHARS = 600;

/**
 * Truncates at the last word boundary at/before the cap, not a hard
 * character cut -- QA_SYSTEM_PROMPT_HIGH/MEDIUM explicitly promise to
 * preserve numbers/percentages/prices exactly as written, so slicing mid-
 * token could chop "$1,234,567" into "$1,234,5…" and either strand the
 * model without the real figure or invite it to guess one, which is exactly
 * what those prompts are trying to prevent.
 */
function truncateForPrompt(text: string): string {
  if (text.length <= MAX_MATCH_TEXT_CHARS) return text;
  const cut = text.slice(0, MAX_MATCH_TEXT_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  // Only back off to the last space if it's not absurdly far from the cap
  // (a single very long token with no spaces at all falls back to the hard
  // cut rather than returning almost nothing).
  let safe = lastSpace > MAX_MATCH_TEXT_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut;
  // A hard cut can still land inside a UTF-16 surrogate pair (an emoji or
  // other astral character) -- trim the trailing lone high surrogate rather
  // than ship a broken code unit to the model.
  const lastCode = safe.charCodeAt(safe.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) safe = safe.slice(0, -1);
  return `${safe}…`;
}

// Multi-persona milestone: the assistant introduces itself and answers to
// whichever name is currently selected (Bella/Adam/Nova/Sarah/George/Emma/
// Jack/...), not always literally "Jack" -- see voiceSettings.ts's
// VOICE_OPTIONS, which the name is resolved from in JackProvider. Every
// prompt below is templated with the literal word "Jack" and swapped via
// this helper at build time, rather than restructuring each string, so the
// prompts keep reading naturally for any name.
function withAssistantName(template: string, name: string): string {
  const n = name.trim() || "Jack";
  return template.replace(/\bJack\b/g, n);
}

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
export function narrationSystemPrompt(isOpening: boolean, humourEnabled: boolean, assistantName = "Jack"): string {
  if (isOpening) {
    return withAssistantName(
      NARRATION_SYSTEM_PROMPT_BASE +
        " This is the very first thing you will say to the audience for this presentation -- " +
        "start with one brief self-introduction (e.g. \"Hello everyone, I'm Jack, and I'll be " +
        "helping present today.\")" +
        (humourEnabled ? ", with one light touch of humour if it fits naturally" : "") +
        ", then move straight into narrating this slide. Keep the introduction to one short sentence.",
      assistantName,
    );
  }
  return withAssistantName(
    NARRATION_SYSTEM_PROMPT_BASE +
      " You have ALREADY introduced yourself for this presentation earlier -- do NOT say hello to " +
      "the audience again, do NOT reintroduce yourself as Jack, do NOT say anything like \"today " +
      "we're excited to...\" or any other opening-style line. Go straight into narrating this " +
      "slide's content as a natural continuation of an already-running presentation.",
    assistantName,
  );
}

/** Central narration generator -- the only place that turns a slide into spoken words. */
export async function generateSlideNarration(
  context: PresentationContext,
  isOpening: boolean,
  humourEnabled: boolean,
  assistantName = "Jack",
): Promise<string> {
  const prompt = `${formatContextForPrompt(context)}\n\nNarrate this slide now.`;
  const result = await jackApi.chat(
    [
      { role: "system", content: narrationSystemPrompt(isOpening, humourEnabled, assistantName) },
      { role: "user", content: prompt },
    ],
    { maxTokens: 160, temperature: 0.5 },
  );
  return result.content.trim();
}

/**
 * Progressive narration (latency-fix milestone): generateSlideNarration
 * above waits for the model to finish the WHOLE narration (up to 160
 * tokens) before anything can be spoken. jackApi.chat/jackApi.speak are
 * both single-shot request/response (no token or audio streaming -- see
 * LlamaCppProvider.chat and KokoroProvider.speak), so the only real lever
 * for time-to-first-audible-speech is generating and synthesizing LESS
 * text before speech starts. generateNarrationOpening produces one short,
 * slide-grounded sentence with a small max_tokens budget (fast on both the
 * LLM and TTS side); generateNarrationContinuation produces whatever's left
 * to say, told explicitly what was already spoken so it never repeats it.
 * The caller (runNarrationStep) speaks the opening immediately and
 * generates+synthesizes the continuation in parallel with that playback.
 */
export async function generateNarrationOpening(
  context: PresentationContext,
  isOpening: boolean,
  humourEnabled: boolean,
  assistantName = "Jack",
): Promise<string> {
  const prompt =
    `${formatContextForPrompt(context)}\n\n` +
    "Give ONE short opening sentence to start narrating this slide -- grounded in a specific " +
    "fact or idea actually on the slide (never a generic \"now we're on slide N\" announcement). " +
    "8-18 words. Nothing else, just that one sentence.";
  const result = await jackApi.chat(
    [
      { role: "system", content: narrationSystemPrompt(isOpening, humourEnabled, assistantName) },
      { role: "user", content: prompt },
    ],
    { maxTokens: 48, temperature: 0.5 },
  );
  return result.content.trim();
}

export async function generateNarrationContinuation(
  context: PresentationContext,
  openingSentence: string,
  humourEnabled: boolean,
  assistantName = "Jack",
): Promise<string> {
  const prompt =
    `${formatContextForPrompt(context)}\n\n` +
    `You already said, out loud, to the audience: "${openingSentence}"\n\n` +
    "They already heard that -- saying it again in different words is a real mistake, not a " +
    'style choice. For example, if you already said "The market is worth $40 billion by 2030", ' +
    'do NOT follow it with "The addressable market is estimated at $40 billion by 2030" -- that ' +
    "is the same fact restated, not new information. Add ONLY facts/details from this slide that " +
    "were NOT in that opening line (1-2 short sentences). If every fact on this slide is already " +
    "covered by the opening line, reply with nothing at all -- an empty response is correct and " +
    "expected here, not a failure.";
  const result = await jackApi.chat(
    [
      // The self-introduction (if any) was already handled by the opening
      // call -- a continuation must never repeat/redo it, so this always
      // uses the non-opening system prompt regardless of the slide's own
      // isOpening flag.
      { role: "system", content: narrationSystemPrompt(false, humourEnabled, assistantName) },
      { role: "user", content: prompt },
    ],
    { maxTokens: 120, temperature: 0.5 },
  );
  return result.content.trim();
}

/**
 * Deterministic backstop for generateNarrationContinuation's prompt
 * instruction: a small local model (Qwen2.5-1.5B here) does not reliably
 * follow "don't repeat the opening" -- confirmed live, it sometimes restates
 * the same fact in paraphrased words instead of adding anything new. Rather
 * than trust the model's judgment alone, measure real word overlap between
 * the two sentences; a continuation that's mostly the same words as the
 * opening is treated as a repeat and dropped by the caller, same as an
 * empty response. Deliberately simple (normalized word-set overlap, no NLP
 * dependency) -- this only needs to catch near-duplicates, not paraphrase
 * detection in general.
 */
export function isRedundantContinuation(openingSentence: string, continuation: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9']+/g) ?? []);
  const a = words(openingSentence);
  const b = words(continuation);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const w of b) if (a.has(w)) shared++;
  // Overlap relative to the SHORTER sentence's word count -- a short
  // continuation that's almost entirely made of words already in the
  // (usually longer) opening is the repeat pattern actually observed live;
  // a longer continuation that happens to share a few common words
  // (numbers, the slide's own subject) is not.
  const overlapRatio = shared / Math.min(a.size, b.size);
  return overlapRatio >= 0.5;
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
 * The real uploaded document title(s) for comprehensive mode's prompt
 * header -- context.deckTitle is just "Ask Jack" there (a mode label, not a
 * real deck name; Ask Jack's controller has nothing real to report). Falls
 * through on a falsy (not just missing) title -- a parsed document whose
 * filename-derived title happens to be an empty string must not produce a
 * blank `Deck: "".` header, which would be exactly the kind of misleading
 * framing this whole prompt restructure was written to eliminate.
 */
function deckTitleForComprehensivePrompt(docs: ParsedDocument[], activeFileId: string | null, fallback: string): string {
  if (activeFileId) {
    const activeTitle = docs.find((d) => d.fileId === activeFileId)?.title;
    if (activeTitle) return activeTitle;
  }
  const titles = docs.map((d) => d.title).filter(Boolean);
  return titles.length > 0 ? titles.join(", ") : fallback;
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
  assistantName = "Jack",
): Promise<DeckAnswer> {
  const retrieval = retrieveForQuestion(question, context, docs, activeFileId, comprehensive);
  const matches = retrieval.matches;

  // No deck material matched -- still let the LLM assess and answer (see
  // QA_SYSTEM_PROMPT_NO_MATERIAL's comment): a lot of real speech directed
  // at Jack was never a deck question in the first place.
  if (retrieval.confidence === "low") {
    const soundsLikeDeckQuestion = DECK_REFERENCE_RE.test(question);
    const systemPrompt = withAssistantName(
      soundsLikeDeckQuestion ? QA_SYSTEM_PROMPT_NO_MATERIAL : QA_SYSTEM_PROMPT_CONVERSATIONAL,
      assistantName,
    );
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

  // Comprehensive mode (Ask Jack) has no real "current slide" -- its
  // controller can't report one (there's nothing being presented), so
  // formatContextForQA's header always asserted something actively
  // misleading here ("slide 1 of 1" -- Ask Jack's controller reports its
  // uploaded-FILE count as totalSlides, not a section count -- "Current
  // slide content: (no extracted text)"). Confirmed live: this confused the
  // model into answering "slide 5 is not provided in the material" even
  // when the correctly-retrieved slide-5 content was right there in the
  // very next paragraph, because the header flatly asserted only 1 slide
  // exists. Present/Practice's header stays as-is -- it's real and correct
  // there (an actual current slide is being shown).
  // context.deckTitle is a placeholder ("Ask Jack") in comprehensive mode --
  // Ask Jack's controller has no real deck to name, only a mode label. The
  // actual uploaded document(s) title(s) are right here in `docs`, scoped
  // the same way retrieval itself is scoped (activeFileId, or every loaded
  // doc if none is selected).
  const deckTitleForPrompt = comprehensive ? deckTitleForComprehensivePrompt(docs, activeFileId, context.deckTitle) : context.deckTitle;
  const materialParts = comprehensive ? [`Deck: "${deckTitleForPrompt}".`] : [formatContextForQA(context)];
  if (matches.length > 0) {
    materialParts.push(
      "Relevant material found in the deck:\n" +
        matches.map((m) => `- "${m.title}": ${truncateForPrompt(m.text)}`).join("\n"),
    );
  }
  const prompt = `${materialParts.join("\n\n")}\n\nQuestion: ${question}`;
  const systemPrompt = withAssistantName(
    retrieval.confidence === "high" ? QA_SYSTEM_PROMPT_HIGH : QA_SYSTEM_PROMPT_MEDIUM,
    assistantName,
  );
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

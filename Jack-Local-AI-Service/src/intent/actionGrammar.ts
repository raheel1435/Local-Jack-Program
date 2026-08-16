// GBNF grammar constraining llama.cpp's output to a well-formed intent
// classification. `type` is mandatory and decided first; `action`/`target`
// are syntactically optional in every case (GBNF can't express "required
// iff type=action"), so the SERVER discards any `action` value the model
// includes unless type is genuinely "action" -- the safety boundary is
// enforced in code, not merely by prompt instruction, matching the
// "not only patched in the frontend" requirement.
export const ACTION_GRAMMAR = `root       ::= "{" ws "\\"type\\"" ws ":" ws intenttype ("," ws "\\"action\\"" ws ":" ws action)? ("," ws "\\"target\\"" ws ":" ws string)? ws "}"
intenttype ::= "\\"action\\"" | "\\"conversation\\"" | "\\"unknown\\""
action     ::= "\\"start_presentation\\"" | "\\"next_slide\\"" | "\\"previous_slide\\"" | "\\"jump_to_slide\\"" | "\\"pause_presentation\\"" | "\\"resume_presentation\\"" | "\\"explain_slide\\"" | "\\"summarize_slide\\"" | "\\"handoff_to_presenter\\"" | "\\"stop_presentation\\""
string     ::= "\\"" [^"]* "\\""
ws         ::= [ \\t\\n]*
`;

export const ACTION_SYSTEM_PROMPT =
  "You are Jack, an AI presentation control assistant. Classify the presenter's " +
  'utterance and respond with ONLY a single-line JSON object. First decide "type":\n' +
  '- "action": a clear, unambiguous presentation-control command.\n' +
  '- "conversation": a question, comment, opinion, greeting, or small talk -- ' +
  'not a command (e.g. "That\'s interesting.", "Thank you.", "What do you think?", ' +
  '"Can you tell me more?", "Why is that important?").\n' +
  '- "unknown": you genuinely cannot tell what the presenter means.\n' +
  'Only when type is "action", also include "action", one of: start_presentation, ' +
  "next_slide, previous_slide, jump_to_slide, pause_presentation, resume_presentation, " +
  'explain_slide, summarize_slide, handoff_to_presenter, stop_presentation -- and, ' +
  'only for jump_to_slide, "target". When type is "conversation" or "unknown", do NOT ' +
  "include \"action\" -- guessing a presentation command for ordinary talk is unsafe. " +
  'When genuinely unsure between "action" and "conversation", prefer "conversation": ' +
  "silently doing nothing is always safer than mutating the presentation on a guess.\n" +
  'Note: "continue", "resume", "keep going", and "carry on" mean resume_presentation, ' +
  'NOT next_slide -- only explicit "next"/"next slide" means next_slide. ' +
  '"I will take over" / "give me control" / "I\'ve got it" mean handoff_to_presenter ' +
  '(control moving TO the presenter). "Jack, take over" / "Jack, you present this" ' +
  "mean action:start_presentation (control moving TO Jack) -- the opposite direction. " +
  "No other text, no explanation, no markdown.";

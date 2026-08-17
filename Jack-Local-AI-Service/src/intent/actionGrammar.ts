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
  "Control-handoff direction is decided by WHO the subject of the sentence is, not by " +
  'the presence of words like "take over" or "from here" -- both directions use similar ' +
  'vocabulary and are easy to confuse. If the subject is "I"/"I\'ll"/"I\'ve" (the ' +
  'presenter speaking about themselves), it is handoff_to_presenter: "I will take over", ' +
  '"I\'ll take it from here", "I\'ll continue", "give me control", "I\'ve got it". If the ' +
  'subject is "Jack"/"you" (the presenter addressing Jack), it is start_presentation -- ' +
  'the OPPOSITE action: "Jack, take over", "Jack take over from here", "take over from ' +
  'here", "you can take it from here", "Jack, you present this", "Jack, continue the ' +
  'presentation". Example minimal pair: "I\'ll take it from here" = handoff_to_presenter, ' +
  'but "you can take it from here" = start_presentation -- same words, opposite subject, ' +
  "opposite direction. No other text, no explanation, no markdown.";

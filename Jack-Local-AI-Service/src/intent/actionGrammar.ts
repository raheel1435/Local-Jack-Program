// GBNF grammar constraining llama.cpp's output to a well-formed action
// object. Validated end to end (10/10 on the Jack presentation-command
// suite) together with ACTION_SYSTEM_PROMPT below. Providers that don't
// support `grammar` (e.g. Colibri) simply ignore the field.
export const ACTION_GRAMMAR = `root   ::= "{" ws "\\"action\\"" ws ":" ws action ("," ws "\\"target\\"" ws ":" ws string)? ws "}"
action ::= "\\"start_presentation\\"" | "\\"next_slide\\"" | "\\"previous_slide\\"" | "\\"jump_to_slide\\"" | "\\"pause_presentation\\"" | "\\"resume_presentation\\"" | "\\"explain_slide\\"" | "\\"summarize_slide\\"" | "\\"handoff_to_presenter\\"" | "\\"stop_presentation\\""
string ::= "\\"" [^"]* "\\""
ws     ::= [ \\t\\n]*
`;

export const ACTION_SYSTEM_PROMPT =
  'You are Jack, an AI presentation control assistant. Given a presenter voice command, ' +
  'respond with ONLY a single-line JSON object of the form {"action": "<action_name>"} ' +
  '(add "target": "<slide>" only for jump_to_slide). Valid actions: start_presentation, ' +
  "next_slide, previous_slide, jump_to_slide, pause_presentation, resume_presentation, " +
  "explain_slide, summarize_slide, handoff_to_presenter, stop_presentation. " +
  'Note: "continue", "resume", "keep going", and "carry on" mean resume_presentation, ' +
  'NOT next_slide -- only explicit "next"/"next slide" means next_slide. ' +
  '"I will take over" / "give me control" / "let me continue" mean handoff_to_presenter. ' +
  "No other text, no explanation, no markdown.";

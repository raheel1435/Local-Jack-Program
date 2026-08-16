export interface DeterministicMatch {
  action: string;
  target?: string;
}

interface Rule {
  action: string;
  /** Each pattern must match the ENTIRE normalized utterance (anchored).
   * Deliberately strict: this layer only intercepts short, unambiguous
   * imperative commands. Anything not matched falls through to the LLM,
   * which still owns questions, explanations, and ambiguous phrasing. */
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    action: "start_presentation",
    patterns: [/^(jack,?\s+)?(start|begin)( the)? presentation\.?$/],
  },
  {
    action: "next_slide",
    patterns: [/^next( slide)?\.?$/, /^(go|move) (to the )?next( slide)?\.?$/],
  },
  {
    action: "previous_slide",
    patterns: [
      /^(go )?back\.?$/,
      /^previous( slide)?\.?$/,
      /^(go|move) (to the )?previous( slide)?\.?$/,
    ],
  },
  {
    action: "pause_presentation",
    patterns: [/^pause\.?$/, /^pause( the)? presentation\.?$/],
  },
  {
    action: "resume_presentation",
    patterns: [
      /^(continue|resume)\.?$/,
      /^(keep going|carry on)\.?$/,
      /^resume( the)? presentation\.?$/,
    ],
  },
  {
    action: "handoff_to_presenter",
    patterns: [
      /^i('| wi)ll take over( now)?\.?$/,
      /^(give|hand)( me| back)? (the )?control( back)?\.?$/,
      /^let me (take over|continue)\.?$/,
    ],
  },
  {
    action: "stop_presentation",
    patterns: [
      /^(jack,?\s+)?stop( presenting)?\.?$/,
      /^end( the)? presentation\.?$/,
    ],
  },
];

/**
 * Bypasses the LLM entirely for short, unambiguous presentation-control
 * utterances (next/back/pause/resume/stop/handoff). Everything else --
 * questions, explanations, summaries, "jump to X" (needs slide-name
 * resolution), or anything not matching exactly -- returns null and falls
 * through to LLM reasoning.
 */
export function matchDeterministicCommand(
  text: string
): DeterministicMatch | null {
  const normalized = text.trim().toLowerCase();
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(normalized))) {
      return { action: rule.action };
    }
  }
  return null;
}

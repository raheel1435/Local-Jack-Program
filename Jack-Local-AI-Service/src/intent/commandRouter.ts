export type IntentType = "action" | "conversation" | "unknown";

export interface DeterministicMatch {
  type: IntentType;
  action?: string;
  target?: string;
}

interface ActionRule {
  type: "action";
  action: string;
  /** Each pattern must match the ENTIRE normalized utterance (anchored).
   * Deliberately strict: this layer only intercepts short, unambiguous
   * imperative commands. Anything not matched falls through to the LLM,
   * which still owns questions, explanations, and ambiguous phrasing. */
  patterns: RegExp[];
}

interface ConversationRule {
  type: "conversation";
  patterns: RegExp[];
}

const ACTION_RULES: ActionRule[] = [
  {
    type: "action",
    action: "start_presentation",
    patterns: [
      /^(jack,?\s+)?(start|begin)( the)? presentation\.?$/,
      // "Jack, take over" hands presenting duties TO Jack -- distinct from
      // "I'll take over"/"give me control" below, which hand them back.
      // "take ?over" (space optional): whisper.cpp reproducibly transcribes
      // this exact phrase as the compound word "takeover" -- observed live
      // during real-hardware voice testing, not a hypothetical.
      /^jack,?\s+(take ?over|you (take it|present this)|please present)( now)?\.?$/,
      // Realistic phrasing variants, all still addressed TO Jack (subject is
      // "you"/"Jack", never "I"/"I'll") -- confirmed live that without these,
      // "Jack take over from here." fell through to the LLM, which
      // misclassified it as handoff_to_presenter (the OPPOSITE of what it
      // means) by pattern-matching on "take it/take over from here" too
      // loosely against "I'll take it from here" below.
      /^(jack,?\s+)?take ?over from (here|there)\.?$/,
      /^you (can )?take it from (here|there)\.?$/,
      /^jack,?\s+you present( this)?( now)?\.?$/,
      /^jack,?\s+continue( the presentation)?\.?$/,
    ],
  },
  {
    type: "action",
    action: "next_slide",
    patterns: [/^next( slide)?\.?$/, /^(go|move) (to the )?next( slide)?\.?$/],
  },
  {
    type: "action",
    action: "previous_slide",
    patterns: [
      /^(go )?back\.?$/,
      /^previous( slide)?\.?$/,
      /^(go|move) (to the )?previous( slide)?\.?$/,
    ],
  },
  {
    type: "action",
    action: "pause_presentation",
    patterns: [/^pause\.?$/, /^pause( the)? presentation\.?$/, /^jack,?\s+wait\.?$/, /^wait\.?$/, /^hold on\.?$/],
  },
  {
    type: "action",
    action: "resume_presentation",
    patterns: [
      /^(continue|resume)\.?$/,
      /^(keep going|carry on)\.?$/,
      /^resume( the)? presentation\.?$/,
    ],
  },
  {
    type: "action",
    action: "handoff_to_presenter",
    patterns: [
      /^i('| wi)ll take ?over( now)?\.?$/,
      /^i('| wi)ll take it from (here|there)\.?$/,
      /^i('| wi)ll continue\.?$/,
      /^(give|hand)( me| back)? (the )?control( back)?\.?$/,
      /^let me (take ?over|continue)\.?$/,
      /^i('| ha)ve (got|got it|it)\.?$/,
    ],
  },
  {
    type: "action",
    action: "stop_presentation",
    patterns: [
      /^(jack,?\s+)?stop( presenting)?\.?$/,
      /^end( the)? presentation\.?$/,
    ],
  },
];

// Common conversational filler that must never be allowed to reach the
// LLM's action grammar -- guaranteed-correct fast path for the cases the
// safety regression suite explicitly requires, rather than trusting model
// variance for the most common ones.
const CONVERSATION_RULES: ConversationRule[] = [
  {
    type: "conversation",
    patterns: [
      /^(that('s| is)|this( slide)? is) (interesting|impressive|great|cool|nice|good|amazing)\.?$/,
      /^interesting\.?$/,
      /^i (like|love) (this|that)( slide)?\.?$/,
      /^thank(s| you)( so much)?\.?$/,
      /^(nice|great|good) (job|work)\.?$/,
      /^what do you think\??$/,
      /^can you tell me more\??$/,
      /^why is (that|this) important\??$/,
      /^(hi|hello|hey)( jack)?\.?$/,
    ],
  },
];

/**
 * Bypasses the LLM entirely for short, unambiguous presentation commands
 * and for common conversational filler that must never be allowed to
 * mutate presentation state. Everything else -- questions, explanations,
 * ambiguous phrasing, or anything not matching exactly -- returns null and
 * falls through to the LLM's type/action classifier.
 */
export function matchDeterministicCommand(text: string): DeterministicMatch | null {
  const normalized = text.trim().toLowerCase();

  for (const rule of ACTION_RULES) {
    if (rule.patterns.some((p) => p.test(normalized))) {
      return { type: "action", action: rule.action };
    }
  }
  for (const rule of CONVERSATION_RULES) {
    if (rule.patterns.some((p) => p.test(normalized))) {
      return { type: "conversation" };
    }
  }
  return null;
}

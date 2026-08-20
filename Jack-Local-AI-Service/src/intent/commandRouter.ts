import { hasNegation } from "./addressing.js";

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

// Every pattern below that addresses Jack by name used to require the
// utterance to start with the bare word "jack" -- "Jack, take over" matched,
// "Hey Jack, take over" did not. Confirmed live: that gap sent "Hey Jack,
// take over" past the deterministic router entirely, into the LLM fallback,
// which then inverted it to handoff_to_presenter ("Absolutely. It's yours.")
// -- the OPPOSITE action, and Jack went silent because control had just been
// handed to the presenter. "Hey Jack"/"Ok Jack"/"Okay Jack"/"Yo Jack" are
// completely ordinary ways to address a voice assistant, so this greeting
// filler is now accepted everywhere a leading "jack" address was already
// recognized, as a plain string substitution into each pattern source
// (regex literals can't interpolate a shared fragment directly).
const HEY = "(?:(?:hey|ok(?:ay)?|yo)[,]?\\s+)?";
function withHey(source: string): RegExp {
  return new RegExp(source.replace(/JACK/g, `${HEY}jack`));
}

const ACTION_RULES: ActionRule[] = [
  {
    type: "action",
    action: "start_presentation",
    patterns: [
      withHey("^(JACK,?\\s+)?(start|begin)( the)? presentation\\.?$"),
      // "Jack, take over" hands presenting duties TO Jack -- distinct from
      // "I'll take over"/"give me control" below, which hand them back.
      // "take ?over" (space optional): whisper.cpp reproducibly transcribes
      // this exact phrase as the compound word "takeover" -- observed live
      // during real-hardware voice testing, not a hypothetical.
      withHey("^JACK,?\\s+(take ?over|you (take it|present this|take ?over|handle it)|please present)( now| again)?\\.?$"),
      // "again" specifically -- confirmed live the LLM fallback inverted
      // "Jack take over again." to handoff_to_presenter (the OPPOSITE
      // meaning) when it fell through un-anchored by an explicit pattern;
      // this is the same repeat-takeover-in-one-session case as Phase 14/17.
      // Name trails here ("...again, Jack") so the HEY filler (a greeting,
      // always leads) doesn't apply to this one.
      /^take ?over again,?\s*jack\.?$/,
      // Realistic phrasing variants, all still addressed TO Jack (subject is
      // "you"/"Jack", never "I"/"I'll") -- confirmed live that without these,
      // "Jack take over from here." fell through to the LLM, which
      // misclassified it as handoff_to_presenter (the OPPOSITE of what it
      // means) by pattern-matching on "take it/take over from here" too
      // loosely against "I'll take it from here" below.
      withHey("^(JACK,?\\s+)?take ?over from (here|there)\\.?$"),
      /^you (can )?take it from (here|there)\.?$/,
      withHey("^JACK,?\\s+you present( this)?( now)?\\.?$"),
      withHey("^JACK,?\\s+continue( the presentation)?\\.?$"),
      // "Jack, present this." (no "you"), "Take over, Jack." (name trails,
      // not leads), "You can present from here." -- confirmed live via
      // direct /jack/intent calls that the LLM fallback either inverted
      // these (returned handoff_to_presenter, the opposite meaning) or
      // classified them as non-actionable "conversation".
      withHey("^JACK,?\\s+present( this)?( now)?\\.?$"),
      /^take ?over,?\s*jack\.?$/,
      /^you (can )?present( this)? from (here|there)\.?$/,
    ],
  },
  {
    type: "action",
    action: "next_slide",
    patterns: [
      withHey("^(JACK,?\\s+)?next( slide)?\\.?$"),
      withHey("^(JACK,?\\s+)?(go|move) (to the )?next( slide)?\\.?$"),
    ],
  },
  {
    type: "action",
    action: "previous_slide",
    patterns: [
      withHey("^(JACK,?\\s+)?(go )?back\\.?$"),
      withHey("^(JACK,?\\s+)?previous( slide)?\\.?$"),
      withHey("^(JACK,?\\s+)?(go|move) (to the )?previous( slide)?\\.?$"),
    ],
  },
  {
    type: "action",
    action: "pause_presentation",
    patterns: [
      withHey("^(JACK,?\\s+)?pause\\.?$"),
      withHey("^(JACK,?\\s+)?pause( the)? presentation\\.?$"),
      withHey("^JACK,?\\s+wait\\.?$"),
      /^wait\.?$/,
      /^hold on\.?$/,
    ],
  },
  {
    type: "action",
    action: "resume_presentation",
    patterns: [
      // Bare "continue" here is deliberately NOT given a jack-prefix
      // variant: "Jack, continue" already matches start_presentation's own
      // "jack continue" pattern above (checked first, in ACTION_RULES
      // order) -- adding a duplicate here would just be unreachable dead
      // code, not a behavior change. "Resume"/"keep going"/"carry on" have
      // no such conflict.
      /^(continue|resume)\.?$/,
      withHey("^(JACK,?\\s+)?resume\\.?$"),
      withHey("^(JACK,?\\s+)?(keep going|carry on)\\.?$"),
      withHey("^(JACK,?\\s+)?resume( the)? presentation\\.?$"),
    ],
  },
  {
    type: "action",
    action: "handoff_to_presenter",
    patterns: [
      // Optional "Jack," prefix on all three -- confirmed live (Whisper
      // baseline audit) that "Jack, I'll take it from here." transcribes
      // perfectly but was falling through to the LLM fallback un-anchored
      // by "jack,", which classified it as plain "conversation" (no action
      // at all), same failure class as "Jack, I'll continue." below.
      withHey("^(JACK,?\\s+)?i('| wi)ll take ?over( now)?\\.?$"),
      withHey("^(JACK,?\\s+)?i('| wi)ll take it from (here|there)\\.?$"),
      withHey("^(JACK,?\\s+)?i('| wi)ll continue\\.?$"),
      /^(give|hand)( me| back)? (the )?control( back)?\.?$/,
      // "Give it back to me." -- confirmed live the LLM fallback returned a
      // bare "conversation" with no action at all for this phrasing.
      /^give it back( to me)?\.?$/,
      /^let me (take ?over|continue)\.?$/,
      /^i('| ha)ve (got|got it|it)\.?$/,
    ],
  },
  {
    type: "action",
    action: "stop_presentation",
    patterns: [
      withHey("^(JACK,?\\s+)?stop( presenting)?\\.?$"),
      /^end( the)? presentation\.?$/,
    ],
  },
  {
    // Added by the WHISPER SAFETY CORRECTION milestone (Part 15): these two
    // used to reach the LLM fallback ONLY, and the Vibe-milestone corpus
    // run counted "Jack, summarize this slide." transcribing perfectly but
    // still failing as an LLM-classification miss -- that's a routing gap,
    // not an ASR problem (see VIBEVOICE_BASELINE.md's corrected accounting).
    // Both are read-only/informational, not presentation-state-changing --
    // deliberately NOT in the high-impact set the LLM-fallback confidence
    // gate in routes/intent.ts applies to.
    type: "action",
    action: "explain_slide",
    patterns: [withHey("^JACK,?\\s+explain( this| the)? slide\\.?$")],
  },
  {
    type: "action",
    action: "summarize_slide",
    patterns: [withHey("^JACK,?\\s+summar(ize|ise)( this| the)? slide\\.?$")],
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
 * A single bare word that didn't match any action or conversation pattern
 * above is very likely a clipped microphone fragment ("you.", "the.",
 * "jack.", "from.") rather than a real command or question -- confirmed
 * live: a real "Jack take over from here." recording that lost its first
 * syllables produced exactly this shape of transcript, which the LLM then
 * classified as "conversation" and Jack "answered" with "That isn't covered
 * in this presentation" -- a deeply confusing response to what was actually
 * a failed recording. Legitimate one-word commands ("Next.", "Pause.",
 * "Continue.", "Back.", "Wait.", "Stop.") never reach this check at all --
 * they already matched an ACTION_RULES pattern above and returned early.
 * Multi-word fragments are deliberately NOT covered here: there's no
 * reliable way to distinguish a clipped multi-word command from a
 * genuinely short real question without guessing, whereas an isolated
 * single word is the concrete, evidenced failure mode.
 */
function isBareWordFragment(normalized: string): boolean {
  const words = normalized.replace(/[.?!]+$/, "").split(/\s+/).filter(Boolean);
  return words.length === 1;
}

/**
 * Whisper commonly emits bracketed non-speech annotations for ambient noise
 * with no real speech present -- "(screams)", "(indistinct chatter)",
 * "[Music]", "(laughing)" -- rather than an empty transcript. Confirmed live
 * via barge-in picking up real room ambience during testing:
 * "(screams) (screams) (screams)" reached the LLM classifier, which
 * returned stop_presentation and ended the entire presentation from nothing
 * but background noise -- multi-word, so the bare-word-fragment check above
 * never saw it. A transcript that, once every bracketed annotation is
 * stripped out, has no real words left is exactly this failure mode, not a
 * real command -- fails safe to "unknown" the same as a bare-word fragment,
 * never reaching the LLM's more permissive classifier.
 */
function isNonSpeechArtifact(normalized: string): boolean {
  if (!/[([]/.test(normalized)) return false;
  const stripped = normalized.replace(/[([][^)\]]*[)\]]/g, "").replace(/[.?!,]/g, "").trim();
  return stripped.length === 0;
}

/**
 * Bypasses the LLM entirely for short, unambiguous presentation commands
 * and for common conversational filler that must never be allowed to
 * mutate presentation state. Everything else -- questions, explanations,
 * ambiguous phrasing, or anything not matching exactly -- returns null and
 * falls through to the LLM's type/action classifier, EXCEPT a single bare
 * word (see isBareWordFragment), which fails safe to "unknown" without
 * ever reaching the LLM's more permissive "conversation" guess.
 */
export function matchDeterministicCommand(text: string): DeterministicMatch | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return { type: "unknown" };

  // WHISPER SAFETY CORRECTION milestone, Part 4: checked BEFORE any
  // ACTION_RULES pattern, not after -- "Jack, don't stop." must never
  // execute stop_presentation. Deterministic and fast (no LLM round trip),
  // and deliberately fails safe to "conversation" rather than falling
  // through to the LLM's own action grammar, which has no negation handling
  // of its own and could just as easily invert the meaning the way it did
  // for "take over again" (see this file's own history/comments above).
  if (hasNegation(normalized)) {
    return { type: "conversation" };
  }

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
  if (isBareWordFragment(normalized) || isNonSpeechArtifact(normalized)) {
    return { type: "unknown" };
  }
  return null;
}

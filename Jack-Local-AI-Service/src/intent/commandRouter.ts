import { hasNegation } from "./addressing.js";

export type IntentType = "action" | "conversation" | "unknown";

export interface DeterministicMatch {
  type: IntentType;
  action?: string;
  /** Never populated by matchDeterministicCommand -- no ActionRule pattern
   * below extracts a slide target (jump_to_slide has no deterministic
   * pattern at all, so it always falls through to the LLM path, which DOES
   * populate this on its own JackIntentResult; see routes/intent.ts). Kept
   * on this shared shape only because intent.ts's deterministic response
   * reuses the same JSON field name as the LLM path's -- always undefined
   * here in practice. */
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

// Multi-persona milestone: every pattern that used to hardcode the literal
// word "jack" now takes the currently selected assistant name instead
// (Bella/Adam/Nova/Sarah/George/Emma/Jack/...), via the same JACK placeholder
// substitution these pattern sources already used. Regex-escaped since a
// name is presenter-facing text, not a hand-written pattern.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withHey(source: string, name: string): RegExp {
  return new RegExp(source.replace(/JACK/g, `${HEY}${name}`));
}

// For the couple of patterns where the name TRAILS the command instead of
// leading it ("take over, Jack.") -- the HEY greeting filler is meaningless
// there (a greeting always leads), so this is the same JACK-placeholder
// substitution without it.
function withName(source: string, name: string): RegExp {
  return new RegExp(source.replace(/JACK/g, name));
}

function buildActionRules(name: string): ActionRule[] {
  return [
  {
    type: "action",
    action: "start_presentation",
    patterns: [
      withHey("^(JACK,?\\s+)?(start|begin)( the)? presentation\\.?$", name),
      // "Jack, take over" hands presenting duties TO Jack -- distinct from
      // "I'll take over"/"give me control" below, which hand them back.
      // "take ?over" (space optional): whisper.cpp reproducibly transcribes
      // this exact phrase as the compound word "takeover" -- observed live
      // during real-hardware voice testing, not a hypothetical.
      withHey("^JACK,?\\s+(take ?over|you (take it|present this|take ?over|handle it)|please present)( now| again)?\\.?$", name),
      // "again" specifically -- confirmed live the LLM fallback inverted
      // "Jack take over again." to handoff_to_presenter (the OPPOSITE
      // meaning) when it fell through un-anchored by an explicit pattern;
      // this is the same repeat-takeover-in-one-session case as Phase 14/17.
      // Name trails here ("...again, Jack") so the HEY filler (a greeting,
      // always leads) doesn't apply to this one.
      withName("^take ?over again,?\\s*JACK\\.?$", name),
      // Realistic phrasing variants, all still addressed TO Jack (subject is
      // "you"/"Jack", never "I"/"I'll") -- confirmed live that without these,
      // "Jack take over from here." fell through to the LLM, which
      // misclassified it as handoff_to_presenter (the OPPOSITE of what it
      // means) by pattern-matching on "take it/take over from here" too
      // loosely against "I'll take it from here" below.
      withHey("^(JACK,?\\s+)?take ?over from (here|there)\\.?$", name),
      /^you (can )?take it from (here|there)\.?$/,
      withHey("^JACK,?\\s+you present( this)?( now)?\\.?$", name),
      withHey("^JACK,?\\s+continue( the presentation)?\\.?$", name),
      // "Jack, present this." (no "you"), "Take over, Jack." (name trails,
      // not leads), "You can present from here." -- confirmed live via
      // direct /jack/intent calls that the LLM fallback either inverted
      // these (returned handoff_to_presenter, the opposite meaning) or
      // classified them as non-actionable "conversation".
      withHey("^JACK,?\\s+present( this)?( now)?\\.?$", name),
      withName("^take ?over,?\\s*JACK\\.?$", name),
      /^you (can )?present( this)? from (here|there)\.?$/,
    ],
  },
  {
    type: "action",
    action: "next_slide",
    patterns: [
      withHey("^(JACK,?\\s+)?next( slide)?\\.?$", name),
      withHey("^(JACK,?\\s+)?(go|move) (to the )?next( slide)?\\.?$", name),
    ],
  },
  {
    type: "action",
    action: "previous_slide",
    patterns: [
      withHey("^(JACK,?\\s+)?(go )?back\\.?$", name),
      withHey("^(JACK,?\\s+)?previous( slide)?\\.?$", name),
      withHey("^(JACK,?\\s+)?(go|move) (to the )?previous( slide)?\\.?$", name),
    ],
  },
  {
    type: "action",
    action: "pause_presentation",
    patterns: [
      withHey("^(JACK,?\\s+)?pause\\.?$", name),
      withHey("^(JACK,?\\s+)?pause( the)? presentation\\.?$", name),
      withHey("^JACK,?\\s+wait\\.?$", name),
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
      withHey("^(JACK,?\\s+)?resume\\.?$", name),
      withHey("^(JACK,?\\s+)?(keep going|carry on)\\.?$", name),
      withHey("^(JACK,?\\s+)?resume( the)? presentation\\.?$", name),
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
      withHey("^(JACK,?\\s+)?i('| wi)ll take ?over( now)?\\.?$", name),
      withHey("^(JACK,?\\s+)?i('| wi)ll take it from (here|there)\\.?$", name),
      withHey("^(JACK,?\\s+)?i('| wi)ll continue\\.?$", name),
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
      withHey("^(JACK,?\\s+)?stop( presenting)?\\.?$", name),
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
    patterns: [withHey("^JACK,?\\s+explain( this| the)? slide\\.?$", name)],
  },
  {
    type: "action",
    action: "summarize_slide",
    patterns: [withHey("^JACK,?\\s+summar(ize|ise)( this| the)? slide\\.?$", name)],
  },
  ];
}

// Common conversational filler that must never be allowed to reach the
// LLM's action grammar -- guaranteed-correct fast path for the cases the
// safety regression suite explicitly requires, rather than trusting model
// variance for the most common ones.
function buildConversationRules(name: string): ConversationRule[] {
  return [
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
      withName("^(hi|hello|hey)( JACK)?\\.?$", name),
    ],
  },
  ];
}

// Security-boundary hardening: these caches are keyed by whatever
// `assistantName` the caller of /jack/intent sends (there is no persona
// allowlist server-side -- the frontend's own VOICE_OPTIONS is a UI-layer
// concern the gateway deliberately doesn't import, same as the two apps'
// separately-maintained addressing.ts copies). A prior audit confirmed an
// unbounded Map here means any reachable caller could grow it forever, one
// entry (a freshly-compiled RegExp array) per distinct name ever sent. A
// small fixed-capacity LRU keeps the fast path for real, repeated persona
// names (the realistic set is tiny -- see VOICE_OPTIONS) while capping
// worst-case memory regardless of how many distinct names a caller sends.
const RULE_CACHE_MAX_ENTRIES = 64;

class BoundedLruMap<V> {
  private readonly max: number;
  private readonly map = new Map<string, V>();
  constructor(max: number) {
    this.max = max;
  }
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Re-insert to mark as most-recently-used (Map preserves insertion order).
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: string, value: V): void {
    if (this.map.size >= this.max && !this.map.has(key)) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }
  get size(): number {
    return this.map.size;
  }
}

const actionRuleCache = new BoundedLruMap<ActionRule[]>(RULE_CACHE_MAX_ENTRIES);
const conversationRuleCache = new BoundedLruMap<ConversationRule[]>(RULE_CACHE_MAX_ENTRIES);

/** Test-only accessor -- lets a regression test observe that the cache is
 * genuinely bounded without exposing the caches themselves as public API. */
export function __ruleCacheSizeForTests(): { action: number; conversation: number } {
  return { action: actionRuleCache.size, conversation: conversationRuleCache.size };
}

function rulesFor(rawName: string): { action: ActionRule[]; conversation: ConversationRule[] } {
  const key = escapeRegExp(rawName.trim().toLowerCase()) || "jack";
  let action = actionRuleCache.get(key);
  if (!action) {
    action = buildActionRules(key);
    actionRuleCache.set(key, action);
  }
  let conversation = conversationRuleCache.get(key);
  if (!conversation) {
    conversation = buildConversationRules(key);
    conversationRuleCache.set(key, conversation);
  }
  return { action, conversation };
}

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
export function matchDeterministicCommand(text: string, assistantName = "jack"): DeterministicMatch | null {
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

  const { action: ACTION_RULES, conversation: CONVERSATION_RULES } = rulesFor(assistantName);

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

/**
 * End-to-end latency tracing for Jack's voice/narration pipeline. One trace
 * per interaction (a captured voice command, a typed command, one
 * autonomous slide-narration step) -- each stage is marked
 * only where the code genuinely reaches that point, so a trace for a
 * "next slide" command (no LLM/TTS involved) simply has no LLM/TTS marks
 * rather than a fabricated 0ms.
 *
 * Local-only: marks are wall-clock timestamps (Date.now()) and short text
 * (transcript/provider/kind) kept in an in-memory, capped, session-scoped
 * ring buffer. No raw audio is ever stored here, and nothing here is
 * uploaded or persisted to disk -- see AsrDiagnosticEntry in JackProvider.tsx
 * for the same pattern applied to ASR specifically.
 */

/**
 * "Short command" vs "long question"/"Q&A" (both requested as separate
 * buckets by the latency-observatory spec) aren't split into distinct
 * kinds here -- both a one-word "next slide" and an open-ended deck
 * question run through the exact same runLocalCommand trace (kind
 * voice_command/typed_command), since that's genuinely the same code path
 * with different branches taken inside it. They stay distinguishable via
 * each trace's `label` (the transcript/command text) in the history list.
 * "acknowledgement" likewise isn't a separate kind: a takeover/resume ack
 * is a voice_command trace whose ownership is handed to speakAndWait --
 * see traceHandedOff in runLocalCommand.
 */
export type TraceKind =
  | "voice_command" // barge-in captured speech -> intent -> action/response
  | "typed_command" // typed text -> intent -> action/response (no ASR stages)
  | "slide_narration" // one autonomous narration step (new slide -> speech)
  | "wake_greeting";

/** Mirrors T0-T19 from the latency spec. Not every kind reaches every stage. */
export type TraceStage =
  | "speechStart" // T0
  | "speechEnd" // T1
  | "vadEndOfTurn" // T2
  | "captureFinalized" // T3
  | "asrRequestStart" // T4
  | "asrTranscriptReady" // T5
  | "intentRequestStart" // T6
  | "intentResultReady" // T7
  | "slideMutationStart" // T8
  | "slideMutationDone" // T9 -- also used as "new slide rendered" for narration traces
  | "contextBuildStart" // T10
  | "contextBuildReady" // T11
  | "llmRequestStart" // T12
  | "llmFirstToken" // T13 -- NOT measurable with the current non-streaming jackApi.chat; left unset
  | "llmResponseReady" // T14
  | "ttsRequestStart" // T15
  | "ttsFirstAudio" // T16 -- NOT separately measurable with the current non-streaming jackApi.speak (whole blob only); left unset
  | "ttsResponseReady" // full TTS response (blob) available -- the closest real signal to T16
  | "playbackStart" // T17 -- when speechPlayer.play() is invoked, the closest available proxy for first audible sample
  | "playbackComplete"; // T19

export interface TraceRecord {
  traceId: string;
  kind: TraceKind;
  /** ASR provider, when this trace involved a transcription. */
  asrProvider?: "whisper" | "vibevoice";
  /** Short label for the diagnostics list (e.g. the transcript or narration text, truncated). */
  label: string;
  marks: Partial<Record<TraceStage, number>>;
  createdAt: number;
  /** Set once the trace is finished; false if it never completed a full "speaking" stage. */
  ok: boolean;
}

const MAX_HISTORY = 60;
const active = new Map<string, TraceRecord>();
let history: TraceRecord[] = [];
type Listener = () => void;
let listeners: Listener[] = [];

function notify() {
  for (const l of listeners) l();
}

export function subscribeTraces(fn: Listener): () => void {
  listeners = [...listeners, fn];
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

export function startTrace(kind: TraceKind, label = ""): string {
  const traceId = crypto.randomUUID();
  active.set(traceId, { traceId, kind, label, marks: {}, createdAt: Date.now(), ok: false });
  return traceId;
}

export function setTraceProvider(traceId: string, provider: "whisper" | "vibevoice") {
  const t = active.get(traceId);
  if (t) t.asrProvider = provider;
}

export function setTraceLabel(traceId: string, label: string) {
  const t = active.get(traceId);
  if (t) t.label = label.slice(0, 120);
}

/**
 * First write wins per stage -- a retried/duplicate call site never
 * clobbers the real mark. `atTs` lets a caller backdate a mark to when the
 * stage actually happened (e.g. T1 speech-end is the moment silence
 * started, not the moment a polling loop later noticed it).
 */
export function mark(traceId: string | undefined, stage: TraceStage, atTs?: number) {
  if (!traceId) return;
  const t = active.get(traceId);
  if (!t || t.marks[stage] !== undefined) return;
  t.marks[stage] = atTs ?? Date.now();
}

/** Finishes and records the trace. Safe to call more than once (no-op after the first). */
export function finishTrace(traceId: string | undefined, ok = true) {
  if (!traceId) return;
  const t = active.get(traceId);
  if (!t) return;
  active.delete(traceId);
  t.ok = ok;
  history = [t, ...history].slice(0, MAX_HISTORY);
  notify();
}

/** Discards an in-progress trace without recording it (e.g. superseded by a newer barge-in). */
export function abortTrace(traceId: string | undefined) {
  if (!traceId) return;
  active.delete(traceId);
}

export function getTraceHistory(): TraceRecord[] {
  return history;
}

/** Test-only: clears in-progress and recorded traces so tests don't bleed into each other via this module's shared state. Never called from app code. */
export function __resetTracesForTests() {
  active.clear();
  history = [];
}

export interface DerivedLatencies {
  endOfSpeechToTranscript?: number; // T5 - T1
  asrLatency?: number; // T5 - T4
  intentLatency?: number; // T7 - T6
  slideNavLatency?: number; // T9 - T8
  contextBuildLatency?: number; // T11 - T10
  llmTimeToFirstToken?: number; // T13 - T12 (rarely available)
  llmTotalGeneration?: number; // T14 - T12
  ttsTimeToAudio?: number; // T16 - T15 (falls back to ttsResponseReady - T15 when T16 unset)
  ttsRequestToPlayback?: number; // T17 - T15
  slideVisibleToSpeaking?: number; // T17 - T9 -- THE headline autonomous-narration metric
  userFinishedToSpeaking?: number; // T17 - T1
  totalTurnLatency?: number; // T17 - T1, falling back to T17 - T9 when there's no ASR stage (narration)
}

function diff(a?: number, b?: number): number | undefined {
  return a !== undefined && b !== undefined ? b - a : undefined;
}

export function computeDerived(t: TraceRecord): DerivedLatencies {
  const m = t.marks;
  const ttsReady = m.ttsFirstAudio ?? m.ttsResponseReady;
  return {
    endOfSpeechToTranscript: diff(m.speechEnd, m.asrTranscriptReady),
    asrLatency: diff(m.asrRequestStart, m.asrTranscriptReady),
    intentLatency: diff(m.intentRequestStart, m.intentResultReady),
    slideNavLatency: diff(m.slideMutationStart, m.slideMutationDone),
    contextBuildLatency: diff(m.contextBuildStart, m.contextBuildReady),
    llmTimeToFirstToken: diff(m.llmRequestStart, m.llmFirstToken),
    llmTotalGeneration: diff(m.llmRequestStart, m.llmResponseReady),
    ttsTimeToAudio: diff(m.ttsRequestStart, ttsReady),
    ttsRequestToPlayback: diff(m.ttsRequestStart, m.playbackStart),
    slideVisibleToSpeaking: diff(m.slideMutationDone, m.playbackStart),
    userFinishedToSpeaking: diff(m.speechEnd, m.playbackStart),
    totalTurnLatency: diff(m.speechEnd ?? m.slideMutationDone, m.playbackStart),
  };
}

export type LatencyRating = "excellent" | "good" | "acceptable" | "poor" | "unacceptable";

/** Rating thresholds for the headline "slide change -> first audible speech" metric. */
export function rateSlideToSpeech(ms: number | undefined): LatencyRating | "n/a" {
  if (ms === undefined) return "n/a";
  if (ms < 1000) return "excellent";
  if (ms < 2000) return "good";
  if (ms < 3000) return "acceptable";
  if (ms < 5000) return "poor";
  return "unacceptable";
}

export interface StageStats {
  count: number;
  avg: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

export function computeStats(values: number[]): StageStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pIdx = (p: number) => Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return {
    count: sorted.length,
    avg: Math.round(sum / sorted.length),
    median: sorted[pIdx(50)],
    p95: sorted[pIdx(95)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export interface Segment {
  label: string;
  ms: number;
}

interface StagePair {
  start: TraceStage;
  end: TraceStage;
  label: (t: TraceRecord) => string;
}

// Ordered per trace kind so the breakdown reads top-to-bottom in the order
// work actually happened. Only pairs where BOTH marks exist produce a row --
// a "next slide" voice command genuinely has no Context/LLM/TTS rows, and
// this must not fabricate zeros for stages it never reached.
const NARRATION_SEGMENTS: StagePair[] = [
  { start: "slideMutationDone", end: "contextBuildStart", label: () => "Slide render" },
  { start: "contextBuildStart", end: "contextBuildReady", label: () => "Context" },
  { start: "llmRequestStart", end: "llmResponseReady", label: () => "LLM" },
  { start: "ttsRequestStart", end: "ttsResponseReady", label: () => "TTS" },
  { start: "ttsResponseReady", end: "playbackStart", label: () => "Playback start" },
];

const COMMAND_SEGMENTS: StagePair[] = [
  { start: "speechStart", end: "captureFinalized", label: () => "Capture/VAD" },
  {
    start: "asrRequestStart",
    end: "asrTranscriptReady",
    label: (t) => `ASR ${t.asrProvider === "vibevoice" ? "VibeVoice" : "Whisper"}`,
  },
  { start: "intentRequestStart", end: "intentResultReady", label: () => "Intent" },
  { start: "slideMutationStart", end: "slideMutationDone", label: () => "Action" },
  { start: "contextBuildStart", end: "contextBuildReady", label: () => "Context" },
  { start: "llmRequestStart", end: "llmResponseReady", label: () => "LLM" },
  { start: "ttsRequestStart", end: "ttsResponseReady", label: () => "TTS" },
  { start: "ttsResponseReady", end: "playbackStart", label: () => "Playback start" },
];

/** Per-trace stage breakdown for the diagnostics table -- rows sum exactly to the trace's total measured span. */
export function buildSegments(t: TraceRecord): Segment[] {
  const pairs = t.kind === "slide_narration" ? NARRATION_SEGMENTS : COMMAND_SEGMENTS;
  const segments: Segment[] = [];
  for (const p of pairs) {
    const a = t.marks[p.start];
    const b = t.marks[p.end];
    if (a !== undefined && b !== undefined && b >= a) {
      segments.push({ label: p.label(t), ms: b - a });
    }
  }
  return segments;
}

export function segmentTotal(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + s.ms, 0);
}

/** The single largest measured segment -- the honest answer to "what's slow", never a guess. */
export function findBottleneck(segments: Segment[]): Segment | null {
  if (segments.length === 0) return null;
  return segments.reduce((max, s) => (s.ms > max.ms ? s : max), segments[0]);
}

/** Pulls one derived metric across matching traces, dropping any trace where that metric isn't measurable. */
export function collectMetric(
  records: TraceRecord[],
  metric: (d: DerivedLatencies) => number | undefined,
  filter?: { kind?: TraceKind; asrProvider?: "whisper" | "vibevoice" },
): number[] {
  return records
    .filter((t) => (!filter?.kind || t.kind === filter.kind) && (!filter?.asrProvider || t.asrProvider === filter.asrProvider))
    .map((t) => metric(computeDerived(t)))
    .filter((v): v is number => v !== undefined);
}

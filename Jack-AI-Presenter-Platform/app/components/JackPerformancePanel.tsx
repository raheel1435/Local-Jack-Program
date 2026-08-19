"use client";

import {
  buildSegments,
  collectMetric,
  computeDerived,
  computeStats,
  findBottleneck,
  rateSlideToSpeech,
  segmentTotal,
  type StageStats,
  type TraceKind,
  type TraceRecord,
} from "../jack/perfTrace";

/**
 * Dev/diagnostics-only latency breakdown (latency-observatory milestone).
 * Lives inside Settings, collapsed by default -- never shown in normal
 * Present-mode narration. Reads only from JackProvider's perfTraces
 * (local-only, in-memory, capped -- see perfTrace.ts); this component does
 * no measuring of its own.
 */

const KIND_LABELS: Record<TraceKind, string> = {
  voice_command: "Voice command",
  typed_command: "Typed command",
  slide_narration: "Slide narration",
  wake_greeting: "Wake greeting",
};

function fmtMs(ms: number): string {
  return `${Math.round(ms)} ms`;
}

function TraceCard({ t }: { t: TraceRecord }) {
  const segments = buildSegments(t);
  const total = segmentTotal(segments);
  const bottleneck = findBottleneck(segments);
  const derived = computeDerived(t);
  const rating = t.kind === "slide_narration" ? rateSlideToSpeech(derived.slideVisibleToSpeaking) : null;

  return (
    <div className="jack-perf-trace-card">
      <div className="jack-perf-trace-header">
        <span className="jack-perf-trace-kind">{KIND_LABELS[t.kind]}</span>
        {rating && rating !== "n/a" && <span className={`jack-perf-rating jack-perf-rating-${rating}`}>{rating}</span>}
      </div>
      {t.label && <p className="jack-perf-trace-label">&ldquo;{t.label}&rdquo;</p>}
      {segments.length === 0 ? (
        <p className="jack-settings-note">No measurable stages recorded for this trace.</p>
      ) : (
        <table className="jack-perf-table">
          <tbody>
            {segments.map((s) => (
              <tr key={s.label}>
                <td>{s.label}</td>
                <td>{fmtMs(s.ms)}</td>
              </tr>
            ))}
            <tr className="jack-perf-total-row">
              <td>Total</td>
              <td>{fmtMs(total)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {bottleneck && (
        <p className="jack-perf-bottleneck">
          BOTTLENECK: {bottleneck.label} ({fmtMs(bottleneck.ms)})
        </p>
      )}
      {!t.ok && <p className="jack-perf-failed">Did not complete successfully.</p>}
    </div>
  );
}

function StatsRow({ label, stats }: { label: string; stats: StageStats | null }) {
  if (!stats) return null;
  return (
    <tr>
      <td>{label}</td>
      <td>{stats.count}</td>
      <td>{fmtMs(stats.avg)}</td>
      <td>{fmtMs(stats.median)}</td>
      <td>{fmtMs(stats.p95)}</td>
      <td>{fmtMs(stats.min)}</td>
      <td>{fmtMs(stats.max)}</td>
    </tr>
  );
}

export function JackPerformancePanel({ traces }: { traces: TraceRecord[] }) {
  if (traces.length === 0) return null;
  const latest = traces[0];

  const narrationTotals = collectMetric(traces, (d) => d.slideVisibleToSpeaking, { kind: "slide_narration" });
  const voiceWhisperTotals = collectMetric(traces, (d) => d.totalTurnLatency, { kind: "voice_command", asrProvider: "whisper" });
  const voiceVibeTotals = collectMetric(traces, (d) => d.totalTurnLatency, { kind: "voice_command", asrProvider: "vibevoice" });
  const typedTotals = collectMetric(traces, (d) => d.totalTurnLatency, { kind: "typed_command" });
  const wakeTotals = collectMetric(traces, (d) => d.totalTurnLatency, { kind: "wake_greeting" });
  const anyStats = [narrationTotals, voiceWhisperTotals, voiceVibeTotals, typedTotals, wakeTotals].some((v) => v.length > 0);

  return (
    <details className="jack-settings-diagnostics">
      <summary>Jack Performance ({traces.length})</summary>

      <p className="jack-perf-subtitle">Current trace</p>
      <TraceCard t={latest} />

      {anyStats && (
        <>
          <p className="jack-perf-subtitle">Session statistics (this session only)</p>
          <div className="jack-perf-stats-scroll">
            <table className="jack-perf-stats-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>n</th>
                  <th>avg</th>
                  <th>median</th>
                  <th>p95</th>
                  <th>min</th>
                  <th>max</th>
                </tr>
              </thead>
              <tbody>
                <StatsRow label="Slide change -> speech" stats={computeStats(narrationTotals)} />
                <StatsRow label="Voice command (Whisper)" stats={computeStats(voiceWhisperTotals)} />
                <StatsRow label="Voice command (VibeVoice)" stats={computeStats(voiceVibeTotals)} />
                <StatsRow label="Typed command" stats={computeStats(typedTotals)} />
                <StatsRow label="Wake greeting" stats={computeStats(wakeTotals)} />
              </tbody>
            </table>
          </div>
        </>
      )}

      <details className="jack-perf-history">
        <summary>Recent traces ({traces.length})</summary>
        <ul className="jack-perf-history-list">
          {traces.map((t) => {
            const d = computeDerived(t);
            const headline = t.kind === "slide_narration" ? d.slideVisibleToSpeaking : d.totalTurnLatency;
            return (
              <li key={t.traceId} className="jack-perf-history-row">
                <span>{KIND_LABELS[t.kind]}</span>
                <span>{headline !== undefined ? fmtMs(headline) : "--"}</span>
                <span>{t.ok ? "ok" : "failed"}</span>
                <span className="jack-perf-history-label">{t.label}</span>
              </li>
            );
          })}
        </ul>
      </details>
    </details>
  );
}

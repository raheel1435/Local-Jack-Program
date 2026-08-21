"use client";

/**
 * Full-screen "please wait" overlay shown while pregenerateDeckNarration
 * (AnalysisStage's "preparing-narration" step) is running for a file. A
 * horizontal liquid-fill bar mimics upload progress: its fill rises exactly
 * in step with slides completed / total slides, in the same cyan the Jack
 * orb glows in (var(--cyan) -- see globals.css and JackOrb.tsx's JACK_STATES,
 * which are all built from this same color family), with an animated wave
 * texture across the fill's surface for a genuinely liquid look rather than
 * a flat progress bar.
 */
export function NarrationPrepOverlay({
  assistantName,
  fileName,
  done,
  total,
}: {
  assistantName: string;
  fileName: string;
  done: number;
  total: number;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div className="narration-wait-overlay" role="status" aria-live="polite">
      <div className="narration-wait-modal">
        <p className="narration-wait-eyebrow">Please wait</p>
        <h3>
          {assistantName} is preparing narration for <span>{fileName}</span>
        </h3>

        <div className="liquid-bar" aria-hidden="true">
          <div className="liquid-fill" style={{ width: `${pct}%` }}>
            <div className="liquid-wave-layer">
              {/* Two identical copies side by side, scrolled together by
                  exactly one copy's width (see globals.css's
                  liquid-wave-scroll) -- the standard seamless-loop trick,
                  since the moment copy 1 scrolls fully out of view, copy 2
                  is sitting exactly where copy 1 started. */}
              <svg className="liquid-wave-svg" viewBox="0 0 240 20" preserveAspectRatio="none">
                <path d="M0 10 C 20 -2, 40 22, 60 10 S 100 -2, 120 10 S 160 22, 180 10 S 220 -2, 240 10 V20 H0 Z" />
              </svg>
              <svg className="liquid-wave-svg" viewBox="0 0 240 20" preserveAspectRatio="none">
                <path d="M0 10 C 20 -2, 40 22, 60 10 S 100 -2, 120 10 S 160 22, 180 10 S 220 -2, 240 10 V20 H0 Z" />
              </svg>
            </div>
          </div>
        </div>

        <p className="narration-wait-label">
          {done}/{total} slides &middot; {pct}%
        </p>
      </div>
    </div>
  );
}

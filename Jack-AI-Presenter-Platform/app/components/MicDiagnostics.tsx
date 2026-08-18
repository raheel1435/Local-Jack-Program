"use client";

import type { JackContextValue } from "../jack/JackProvider";

/**
 * Ambient-listening diagnostics readout -- shared by every mode that has a
 * mic toggle (Present/Practice/Ask Jack). Dev-only (see isDevDiagnosticsEnabled),
 * for real-hardware interruption testing, not part of the normal presenter/
 * audience UI. Was duplicated verbatim across all three stages; extracted so
 * a future format change only needs to happen once.
 */
export function MicDiagnostics({ jack }: { jack: JackContextValue }) {
  if (jack.bargeInPhase === "idle") return null;
  return (
    <p className="jack-mic-diagnostic" title="Ambient listening diagnostics -- for real-hardware interruption testing">
      mic: {jack.bargeInPhase} · lvl {jack.localMicLevel.toFixed(2)}
      {(jack.bargeInPhase === "armed" || jack.bargeInPhase === "capturing") &&
        ` · floor ${jack.bargeInNoiseFloor.toFixed(2)} · thr ${jack.bargeInThreshold.toFixed(2)}`}
    </p>
  );
}

"use client";

import { useJack } from "../jack/JackProvider";

/**
 * The ONE Speech Recognition (Approved Whisper / Test VibeVoice) control --
 * rendered both on the pre-presentation setup screen and inside Present
 * mode's settings popover (latency-fix milestone: the selector was "too
 * hidden" living only in the in-presentation popover). Both call sites read
 * and write the exact same jack.asrProvider/setAsrProvider from
 * JackProvider -- there is no separate state here, so a choice made before
 * Present starts is already active the moment it begins, and switching
 * mid-presentation updates the same single setting Present/Practice/Ask
 * Jack/ambient listening all read.
 */
export function AsrProviderSelector({ titlePrefix }: { titlePrefix?: string }) {
  const jack = useJack();

  return (
    <div className="jack-asr-selector">
      {titlePrefix !== undefined && <p className="jack-settings-section-title">{titlePrefix}Speech Recognition</p>}
      <div className="jack-asr-segmented" role="group" aria-label="Speech recognition engine">
        <button
          type="button"
          className={`jack-asr-option${jack.asrProvider === "whisper" ? " active" : ""}`}
          onClick={() => jack.setAsrProvider("whisper")}
          aria-pressed={jack.asrProvider === "whisper"}
        >
          <span>Approved · Whisper</span>
          <span className="jack-asr-option-status">
            <span className={`jack-asr-status-dot ${jack.jackLocalHealth?.whisper ?? ""}`} />
            {jack.jackLocalHealth?.whisper === "available" ? "Ready" : jack.jackLocalHealth?.whisper === "unavailable" ? "Unavailable" : "Checking..."}
          </span>
        </button>
        <button
          type="button"
          className={`jack-asr-option${jack.asrProvider === "vibevoice" ? " active" : ""}`}
          onClick={() => jack.setAsrProvider("vibevoice")}
          aria-pressed={jack.asrProvider === "vibevoice"}
        >
          <span>Test · VibeVoice</span>
          <span className="jack-asr-option-status">
            <span className={`jack-asr-status-dot ${jack.jackLocalHealth?.vibevoice ?? ""}`} />
            {jack.jackLocalHealth?.vibevoice === "available" ? "Ready" : jack.jackLocalHealth?.vibevoice === "unavailable" ? "Unavailable" : "Checking..."}
          </span>
        </button>
      </div>
      <p className="jack-settings-note">
        Applies everywhere {jack.assistantName} listens (ambient, push-to-talk, Ask {jack.assistantName}, Practice) -- no
        per-screen override. Test is experimental and never used automatically if unavailable; switch back to Approved if
        it fails.
      </p>
    </div>
  );
}

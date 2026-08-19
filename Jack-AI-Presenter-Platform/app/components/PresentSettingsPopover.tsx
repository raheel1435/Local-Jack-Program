"use client";

import { LANGUAGE_OPTIONS, VOICE_OPTIONS } from "../jack/voiceSettings";
import { useJack } from "../jack/JackProvider";
import { JackPerformancePanel } from "./JackPerformancePanel";

/**
 * Compact settings sheet for Present mode (Phase 18) -- language, voice,
 * captions, and browser-voice-fallback, adjustable without leaving the
 * presentation. Mirrors the same preferences exposed on PresentSetup, so
 * either surface can change them and both stay in sync (both read/write the
 * same JackProvider state, persisted to localStorage for the session).
 */
export function PresentSettingsPopover({ onClose }: { onClose: () => void }) {
  const jack = useJack();
  const activeLanguage = LANGUAGE_OPTIONS.find((l) => l.id === jack.language);

  return (
    <div className="jack-settings-popover" role="dialog" aria-label="Presentation settings">
      <div className="jack-settings-row">
        <span className="jack-settings-label">AI presenter</span>
        <span className="jack-settings-static">Jack</span>
      </div>

      <div className="jack-settings-row">
        <label className="jack-settings-label" htmlFor="jack-settings-language">Language</label>
        <select id="jack-settings-language" value={jack.language} onChange={(e) => jack.setLanguage(e.target.value)}>
          {LANGUAGE_OPTIONS.map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
      </div>
      {activeLanguage?.limitation && <p className="jack-settings-note">{activeLanguage.limitation}</p>}

      <div className="jack-settings-row">
        <label className="jack-settings-label" htmlFor="jack-settings-voice">Voice</label>
        <select id="jack-settings-voice" value={jack.voice} onChange={(e) => jack.setVoice(e.target.value)}>
          {VOICE_OPTIONS.map((v) => (
            <option key={v.id} value={v.id}>{v.label} -- {v.gender} · {v.accent}</option>
          ))}
        </select>
      </div>

      <label className="jack-settings-row jack-settings-checkbox">
        <span className="jack-settings-label">Captions</span>
        <input
          type="checkbox"
          checked={jack.captionsEnabled}
          onChange={(e) => jack.setCaptionsEnabled(e.target.checked)}
        />
      </label>

      <label className="jack-settings-row jack-settings-checkbox">
        <span className="jack-settings-label">Browser voice fallback</span>
        <input
          type="checkbox"
          checked={jack.browserFallbackEnabled}
          onChange={(e) => jack.setBrowserFallbackEnabled(e.target.checked)}
        />
      </label>
      <p className="jack-settings-note">Only used if Jack&apos;s own voice (Kokoro) is unreachable, and only when this is on.</p>

      <hr className="jack-settings-divider" />
      <p className="jack-settings-section-title">Speech Recognition</p>
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
        Applies everywhere Jack listens (ambient, push-to-talk, Ask Jack, Practice) -- no per-screen override. Test is
        experimental and never used automatically if unavailable; switch back to Approved if it fails.
      </p>

      {jack.asrDiagnostics.length > 0 && (
        <details className="jack-settings-diagnostics">
          <summary>Diagnostics ({jack.asrDiagnostics.length})</summary>
          <ul className="jack-asr-diag-list">
            {jack.asrDiagnostics.map((d) => (
              <li key={d.id} className="jack-asr-diag-row">
                <span className="jack-asr-diag-provider">{d.provider}</span>
                <span className="jack-asr-diag-latency">{d.latencyMs}ms</span>
                <span className="jack-asr-diag-outcome">
                  {!d.success ? "failed" : d.downstreamOk === undefined ? "ignored" : d.downstreamOk ? "ok" : "no-match"}
                </span>
                <span className="jack-asr-diag-transcript">{d.transcript || "(empty)"}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <JackPerformancePanel traces={jack.perfTraces} />

      <button type="button" className="jack-settings-close" onClick={onClose} aria-label="Close settings">Done</button>
    </div>
  );
}

"use client";

import type { UseSpeechResult } from "../hooks/useSpeech";

export interface SubtitleBarProps {
  speech: UseSpeechResult;
  onPlay: () => void;
  playLabel?: string;
  /** Multi-persona milestone: the assistant's current spoken/displayed name (see JackProvider's assistantName). */
  name?: string;
}

export function SubtitleBar({ speech, onPlay, playLabel, name = "Jack" }: SubtitleBarProps) {
  const resolvedPlayLabel = playLabel ?? `Play with ${name}'s voice`;
  if (!speech.supported) {
    return (
      <div className="subtitle-bar unsupported" role="status">
        Voice playback isn&apos;t available in this browser.
      </div>
    );
  }

  return (
    <div className="subtitle-bar">
      <div className="subtitle-controls">
        {!speech.isSpeaking && (
          <button type="button" className="speech-btn primary" onClick={onPlay} aria-label={resolvedPlayLabel}>
            ▶ Play
          </button>
        )}
        {speech.isSpeaking && !speech.isPaused && (
          <button type="button" className="speech-btn" onClick={speech.pause} aria-label={`Pause ${name}'s voice`}>
            ❚❚ Pause
          </button>
        )}
        {speech.isSpeaking && speech.isPaused && (
          <button type="button" className="speech-btn" onClick={speech.resume} aria-label={`Resume ${name}'s voice`}>
            ▶ Resume
          </button>
        )}
        <button
          type="button"
          className="speech-btn"
          onClick={speech.stop}
          aria-label={`Stop ${name}'s voice`}
          disabled={!speech.isSpeaking}
        >
          ■ Stop
        </button>
        <button type="button" className="speech-btn" onClick={speech.replay} aria-label="Replay from the start">
          ↺ Replay
        </button>
        <label className="speech-slider">
          Rate
          <input
            type="range"
            min={0.6}
            max={1.6}
            step={0.1}
            value={speech.rate}
            onChange={(e) => speech.setRate(Number(e.target.value))}
            aria-label="Speech rate"
          />
        </label>
        <label className="speech-slider">
          Volume
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={speech.volume}
            onChange={(e) => speech.setVolume(Number(e.target.value))}
            aria-label="Speech volume"
          />
        </label>
      </div>
      {speech.error && <div className="speech-error" role="alert">{speech.error}</div>}
      {speech.isSpeaking && (
        <p className="subtitle-text" aria-live="polite">
          {speech.currentSentence}
        </p>
      )}
    </div>
  );
}

"use client";

import type { UseSpeechResult } from "../hooks/useSpeech";

export interface SubtitleBarProps {
  speech: UseSpeechResult;
  onPlay: () => void;
  playLabel?: string;
}

export function SubtitleBar({ speech, onPlay, playLabel = "Play with Jack's voice" }: SubtitleBarProps) {
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
          <button type="button" className="speech-btn primary" onClick={onPlay} aria-label={playLabel}>
            ▶ Play
          </button>
        )}
        {speech.isSpeaking && !speech.isPaused && (
          <button type="button" className="speech-btn" onClick={speech.pause} aria-label="Pause Jack's voice">
            ❚❚ Pause
          </button>
        )}
        {speech.isSpeaking && speech.isPaused && (
          <button type="button" className="speech-btn" onClick={speech.resume} aria-label="Resume Jack's voice">
            ▶ Resume
          </button>
        )}
        <button
          type="button"
          className="speech-btn"
          onClick={speech.stop}
          aria-label="Stop Jack's voice"
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

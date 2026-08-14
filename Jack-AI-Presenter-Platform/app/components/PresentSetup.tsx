"use client";

import { useEffect, useState } from "react";
import { JackOrb } from "../JackOrb";
import { useJack } from "../jack/JackProvider";
import type { AudienceQuestionPolicy, ControlMode } from "../jack/types";

const CONTROL_MODES: { id: ControlMode; label: string; description: string }[] = [
  { id: "presenterLeads", label: "Presenter leads", description: "You control the slides. Jack speaks only when asked or scheduled." },
  { id: "jackLeads", label: "Jack leads", description: "Jack narrates and advances slides. You can interrupt or take back control anytime." },
  { id: "shared", label: "Shared", description: "You and Jack alternate control with explicit handoffs." },
];

const QUESTION_POLICIES: { id: AudienceQuestionPolicy; label: string }[] = [
  { id: "askPresenterFirst", label: "Ask me first" },
  { id: "jackAnswers", label: "Jack answers directly" },
  { id: "presenterAnswers", label: "I answer, Jack stays quiet" },
  { id: "moderatedQueue", label: "Queue for moderated Q&A" },
];

export function PresentSetup({ onReady, title }: { onReady: () => void; title: string }) {
  const jack = useJack();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (starting && jack.connectionStatus === "connected") onReady();
  }, [starting, jack.connectionStatus, onReady]);

  const handleStart = async () => {
    setStarting(true);
    await jack.wake();
  };

  const connecting = jack.connectionStatus === "connecting";
  const failed = jack.connectionStatus === "error" && starting;

  return (
    <section className="stage-shell present-setup">
      <div className="jack-stage compact">
        <div className="orb-wrap"><JackOrb state={jack.orb.orbState} size={140} /></div>
        <div className="jack-status">
          <i /> <strong>{jack.orb.label.toUpperCase()}</strong>
          <small>{jack.orb.description}</small>
        </div>
      </div>

      <h2>Before you present: {title}</h2>

      <div className="setup-grid">
        <fieldset>
          <legend>Presentation control</legend>
          {CONTROL_MODES.map((mode) => (
            <label key={mode.id} className="setup-radio">
              <input
                type="radio"
                name="controlMode"
                checked={jack.controlMode === mode.id}
                onChange={() => jack.setControlMode(mode.id)}
              />
              <span><strong>{mode.label}</strong><small>{mode.description}</small></span>
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Audience questions</legend>
          <select value={jack.audienceQuestionPolicy} onChange={(e) => jack.setAudienceQuestionPolicy(e.target.value as AudienceQuestionPolicy)}>
            {QUESTION_POLICIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>

          <legend>Language</legend>
          <input type="text" value={jack.language} onChange={(e) => jack.setLanguage(e.target.value)} placeholder="English" />

          <label className="setup-checkbox">
            <input type="checkbox" checked={jack.humourEnabled} onChange={(e) => jack.setHumourEnabled(e.target.checked)} />
            Allow one short opening joke
          </label>
        </fieldset>
      </div>

      {jack.lastError && <p className="speech-error" role="alert">{jack.lastError}</p>}

      <div className="setup-actions">
        <button type="button" className="primary" onClick={handleStart} disabled={connecting}>
          {connecting ? "Connecting…" : failed ? "Retry" : "Start presentation"}
        </button>
        <p className="setup-note">
          Starting will ask for microphone permission and connect to OpenAI Realtime. Jack won&rsquo;t speak until you explicitly ask.
        </p>
      </div>
    </section>
  );
}

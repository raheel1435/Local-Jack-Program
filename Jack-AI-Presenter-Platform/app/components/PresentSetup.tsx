"use client";

import { JackOrb } from "../JackOrb";
import { useJack } from "../jack/JackProvider";
import type { AudienceQuestionPolicy, ControlMode } from "../jack/types";
import { LANGUAGE_OPTIONS, VOICE_OPTIONS } from "../jack/voiceSettings";
import { AsrProviderSelector } from "./AsrProviderSelector";
import { AiProviderSelector } from "./AiProviderSelector";

// Multi-persona milestone: these templates keep the literal word "Jack" --
// swapped for whichever assistant name is actually selected via
// withAssistantName() at render time below, same pattern narration.ts and
// JackProvider's pickGreeting already use, rather than restructuring every
// entry into a function.
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

function withAssistantName(text: string, name: string): string {
  return text.replace(/\bJack\b/g, name);
}

export function PresentSetup({ onReady, title }: { onReady: () => void; title: string }) {
  const jack = useJack();
  const activeLanguage = LANGUAGE_OPTIONS.find((l) => l.id === jack.language);
  // Multi-persona milestone: this used to be a hardcoded "Jack" -- now
  // reflects whichever voice is actually selected below, since that's what
  // decides the assistant's spoken name (see JackProvider's assistantName).
  const activeVoiceLabel = VOICE_OPTIONS.find((v) => v.id === jack.voice)?.label ?? "Jack";

  // Manual presentation must always be reachable (Phase 9): the presenter
  // proceeds immediately. Jack's local voice and command pipeline connects
  // on demand from there, same as
  // Practice/Ask Jack -- neither of those gates entry on a live connection
  // either, and Present shouldn't be the one mode that becomes unusable
  // when Jack Local AI is unreachable.
  const handleStart = () => {
    // "Jack leads" auto-starts narration once the session mounts (see
    // PresentStage's own effect) -- but that mount happens asynchronously,
    // well after this click's own synchronous execution ends, so it can't
    // be the thing that satisfies the browser's autoplay-gesture
    // requirement for Jack's first audio. unlockSpeech() runs synchronously
    // here, inside this real click, and does nothing else. Ready/wake stays
    // silent; the first autonomous narration supplies the introduction.
    if (jack.controlMode === "jackLeads") jack.unlockSpeech();
    // Mic on by default the moment a presentation session starts (latency-
    // fix milestone follow-up), in EVERY control mode -- not just once the
    // user clicks the mic button. Purely arming ambient listening; Jack
    // still never speaks a word on his own from this -- finishBargeInCapture
    // discards every transcript that doesn't name him. setAmbientListening
    // Enabled(true) also unlocks Jack's speech output (same real click),
    // needed the moment the user addresses him in ANY mode, not just
    // "Jack leads". This runs once per session start; the user's own
    // subsequent mic toggle is the only thing that changes it after this.
    jack.setAmbientListeningEnabled(true);
    onReady();
  };

  return (
    <section className="stage-shell present-setup">
      <div className="jack-stage compact">
        <div className="orb-wrap"><JackOrb state={jack.orb.orbState} size={140} name={jack.assistantName} /></div>
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
              <span><strong>{withAssistantName(mode.label, jack.assistantName)}</strong><small>{withAssistantName(mode.description, jack.assistantName)}</small></span>
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Audience questions</legend>
          <select value={jack.audienceQuestionPolicy} onChange={(e) => jack.setAudienceQuestionPolicy(e.target.value as AudienceQuestionPolicy)}>
            {QUESTION_POLICIES.map((p) => <option key={p.id} value={p.id}>{withAssistantName(p.label, jack.assistantName)}</option>)}
          </select>

          <label className="setup-checkbox">
            <input type="checkbox" checked={jack.humourEnabled} onChange={(e) => jack.setHumourEnabled(e.target.checked)} />
            Allow one short opening joke
          </label>
        </fieldset>

        <fieldset>
          <legend>AI presenter</legend>
          <p className="setup-static">{activeVoiceLabel}</p>

          <legend>Language</legend>
          <select value={jack.language} onChange={(e) => jack.setLanguage(e.target.value)}>
            {LANGUAGE_OPTIONS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          {activeLanguage?.limitation && <p className="setup-note">{activeLanguage.limitation}</p>}

          <legend>Voice</legend>
          <select value={jack.voice} onChange={(e) => jack.setVoice(e.target.value)}>
            {VOICE_OPTIONS.map((v) => <option key={v.id} value={v.id}>{v.label} -- {v.gender} · {v.accent}</option>)}
          </select>

          <legend>AI Assistant</legend>
          <AiProviderSelector />

          <legend>Speech Recognition</legend>
          <AsrProviderSelector />

          <label className="setup-checkbox">
            <input type="checkbox" checked={jack.captionsEnabled} onChange={(e) => jack.setCaptionsEnabled(e.target.checked)} />
            Show captions of what {jack.assistantName} says
          </label>

          <label className="setup-checkbox">
            <input type="checkbox" checked={jack.browserFallbackEnabled} onChange={(e) => jack.setBrowserFallbackEnabled(e.target.checked)} />
            Allow browser voice fallback if {jack.assistantName}&apos;s voice is unreachable
          </label>
        </fieldset>
      </div>

      {jack.lastError && <p className="speech-error" role="alert">{jack.lastError}</p>}

      <div className="setup-actions">
        <button type="button" className="primary" onClick={handleStart}>
          Start presentation
        </button>
        <p className="setup-note">
          Manual navigation and typed {jack.assistantName} commands work immediately. The presentation microphone and voice commands use the local Jack AI service.
        </p>
      </div>
    </section>
  );
}

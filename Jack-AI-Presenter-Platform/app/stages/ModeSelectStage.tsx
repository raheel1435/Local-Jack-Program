"use client";

import { JackOrb } from "../JackOrb";
import { useJack } from "../jack/JackProvider";
import { useSession } from "../session/SessionContext";
import type { PresentMode } from "../session/types";

const MODES: { id: PresentMode; icon: string; label: string; title: string; description: string }[] = [
  {
    id: "practice",
    icon: "◉",
    label: "PRACTICE",
    title: "Rehearse before it matters.",
    description: "Run through your material privately with a timer and microphone. Jack listens if you let it, and shows you what it could actually measure.",
  },
  {
    id: "present",
    icon: "▶",
    label: "PRESENT",
    title: "Deliver with Jack beside you.",
    description: "Full-screen presenting with your real content, speaker notes, and Jack tracking which part you're on.",
  },
  {
    id: "askJack",
    icon: "⌁",
    label: "ASK JACK",
    title: "Know your material deeply.",
    description: "Ask questions about anything you uploaded and get answers pulled directly from your files.",
  },
];

// Multi-persona milestone: same pattern as PresentSetup.tsx's identical
// helper -- these templates keep the literal word "Jack", swapped for
// whichever assistant name is actually selected at render time.
function withAssistantName(text: string, name: string): string {
  return text.replace(/\bJack\b/g, name);
}

export function ModeSelectStage() {
  const { session, dispatch } = useSession();
  const jack = useJack();

  const readyFiles = session.files.filter((f) => f.status === "ready" || f.status === "unsupported");
  const totalSections = readyFiles.reduce(
    (sum, f) => sum + (session.parsedDocs[f.id]?.sectionCount ?? 0),
    0,
  );
  const title = readyFiles.length === 1 ? readyFiles[0].name : `${readyFiles.length} files`;

  return (
    <section className="stage-shell mode-select-stage">
      <button type="button" className="text-button back-link" onClick={() => dispatch({ type: "BACK_TO_UPLOAD" })}>
        ← Back
      </button>

      <div className="jack-stage compact">
        <div className="orb-wrap"><JackOrb state={session.jackState} size={140} name={jack.assistantName} /></div>
        <div className="jack-status">
          <i /> <strong>{jack.assistantName.toUpperCase()} IS AVAILABLE</strong>
          <small>Analysis complete</small>
        </div>
      </div>

      <div className="mode-select-summary">
        <strong>{title}</strong>
        <span>{totalSections} section{totalSections === 1 ? "" : "s"} detected · Analysis complete</span>
      </div>

      <label className="mode-select-name">
        <span>Your name</span>
        <input
          type="text"
          value={jack.presenterName}
          onChange={(e) => jack.setPresenterName(e.target.value)}
          placeholder="e.g. Alex"
        />
        <small>{jack.assistantName} stays quiet until you call it -- it&apos;ll greet you by name the first time.</small>
      </label>

      <div className="section-heading">
        <h2>How would you like {jack.assistantName} to help?</h2>
      </div>

      <div className="mode-grid">
        {MODES.map((mode) => (
          <article key={mode.id}>
            <div className="mode-icon">{mode.icon}</div>
            <span>{mode.id === "askJack" ? `ASK ${jack.assistantName.toUpperCase()}` : mode.label}</span>
            <h3>{withAssistantName(mode.title, jack.assistantName)}</h3>
            <p>{withAssistantName(mode.description, jack.assistantName)}</p>
            <button type="button" onClick={() => dispatch({ type: "SELECT_MODE", mode: mode.id })}>
              {mode.id === "practice" ? "Start a practice" : mode.id === "present" ? `Present with ${jack.assistantName}` : "Open conversation"} <b>→</b>
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

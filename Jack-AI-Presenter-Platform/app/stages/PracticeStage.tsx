"use client";

import { useEffect, useRef, useState } from "react";
import { JackOrb } from "../JackOrb";
import { MicDiagnostics } from "../components/MicDiagnostics";
import { SlideVisual } from "../components/SlideVisual";
import { useJack } from "../jack/JackProvider";
import { searchDocuments } from "../jack/documentContext";
import { fail, ok, type PresentationController } from "../jack/presentationController";
import { isDevDiagnosticsEnabled } from "../lib/devDiagnostics";
import { useSession } from "../session/SessionContext";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function PracticeStage() {
  const { session, dispatch } = useSession();
  const activeFile = session.files.find((f) => f.id === session.activeFileId) ?? session.files[0];
  const doc = activeFile ? session.parsedDocs[activeFile.id] : undefined;
  const sections = doc?.sections ?? [];
  const jack = useJack();

  const [sectionIndex, setSectionIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const accumulatedRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      setElapsedMs(accumulatedRef.current + (Date.now() - (startedAtRef.current ?? Date.now())));
    }, 250);
    return () => clearInterval(interval);
  }, [running]);

  const latest = useRef({ sectionIndex, sections, doc, dispatch, activeFile });
  useEffect(() => {
    latest.current = { sectionIndex, sections, doc, dispatch, activeFile };
  });

  const controllerRef = useRef<PresentationController>({
    modeName: "Practice",
    getPresentationContext: () => {
      const s = latest.current;
      return ok({ title: s.doc?.title ?? "", totalSlides: s.sections.length, currentSlideIndex: s.sectionIndex, mode: "practice" });
    },
    startPresentation: () => {
      start();
      return ok({ started: true as const, index: latest.current.sectionIndex });
    },
    pausePresentation: () => {
      pause();
      return ok({ paused: true as const });
    },
    resumePresentation: () => {
      start();
      return ok({ resumed: true as const, index: latest.current.sectionIndex });
    },
    endPresentation: () => {
      finish();
      return ok({ ended: true as const });
    },
    goToNextSlide: () => {
      const s = latest.current;
      const index = s.sectionIndex + 1;
      if (index >= s.sections.length) return fail("Already on the last section.");
      setSectionIndex(index);
      return ok({ index, total: s.sections.length, title: s.sections[index]?.title });
    },
    goToPreviousSlide: () => {
      const s = latest.current;
      const index = s.sectionIndex - 1;
      if (index < 0) return fail("Already on the first section.");
      setSectionIndex(index);
      return ok({ index, total: s.sections.length, title: s.sections[index]?.title });
    },
    goToSlide: (index) => {
      const s = latest.current;
      if (index < 0 || index >= s.sections.length) return fail(`Section ${index} doesn't exist.`);
      setSectionIndex(index);
      return ok({ index, total: s.sections.length, title: s.sections[index]?.title });
    },
    getCurrentSlide: () => {
      const s = latest.current;
      return ok({ index: s.sectionIndex, total: s.sections.length, title: s.sections[s.sectionIndex]?.title });
    },
    getSlideContent: (index) => {
      const s = latest.current;
      const i = index ?? s.sectionIndex;
      const section = s.sections[i];
      if (!section) return fail(`Section ${i} doesn't exist.`);
      return ok({ index: i, title: section.title, text: section.text });
    },
    getSpeakerNotes: (index) => {
      const s = latest.current;
      const i = index ?? s.sectionIndex;
      const section = s.sections[i];
      if (!section) return fail(`Section ${i} doesn't exist.`);
      return ok({ index: i, notes: section.speakerNotes ?? null });
    },
    showSpeakerNotes: () => fail("Speaker notes aren't shown in Practice mode."),
    hideSpeakerNotes: () => fail("Speaker notes aren't shown in Practice mode."),
    takePresentationControl: () => fail("Presentation control handoff isn't used in Practice mode."),
    handControlToPresenter: () => fail("Presentation control handoff isn't used in Practice mode."),
    setPresentationPace: (pace) => ok({ pace }),
    getRemainingTime: () => ok({ remainingMs: null, message: "No time limit has been set for this practice session." }),
    searchUploadedDocuments: (query) => {
      const s = latest.current;
      return s.doc ? ok({ matches: searchDocuments(query, [s.doc], s.activeFile.id) }) : ok({ matches: [] });
    },
    showRelevantSource: () => fail("Not available in Practice mode."),
    queueAudienceQuestion: () => fail(`There's no audience in Practice mode — ask ${jack.assistantName} directly instead.`),
    markQuestionForFollowUp: () => fail("There's no audience in Practice mode."),
    syncJackToCurrentSlide: () => {
      const s = latest.current;
      return ok({ index: s.sectionIndex, total: s.sections.length, title: s.sections[s.sectionIndex]?.title });
    },
    setAudienceQuestionPolicy: () => fail("Not applicable in Practice mode."),
  });

  useEffect(() => {
    jack.registerController("Practice", controllerRef.current);
    return () => {
      jack.unregisterController();
      jack.sleepJackLocal();
      jack.setAmbientListeningEnabled(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function start() {
    startedAtRef.current = Date.now();
    setRunning(true);
    setFinished(false);
  }
  function pause() {
    if (startedAtRef.current) accumulatedRef.current += Date.now() - startedAtRef.current;
    startedAtRef.current = null;
    setRunning(false);
  }
  function finish() {
    pause();
    setFinished(true);
  }
  function practiceAgain() {
    accumulatedRef.current = 0;
    startedAtRef.current = null;
    setElapsedMs(0);
    setRunning(false);
    setFinished(false);
    setSectionIndex(0);
  }

  const currentSection = sections[sectionIndex];
  const devDiagnosticsEnabled = isDevDiagnosticsEnabled();
  const feedback = jack.lastCommandOutcome
    ? {
        prefix: jack.lastCommandKind === "interruption" ? "Interruption" : null,
        heard: jack.lastCommandTranscript,
        outcome: jack.lastCommandOutcome,
      }
    : null;

  if (!activeFile || !doc) {
    return (
      <section className="stage-shell practice-stage">
        <p>No file selected. <button type="button" className="text-button" onClick={() => dispatch({ type: "BACK_TO_MODE_SELECT" })}>Back to mode select</button></p>
      </section>
    );
  }

  return (
    <section className="stage-shell practice-stage">
      <div className="practice-header">
        <button type="button" className="text-button" onClick={() => dispatch({ type: "BACK_TO_MODE_SELECT" })}>← Back</button>
        <div className="practice-timer">{formatElapsed(elapsedMs)}</div>
        <div className="jack-mini"><JackOrb state={jack.orb.orbState} size={52} name={jack.assistantName} /></div>
      </div>

      {sections.length === 0 ? (
        <p>{doc.warnings[0] ?? "This file's content couldn't be extracted."}</p>
      ) : (
        <>
          <div className="practice-content">
            <SlideVisual doc={doc} activeFile={activeFile} sectionIndex={sectionIndex} currentSection={currentSection} />
          </div>
          <div className="practice-nav">
            <button type="button" onClick={() => setSectionIndex((i) => Math.max(0, i - 1))} disabled={sectionIndex === 0} aria-label="Previous section">‹ Prev</button>
            <span>{sectionIndex + 1} / {sections.length}</span>
            <button type="button" onClick={() => setSectionIndex((i) => Math.min(sections.length - 1, i + 1))} disabled={sectionIndex === sections.length - 1} aria-label="Next section">Next ›</button>
          </div>
        </>
      )}

      <div className="practice-controls">
        {/* Only offer "Start practice" before the timer has ever run -- once
            paused mid-practice (running=false, elapsedMs>0), only Resume and
            Finish make sense; showing Start practice again alongside Resume
            read as a duplicate/confusing option. */}
        {!running && !finished && elapsedMs === 0 && <button type="button" className="primary" onClick={start}>Start practice</button>}
        {running && <button type="button" className="secondary" onClick={pause}>Pause</button>}
        {!running && elapsedMs > 0 && !finished && <button type="button" className="secondary" onClick={start}>Resume</button>}
        {(running || elapsedMs > 0) && !finished && <button type="button" className="secondary" onClick={finish}>Finish</button>}
        {finished && <button type="button" className="primary" onClick={practiceAgain}>Practice again</button>}
        <button
          type="button"
          className={`jack-mic-btn ${jack.ambientListeningEnabled ? "state-listening" : ""}`}
          onClick={() => jack.setAmbientListeningEnabled(!jack.ambientListeningEnabled)}
          disabled={jack.jackLocalHealth?.whisper === "unavailable"}
          aria-pressed={jack.ambientListeningEnabled}
          aria-label={jack.ambientListeningEnabled ? "Turn mic off" : `Turn mic on -- ask ${jack.assistantName} anything by name while you practice`}
          title={jack.ambientListeningEnabled ? "Turn mic off" : `Turn mic on -- say "${jack.assistantName}" to ask a question or get an explanation`}
        >
          🎤
        </button>
      </div>

      <p className="practice-connection">
        {jack.localUnavailable
          ? "Jack Local AI is unavailable — practicing without live AI feedback."
          : jack.ambientListeningEnabled
            ? `${jack.assistantName} is listening -- say "${jack.assistantName}" to ask a question or get an explanation.`
            : `${jack.assistantName} is ready -- turn the mic on to ask questions by voice, or use typed commands elsewhere.`}
      </p>

      {devDiagnosticsEnabled && <MicDiagnostics jack={jack} />}
      {jack.lastError && <p className="speech-error" role="alert">{jack.lastError}</p>}
      {feedback && (
        <p className={`jack-mic-feedback ${feedback.outcome.ok ? "" : "speech-error"}`} aria-live="polite">
          {feedback.prefix && `${feedback.prefix}: `}
          {feedback.heard && `Heard: “${feedback.heard}.” `}
          {feedback.outcome.ok ? feedback.outcome.message ?? "Done." : feedback.outcome.message}
        </p>
      )}

      {finished && (
        <div className="practice-feedback">
          <h3>Practice summary</h3>
          <ul>
            <li><strong>Time practiced:</strong> {formatElapsed(elapsedMs)}</li>
            <li><strong>Filler words:</strong> <span className="unavailable">Not available</span></li>
            <li><strong>Pacing score:</strong> <span className="unavailable">Not available</span></li>
          </ul>
        </div>
      )}
    </section>
  );
}

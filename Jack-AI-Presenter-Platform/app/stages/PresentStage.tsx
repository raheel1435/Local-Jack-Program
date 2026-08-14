"use client";

import { useEffect, useRef, useState } from "react";
import { JackOrb } from "../JackOrb";
import { JackStatusBar } from "../components/JackStatusBar";
import { MicButton } from "../components/MicButton";
import { PresentSetup } from "../components/PresentSetup";
import { useAutoHideControls } from "../hooks/useAutoHideControls";
import { useFullscreen } from "../hooks/useFullscreen";
import { useSpeech } from "../hooks/useSpeech";
import { useJack } from "../jack/JackProvider";
import { searchDocuments } from "../jack/documentContext";
import { fail, ok, type PresentationController } from "../jack/presentationController";
import { openPdfForRender, type PdfRenderHandle } from "../lib/parsers/pdf";
import { useSession } from "../session/SessionContext";
import type { ParsedDocument, SessionAction, UploadedFile } from "../session/types";

export function PresentStage() {
  const { session, dispatch } = useSession();
  const activeFile = session.files.find((f) => f.id === session.activeFileId) ?? session.files[0];
  const doc = activeFile ? session.parsedDocs[activeFile.id] : undefined;

  if (!activeFile || !doc) {
    return (
      <section className="stage-shell present-stage">
        <p>No file selected. <button type="button" className="text-button" onClick={() => dispatch({ type: "BACK_TO_MODE_SELECT" })}>Back to mode select</button></p>
      </section>
    );
  }

  if (doc.sections.length === 0) {
    return (
      <section className="stage-shell present-stage">
        <div className="jack-stage compact"><div className="orb-wrap"><JackOrb state="alert" size={120} /></div></div>
        <h2>{activeFile.name} can&apos;t be presented</h2>
        <p>{doc.warnings[0] ?? "This file's content couldn't be extracted."}</p>
        <button type="button" className="secondary" onClick={() => dispatch({ type: "BACK_TO_MODE_SELECT" })}>← Back to mode select</button>
      </section>
    );
  }

  // Keyed by file id so all per-file navigation/state resets cleanly on file switch.
  return <PresentGate key={activeFile.id} activeFile={activeFile} doc={doc} dispatch={dispatch} />;
}

function PresentGate(props: { activeFile: UploadedFile; doc: ParsedDocument; dispatch: (action: SessionAction) => void }) {
  const [ready, setReady] = useState(false);
  if (!ready) return <PresentSetup title={props.doc.title} onReady={() => setReady(true)} />;
  return <PresentSession {...props} />;
}

function PresentSession({
  activeFile,
  doc,
  dispatch,
}: {
  activeFile: UploadedFile;
  doc: ParsedDocument;
  dispatch: (action: SessionAction) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sections = doc.sections;
  const jack = useJack();

  const [sectionIndex, setSectionIndex] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [followMode, setFollowMode] = useState<"auto" | "manual">("auto");
  const [jackSectionIndex, setJackSectionIndex] = useState<number | null>(null);
  const [pdfHandle, setPdfHandle] = useState<PdfRenderHandle | null>(null);
  const [paused, setPaused] = useState(false);
  const [offlineVoiceEnabled, setOfflineVoiceEnabled] = useState(false);

  const offlineSpeech = useSpeech();
  const controlsVisible = useAutoHideControls(3500);
  const fullscreen = useFullscreen(stageRef);

  const currentSection = sections[sectionIndex];
  const inSync = jackSectionIndex === null || jackSectionIndex === sectionIndex;
  const isOffline = jack.connectionStatus !== "connected";

  // Load the PDF document proxy for canvas rendering.
  useEffect(() => {
    if (doc.format !== "pdf") return;
    let cancelled = false;
    openPdfForRender(activeFile.file).then((handle) => {
      if (cancelled) void handle.destroy();
      else setPdfHandle(handle);
    });
    return () => {
      cancelled = true;
    };
  }, [doc.format, activeFile]);

  useEffect(() => {
    return () => {
      void pdfHandle?.destroy();
    };
  }, [pdfHandle]);

  // Render the current PDF page to canvas.
  useEffect(() => {
    if (!pdfHandle) return;
    let cancelled = false;
    (async () => {
      const page = await pdfHandle.pdf.getPage(sectionIndex + 1);
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const containerWidth = canvas.parentElement?.clientWidth ?? 900;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, containerWidth / base.width) });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfHandle, sectionIndex]);

  function goTo(index: number) {
    if (index < 0 || index >= sections.length) return;
    setSectionIndex(index);
    if (followMode === "manual" && jackSectionIndex !== null && jackSectionIndex !== index) return;
    setJackSectionIndex(index);
  }

  // Keyboard navigation, ignored while typing in a form control.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "ArrowRight") goTo(sectionIndex + 1);
      if (e.key === "ArrowLeft") goTo(sectionIndex - 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionIndex, sections.length, followMode]);

  function syncJackToThisSlide() {
    setJackSectionIndex(sectionIndex);
    jack.sendText(`(Presenter synced you to slide ${sectionIndex + 1}: "${currentSection?.title ?? ""}". Please continue from here.)`);
  }

  // --- Real PresentationController wired to Jack's tools, kept fresh via a ref so it's registered once. ---
  const latest = useRef({ sectionIndex, sections, doc, showNotes, paused, dispatch, activeFile });
  useEffect(() => {
    latest.current = { sectionIndex, sections, doc, showNotes, paused, dispatch, activeFile };
  });

  const controllerRef = useRef<PresentationController>({
    modeName: "Present",
    getPresentationContext: () => {
      const s = latest.current;
      return ok({ title: s.doc.title, totalSlides: s.sections.length, currentSlideIndex: s.sectionIndex, mode: "present" });
    },
    startPresentation: () => ok({ started: true as const }),
    pausePresentation: () => {
      setPaused(true);
      return ok({ paused: true as const });
    },
    resumePresentation: () => {
      setPaused(false);
      return ok({ resumed: true as const });
    },
    endPresentation: () => {
      latest.current.dispatch({ type: "BACK_TO_MODE_SELECT" });
      return ok({ ended: true as const });
    },
    goToNextSlide: () => {
      const s = latest.current;
      const index = s.sectionIndex + 1;
      if (index >= s.sections.length) return fail("Already on the last slide.");
      setSectionIndex(index);
      setJackSectionIndex(index);
      return ok({ index, total: s.sections.length, title: s.sections[index]?.title });
    },
    goToPreviousSlide: () => {
      const s = latest.current;
      const index = s.sectionIndex - 1;
      if (index < 0) return fail("Already on the first slide.");
      setSectionIndex(index);
      setJackSectionIndex(index);
      return ok({ index, total: s.sections.length, title: s.sections[index]?.title });
    },
    goToSlide: (index) => {
      const s = latest.current;
      if (index < 0 || index >= s.sections.length) return fail(`Slide ${index} doesn't exist. There are ${s.sections.length} slides (0-${s.sections.length - 1}).`);
      setSectionIndex(index);
      setJackSectionIndex(index);
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
      if (!section) return fail(`Slide ${i} doesn't exist.`);
      return ok({ index: i, title: section.title, text: section.text });
    },
    getSpeakerNotes: (index) => {
      const s = latest.current;
      const i = index ?? s.sectionIndex;
      const section = s.sections[i];
      if (!section) return fail(`Slide ${i} doesn't exist.`);
      return ok({ index: i, notes: section.speakerNotes ?? null });
    },
    showSpeakerNotes: () => {
      setShowNotes(true);
      return ok({ shown: true as const });
    },
    hideSpeakerNotes: () => {
      setShowNotes(false);
      return ok({ shown: false as const });
    },
    takePresentationControl: () => ok({ owner: "jack" as const }),
    handControlToPresenter: () => ok({ owner: "presenter" as const }),
    setPresentationPace: (pace) => ok({ pace }),
    getRemainingTime: () => ok({ remainingMs: null, message: "No time limit has been set for this session." }),
    searchUploadedDocuments: (query) => {
      const s = latest.current;
      return ok({ matches: searchDocuments(query, [s.doc], s.activeFile.id) });
    },
    showRelevantSource: () => ok({ shown: true as const }),
    queueAudienceQuestion: () => fail("Audience question queueing isn't wired up in this mode yet."),
    markQuestionForFollowUp: () => fail("Audience question queueing isn't wired up in this mode yet."),
    syncJackToCurrentSlide: () => {
      const s = latest.current;
      setJackSectionIndex(s.sectionIndex);
      return ok({ index: s.sectionIndex, total: s.sections.length, title: s.sections[s.sectionIndex]?.title });
    },
    setAudienceQuestionPolicy: (policy) => ok({ policy }),
  });

  useEffect(() => {
    jack.registerController("Present", controllerRef.current);
    return () => jack.unregisterController();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      jack.sleep();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleMicToggle() {
    if (jack.micStatus === "listening") jack.mute();
    else if (jack.micStatus === "muted") jack.unmute();
  }

  return (
    <div ref={stageRef} className="present-stage-root">
      <JackStatusBar
        jackState={jack.orb.orbState}
        jackLabel={jack.orb.label}
        jackSectionLabel={jackSectionIndex !== null ? sections[jackSectionIndex]?.title ?? `Section ${jackSectionIndex + 1}` : null}
        displayedSectionLabel={currentSection?.title ?? `Section ${sectionIndex + 1}`}
        inSync={inSync}
        followMode={followMode}
        onToggleFollowMode={() => setFollowMode((m) => (m === "auto" ? "manual" : "auto"))}
        onSync={syncJackToThisSlide}
        connectionStatus={jack.connectionStatus}
        micStatus={jack.micStatus}
        sendingAudioToOpenAI={jack.sendingAudioToOpenAI}
      />

      <div className="present-content">
        {doc.format === "pdf" ? (
          <canvas ref={canvasRef} className="present-pdf-canvas" />
        ) : (
          <div className="present-text-slide">
            {currentSection?.title && <h2>{currentSection.title}</h2>}
            <p>{currentSection?.text}</p>
          </div>
        )}
        <div className="present-orb-corner">
          <JackOrb state={jack.orb.orbState} size={64} />
        </div>
      </div>

      {doc.warnings.length > 0 && <p className="present-warning">{doc.warnings[0]}</p>}
      {paused && <p className="present-warning">Paused · Say &ldquo;Jack, continue&rdquo;</p>}

      {jack.attentionState === "speaking" && jack.currentCaption && (
        <p className="present-subtitle-line" aria-live="polite">{jack.currentCaption}</p>
      )}
      {jack.lastError && <p className="speech-error present-subtitle-line" role="alert">{jack.lastError}</p>}

      {isOffline && (
        <div className="offline-voice-toggle">
          <label className="setup-checkbox">
            <input type="checkbox" checked={offlineVoiceEnabled} onChange={(e) => setOfflineVoiceEnabled(e.target.checked)} />
            Use offline browser voice (not AI — Jack isn&rsquo;t connected)
          </label>
          {offlineVoiceEnabled && offlineSpeech.supported && (
            <div className="offline-voice-controls">
              <button type="button" className="speech-btn" onClick={() => currentSection && offlineSpeech.speak(currentSection.text)}>▶ Read this slide</button>
              {offlineSpeech.isSpeaking && <button type="button" className="speech-btn" onClick={offlineSpeech.stop}>■ Stop</button>}
            </div>
          )}
        </div>
      )}

      {showNotes && (
        <aside className="notes-panel">
          <h3>Speaker notes</h3>
          <p>{currentSection?.speakerNotes || "No speaker notes were found for this slide."}</p>
        </aside>
      )}

      <div className={`present-controls ${controlsVisible ? "" : "controls-hidden"}`}>
        <button type="button" onClick={() => goTo(sectionIndex - 1)} disabled={sectionIndex === 0} aria-label="Previous slide">‹ Prev</button>
        <span className="present-position">{sectionIndex + 1} / {sections.length}</span>
        <div className="present-progress"><i style={{ width: `${((sectionIndex + 1) / sections.length) * 100}%` }} /></div>
        <button type="button" onClick={() => goTo(sectionIndex + 1)} disabled={sectionIndex === sections.length - 1} aria-label="Next slide">Next ›</button>

        <button type="button" onClick={paused ? () => controllerRef.current.resumePresentation() : jack.pause} aria-label={paused ? "Resume" : "Pause Jack"}>
          {paused ? "▶ Resume" : "❚❚ Pause"}
        </button>
        <button type="button" onClick={jack.interrupt} disabled={jack.attentionState !== "speaking"} aria-label="Stop Jack speaking">■ Stop</button>

        <MicButton state={jack.micStatus} level={jack.micLevel} onStart={jack.wake} onStop={jack.sleep} onToggleMute={handleMicToggle} size="small" />
        <button type="button" onClick={() => setShowNotes((v) => !v)} aria-pressed={showNotes} aria-label="Toggle speaker notes">
          Notes
        </button>
        {fullscreen.supported && (
          <button type="button" onClick={fullscreen.toggle} aria-label={fullscreen.isFullscreen ? "Exit full screen" : "Enter full screen"}>
            {fullscreen.isFullscreen ? "⤢ Exit full screen" : "⤢ Full screen"}
          </button>
        )}
        <button
          type="button"
          className="present-exit"
          onClick={() => {
            jack.endSession();
            dispatch({ type: "BACK_TO_MODE_SELECT" });
          }}
          aria-label="Exit presentation"
        >
          Exit
        </button>
      </div>
    </div>
  );
}

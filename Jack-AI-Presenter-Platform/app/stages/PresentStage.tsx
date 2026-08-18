"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { JackOrb } from "../JackOrb";
import { JackStatusBar } from "../components/JackStatusBar";
import { PresentSettingsPopover } from "../components/PresentSettingsPopover";
import { PresentSetup } from "../components/PresentSetup";
import { useAutoHideControls } from "../hooks/useAutoHideControls";
import { useFullscreen } from "../hooks/useFullscreen";
import { useJack } from "../jack/JackProvider";
import { searchDocuments } from "../jack/documentContext";
import { fail, ok, type PresentationController } from "../jack/presentationController";
import { jackApi } from "../lib/jackApi";
import { openPdfForRender, type PdfRenderHandle } from "../lib/parsers/pdf";
import { useSession } from "../session/SessionContext";
import type { ParsedDocument, PresentationStatus, SessionAction, UploadedFile } from "../session/types";

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
  // PPTX visual fidelity (real slide layout via PowerPoint COM -> PDF,
  // entirely separate from the semantic parser Jack's context comes from).
  // "idle"/"converting" while a .pptx file's real visual is being prepared;
  // "ready" once pdfHandle above is showing the converted PDF; "failed" if
  // PowerPoint COM automation is unavailable or the conversion itself
  // failed -- only THEN does the simplified-reading-view warning show, so
  // it's never shown once real fidelity is actually working.
  // Computed directly from doc.format at mount, not set synchronously inside
  // the conversion effect below -- PresentSession remounts fully on file
  // switch (keyed by activeFile.id), so this is always correct for the
  // lifetime of one mount without needing a same-tick setState in the effect.
  const [pptxVisualStatus, setPptxVisualStatus] = useState<"idle" | "converting" | "ready" | "failed">(
    doc.format === "pptx" ? "converting" : "idle",
  );
  const [pptxVisualError, setPptxVisualError] = useState<string | null>(null);
  const [presentationStatus, setPresentationStatus] = useState<PresentationStatus>("presenting");
  const paused = presentationStatus === "paused";
  const [commandPanelOpen, setCommandPanelOpen] = useState(false);
  const [commandInput, setCommandInput] = useState("");
  const [commandBusy, setCommandBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const fullscreen = useFullscreen(stageRef);

  // Shared visibility model for BOTH the top status bar and the bottom
  // controls -- one set of mouse/keyboard/touch listeners, one fade timer,
  // so they always show and hide together rather than as two independently
  // behaving strips. Exceptions below keep chrome visible whenever hiding it
  // would make state genuinely hard to recover or understand: an open
  // command input, open settings, the notes panel, or an error that needs
  // the user's attention.
  //
  // Deliberately NOT keyed on localMicState === "listening" (it used to be):
  // ambient listening is now on for most of a presentation (see
  // JackProvider's arm/disarm effect), so that condition meant the header/
  // footer were pinned visible almost the entire time Jack was presenting --
  // confirmed live as "whenever Jack speaks, the header and footer appear".
  // In fullscreen specifically, chrome (and every secondary overlay below --
  // captions, warnings, feedback lines, diagnostics) is hidden by default so
  // only the slide and the corner orb show; mouse/keyboard activity still
  // reveals it exactly like the windowed view always has. Outside fullscreen
  // there's no "clean stage" expectation, so the mic-setup feedback
  // (requesting/initializing permission) keeps showing there as before.
  const controlsVisible = useAutoHideControls(3500);
  const chromeVisible =
    controlsVisible ||
    commandPanelOpen ||
    settingsOpen ||
    showNotes ||
    Boolean(jack.lastError) ||
    (!fullscreen.isFullscreen && (jack.localMicState === "requesting" || jack.localMicState === "initializing"));
  // Secondary overlays (captions, warnings, mic feedback, diagnostics) follow
  // chromeVisible only while in fullscreen -- outside fullscreen they always
  // show, unaffected, exactly as before.
  const overlaysVisible = !fullscreen.isFullscreen || chromeVisible;

  const currentSection = sections[sectionIndex];
  const inSync = jackSectionIndex === null || jackSectionIndex === sectionIndex;

  // Load the PDF document proxy for canvas rendering -- a native PDF
  // upload renders directly; a .pptx upload first attempts a real
  // PowerPoint-COM visual conversion (see jackApi.convertPptxToPdf) and
  // renders THAT through the exact same canvas path once it succeeds.
  useEffect(() => {
    let cancelled = false;
    if (doc.format === "pdf") {
      openPdfForRender(activeFile.file).then((handle) => {
        if (cancelled) void handle.destroy();
        else setPdfHandle(handle);
      });
      return () => {
        cancelled = true;
      };
    }
    if (doc.format === "pptx") {
      jackApi
        .convertPptxToPdf(activeFile.file)
        .then((pdfBlob) => openPdfForRender(pdfBlob))
        .then((handle) => {
          if (cancelled) {
            void handle.destroy();
            return;
          }
          setPdfHandle(handle);
          setPptxVisualStatus("ready");
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // Honest fallback, not a fake success (Phase 27) -- the existing
          // simplified text view still renders from the semantic parser
          // below; this only controls whether the reading-view warning shows.
          setPptxVisualStatus("failed");
          setPptxVisualError(err instanceof Error ? err.message : "PPTX visual conversion failed.");
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
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
    startPresentation: () => {
      setPresentationStatus("presenting");
      return ok({ started: true as const });
    },
    pausePresentation: () => {
      setPresentationStatus("paused");
      return ok({ paused: true as const });
    },
    resumePresentation: () => {
      setPresentationStatus("presenting");
      return ok({ resumed: true as const });
    },
    endPresentation: () => {
      setPresentationStatus("completed");
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
      jack.sleepJackLocal(); // leaving Present mode resets local activation -- re-entering starts asleep again
      jack.resetPresentationOpening(); // leaving Present mode is a genuinely new session next time (Phase 18)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const localUnavailable =
    jack.jackLocalHealth !== null &&
    jack.jackLocalHealth.llamacpp === "unavailable" &&
    jack.jackLocalHealth.colibri === "unavailable";
  const whisperUnavailable = jack.jackLocalHealth?.whisper === "unavailable";

  async function submitLocalCommand(e: FormEvent) {
    e.preventDefault();
    const text = commandInput.trim();
    if (!text || commandBusy) return;
    setCommandBusy(true);
    setCommandInput("");
    try {
      // runLocalCommand itself records the outcome into jack.lastCommand* --
      // nothing to track locally, which is exactly what avoids the stale-
      // feedback bug this replaced (see the interface comment in JackProvider).
      await jack.runLocalCommand(text, "typed");
    } finally {
      setCommandBusy(false);
    }
  }

  /** The mic button is now a plain on/off toggle for ambient listening
   * (Phase 26) -- JackProvider's barge-in pipeline owns all the actual
   * capture/VAD/transcribe/name-gate/route machinery, continuously, for as
   * long as it's on. Nothing left for this component to orchestrate. */
  function handleLocalMicClick() {
    jack.setAmbientListeningEnabled(!jack.ambientListeningEnabled);
  }

  // Acoustic diagnostics gate (Phase 23): dev build AND an explicit ?dev=1
  // opt-in, never both a normal dev-server session and a normal viewer.
  const devDiagnosticsEnabled =
    Boolean(import.meta.env?.DEV) && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("dev") === "1";

  const localHealth: "checking" | "connected" | "offline" =
    jack.jackLocalHealth === null ? "checking" : localUnavailable ? "offline" : "connected";
  // Mic button/status now reflect the ambient-listening pipeline directly
  // (Phase 26) -- there's no separate push-to-talk ownership concept left,
  // just whichever bargeInPhase the shared recorder is actually in, plus
  // whether the user has the persistent toggle on.
  const micToggledOn = jack.ambientListeningEnabled;
  const presentMicLabel: "off" | "preparing" | "listening" | "processing" =
    jack.bargeInPhase === "capturing"
      ? "processing"
      : jack.bargeInPhase === "armed"
        ? "listening"
        : jack.bargeInPhase === "guarding" || jack.bargeInPhase === "calibrating"
          ? "preparing"
          : jack.localMicState === "requesting" || jack.localMicState === "initializing"
            ? "preparing"
            : micToggledOn
              ? "listening"
              : "off";

  // Single compact feedback line, driven by the ONE shared lastCommand* state
  // in JackProvider -- whichever call (typed, voice, or an interruption) most
  // recently ran is what shows here, never a stale result from an earlier one.
  const feedback = jack.lastCommandOutcome
    ? {
        prefix: jack.lastCommandKind === "interruption" ? "Interruption" : null,
        heard: jack.lastCommandTranscript,
        outcome: jack.lastCommandOutcome,
      }
    : null;

  return (
    <div ref={stageRef} className="present-stage-root">
      <div className={`present-topbar ${chromeVisible ? "" : "controls-hidden"}`}>
        <JackStatusBar
          jackState={jack.orb.orbState}
          jackLabel={jack.orb.label}
          localHealth={localHealth}
          presenterControl={jack.presenterControl}
          isPresentingAutonomously={jack.isPresentingAutonomously}
          micLabel={presentMicLabel}
          slideText={`${sectionIndex + 1} / ${sections.length}`}
          inSync={inSync}
          followMode={followMode}
          onToggleFollowMode={() => setFollowMode((m) => (m === "auto" ? "manual" : "auto"))}
          onSync={syncJackToThisSlide}
          jackAwake={jack.jackAwake}
          onWake={() => void jack.wakeJackLocal()}
          onSleep={jack.sleepJackLocal}
        />
      </div>

      <div className="present-content">
        {doc.format === "pdf" || (doc.format === "pptx" && pptxVisualStatus === "ready") ? (
          <canvas ref={canvasRef} className="present-pdf-canvas" />
        ) : doc.format === "pptx" && pptxVisualStatus === "converting" ? (
          <div className="present-text-slide present-visual-preparing">
            <p>Preparing your slides…</p>
          </div>
        ) : (
          <div className="present-text-slide">
            {currentSection?.title && <h2>{currentSection.title}</h2>}
            <p>{currentSection?.text}</p>
          </div>
        )}
        <div className="present-orb-corner">
          <JackOrb state={jack.orb.orbState} size={192} />
        </div>
      </div>

      {overlaysVisible && doc.warnings.length > 0 && <p className="present-warning">{doc.warnings[0]}</p>}
      {overlaysVisible && doc.format === "pptx" && pptxVisualStatus === "failed" && (
        <p className="present-warning" title={pptxVisualError ?? undefined}>
          Original PowerPoint formatting, images, and layout are not fully preserved — slide text and speaker notes are shown in a simplified reading view.
        </p>
      )}
      {overlaysVisible && paused && <p className="present-warning">Paused · Say &ldquo;Jack, continue&rdquo;</p>}

      {/* Captions default OFF (Phase 3/26): audience hears Jack, doesn't see the
          full narration/Q&A/acknowledgement paragraph, unless explicitly enabled. */}
      {overlaysVisible &&
        jack.captionsEnabled &&
        jack.currentCaption &&
        jack.attentionState !== "sleeping" &&
        jack.attentionState !== "disconnected" && (
          <p className="present-subtitle-line" aria-live="polite">{jack.currentCaption}</p>
        )}
      {overlaysVisible && jack.lastError && <p className="speech-error present-subtitle-line" role="alert">{jack.lastError}</p>}

      {overlaysVisible && localUnavailable && (
        <p className="present-warning">Jack Local AI is unavailable. Manual presentation is still available.</p>
      )}

      {/* Acoustic diagnostics (Phase 23): dev-only, never shown to an audience by
          default -- requires BOTH a dev build and an explicit ?dev=1 opt-in. */}
      {overlaysVisible && devDiagnosticsEnabled && jack.bargeInPhase !== "idle" && (
        <p className="jack-mic-diagnostic" title="Ambient listening diagnostics -- for real-hardware interruption testing">
          mic: {jack.bargeInPhase} · lvl {jack.localMicLevel.toFixed(2)}
          {(jack.bargeInPhase === "armed" || jack.bargeInPhase === "capturing") &&
            ` · floor ${jack.bargeInNoiseFloor.toFixed(2)} · thr ${jack.bargeInThreshold.toFixed(2)}`}
        </p>
      )}

      {overlaysVisible && (jack.localMicState === "requesting" || jack.localMicState === "initializing") && (
        <p className="jack-mic-feedback" aria-live="polite">Preparing the microphone…</p>
      )}
      {overlaysVisible && micToggledOn && jack.bargeInPhase === "idle" && (
        <p className="jack-mic-feedback" aria-live="polite">
          Mic on -- listening for &ldquo;Jack&rdquo;. Press 🎤 again to turn it off.
        </p>
      )}
      {overlaysVisible && jack.localMicError && <p className="jack-mic-feedback speech-error">{jack.localMicError}</p>}
      {overlaysVisible && feedback && (
        <p className={`jack-mic-feedback ${feedback.outcome.ok ? "" : "speech-error"}`} aria-live="polite">
          {feedback.prefix && `${feedback.prefix}: `}
          {feedback.heard && `Heard: “${feedback.heard}.” `}
          {feedback.outcome.ok ? feedback.outcome.message ?? "Done." : feedback.outcome.message}
        </p>
      )}

      {commandPanelOpen && (
        <form className="jack-command-popover" onSubmit={submitLocalCommand}>
          <input
            type="text"
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            placeholder='Type a command, e.g. "Next slide." or "Summarize this slide."'
            aria-label="Type a command for Jack"
            disabled={commandBusy}
            autoFocus
          />
          <button type="submit" disabled={commandBusy || !commandInput.trim()}>
            {commandBusy ? "…" : "Send"}
          </button>
          <button type="button" onClick={() => setCommandPanelOpen(false)} aria-label="Close command input" title="Close command input">
            ✕
          </button>
        </form>
      )}

      {settingsOpen && <PresentSettingsPopover onClose={() => setSettingsOpen(false)} />}

      {showNotes && (
        <aside className="notes-panel">
          <h3>Speaker notes</h3>
          <p>{currentSection?.speakerNotes || "No speaker notes were found for this slide."}</p>
        </aside>
      )}

      <div className={`present-controls ${chromeVisible ? "" : "controls-hidden"}`}>
        <button type="button" onClick={() => goTo(sectionIndex - 1)} disabled={sectionIndex === 0} aria-label="Previous slide">‹ Prev</button>
        <span className="present-position">{sectionIndex + 1} / {sections.length}</span>
        <div className="present-progress"><i style={{ width: `${((sectionIndex + 1) / sections.length) * 100}%` }} /></div>
        <button type="button" onClick={() => goTo(sectionIndex + 1)} disabled={sectionIndex === sections.length - 1} aria-label="Next slide">Next ›</button>

        <button
          type="button"
          onClick={paused ? jack.resume : jack.pause}
          aria-label={paused ? "Resume" : "Pause Jack"}
          title={paused ? "Resume Jack's presentation" : "Pause Jack's presentation"}
        >
          {paused ? "▶ Resume" : "❚❚ Pause"}
        </button>
        <button
          type="button"
          onClick={jack.interrupt}
          disabled={jack.attentionState !== "speaking"}
          aria-label="Stop Jack speaking"
          title="Stop Jack speaking"
        >
          ■ Stop
        </button>

        <span className="jack-controls-cluster">
          <button
            type="button"
            className={`jack-mic-btn state-${micToggledOn ? presentMicLabel : "idle"}`}
            onClick={handleLocalMicClick}
            disabled={whisperUnavailable || jack.localMicState === "requesting" || jack.localMicState === "initializing"}
            aria-pressed={micToggledOn}
            aria-label={micToggledOn ? "Turn mic off" : "Turn mic on -- listens for “Jack” until you turn it off"}
            title={
              whisperUnavailable
                ? "Local Whisper transcription is unavailable"
                : micToggledOn
                  ? "Turn mic off"
                  : "Turn mic on -- Jack listens for his name until you turn it off"
            }
          >
            {jack.localMicState === "requesting" || jack.localMicState === "initializing" ? "…" : "🎤"}
          </button>
          <button
            type="button"
            className={`jack-command-toggle-btn ${commandPanelOpen ? "active" : ""}`}
            onClick={() => setCommandPanelOpen((v) => !v)}
            aria-pressed={commandPanelOpen}
            aria-label="Type a command for Jack"
            title="Type a command instead of speaking"
          >
            ⌨
          </button>
          <button
            type="button"
            className="jack-voice-fallback-btn"
            onClick={() => currentSection && void jack.readCurrentSlide(currentSection.text)}
            disabled={!currentSection}
            aria-label="Read this slide"
            title="Read this slide aloud, once, with Jack's voice"
          >
            ▶
          </button>
          <button
            type="button"
            className={`jack-voice-fallback-btn ${settingsOpen ? "active" : ""}`}
            onClick={() => setSettingsOpen((v) => !v)}
            aria-pressed={settingsOpen}
            aria-label="Presentation settings"
            title="Language, voice, captions, and fallback settings"
          >
            ⚙
          </button>
        </span>

        <button
          type="button"
          onClick={() => setShowNotes((v) => !v)}
          aria-pressed={showNotes}
          aria-label="Toggle speaker notes"
          title="Show speaker notes"
        >
          Notes
        </button>
        {fullscreen.supported && (
          <button
            type="button"
            onClick={fullscreen.toggle}
            aria-label={fullscreen.isFullscreen ? "Exit full screen" : "Enter full screen"}
            title={fullscreen.isFullscreen ? "Exit full screen" : "Enter full screen"}
          >
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
          title="Exit presentation"
        >
          Exit
        </button>
      </div>
    </div>
  );
}

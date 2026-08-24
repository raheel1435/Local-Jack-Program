"use client";

import { useEffect, useRef } from "react";
import { JackOrb } from "../JackOrb";
import { NarrationPrepOverlay } from "../components/NarrationPrepOverlay";
import { useJack } from "../jack/JackProvider";
import { isUnsupportedFormat, parseFile } from "../lib/parsers";
import { useSession } from "../session/SessionContext";
import type { AnalysisStep } from "../session/types";

const STEP_LABEL: Record<AnalysisStep, string> = {
  reading: "Reading file",
  "detecting-structure": "Detecting structure",
  "preparing-guidance": "Preparing speaker guidance",
  "identifying-questions": "Identifying likely questions",
  "preparing-narration": "Preparing narration",
  done: "Done",
  failed: "Couldn't finish",
};

const STEP_ORDER: AnalysisStep[] = ["reading", "detecting-structure", "preparing-guidance", "identifying-questions"];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function AnalysisStage() {
  const { session, dispatch } = useSession();
  const jack = useJack();
  const processingRef = useRef(false);
  const completedRef = useRef(false);

  // CLAUDE-12 fix: guards every dispatch in the processing effect below
  // against firing after THIS component instance has genuinely unmounted --
  // scoped to its own empty-deps effect (not the processing effect, whose
  // deps change on every analysis step and would re-run a same-effect
  // cleanup long before real unmount, cancelling in-flight work
  // immediately). Without this, leaving Analysis mid-parse (e.g. via
  // BACK_TO_UPLOAD, now that CLAUDE-11 makes re-entering Analysis genuinely
  // possible) left the in-flight parseFile/pregenerateDeckNarration promise
  // chain running in the background, still mutating session state for a
  // stage the user had already left. A fresh AnalysisStage mount later gets
  // its own fresh ref, so only the OLD instance's stale work is stopped.
  // Mirrors the `cancelled`-flag pattern SlideVisual.tsx already uses.
  const cancelledRef = useRef(false);
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (processingRef.current) return;
    const next = session.files.find((f) => f.status === "queued");
    if (!next) return;

    processingRef.current = true;
    (async () => {
      dispatch({ type: "ANALYSIS_FILE_ACTIVE", fileId: next.id });
      try {
        for (const step of STEP_ORDER) {
          if (cancelledRef.current) return;
          dispatch({ type: "ANALYSIS_STEP", fileId: next.id, step });
          await sleep(280);
        }
        if (cancelledRef.current) return;
        const doc = await parseFile(next.file, next.kind);
        if (cancelledRef.current) return;
        doc.fileId = next.id;
        if (isUnsupportedFormat(doc)) {
          dispatch({ type: "ANALYSIS_FILE_UNSUPPORTED", fileId: next.id, doc });
        } else {
          // Upload-time milestone: generate every slide's narration now,
          // while the presenter is still uploading, instead of one slide
          // ahead during the live presentation -- see
          // pregenerateDeckNarration's own comment. This file only counts as
          // "ready" (ANALYSIS_FILE_DONE below) once it's done, matching "the
          // presentation shows on screen once preparation is finished."
          if (doc.sections.length > 0) {
            dispatch({
              type: "ANALYSIS_STEP",
              fileId: next.id,
              step: "preparing-narration",
              detail: `0/${doc.sections.length} slides`,
              narrationDone: 0,
              narrationTotal: doc.sections.length,
            });
            await jack.pregenerateDeckNarration(doc, (done, total) => {
              if (cancelledRef.current) return;
              dispatch({
                type: "ANALYSIS_STEP",
                fileId: next.id,
                step: "preparing-narration",
                detail: `${done}/${total} slides`,
                narrationDone: done,
                narrationTotal: total,
              });
            });
          }
          if (cancelledRef.current) return;
          dispatch({ type: "ANALYSIS_FILE_DONE", fileId: next.id, doc });
        }
      } catch (err) {
        if (cancelledRef.current) return;
        dispatch({
          type: "ANALYSIS_FILE_FAILED",
          fileId: next.id,
          error: err instanceof Error ? err.message : "Something went wrong while reading this file.",
        });
      } finally {
        processingRef.current = false;
      }
    })();
    // Deliberately depends on jack.pregenerateDeckNarration specifically,
    // not the whole `jack` context value -- that object is a fresh reference
    // on every JackProvider render (e.g. every mic-level animation frame
    // while listening), which would re-fire this effect dozens of times a
    // second during parsing/pregeneration; processingRef's early-return
    // guard makes that merely wasteful rather than actually broken, but
    // there's no reason to pay the cost.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.files, dispatch, jack.pregenerateDeckNarration]);

  useEffect(() => {
    if (completedRef.current) return;
    if (!session.analysis.started) return;
    if (session.files.length === 0) return;
    const allResolved = session.files.every((f) => f.status === "ready" || f.status === "unsupported" || f.status === "error");
    const noneFailed = session.analysis.failedFileIds.length === 0;
    if (allResolved && noneFailed) {
      completedRef.current = true;
      const timer = setTimeout(() => dispatch({ type: "ANALYSIS_COMPLETE" }), 500);
      return () => clearTimeout(timer);
    }
  }, [session.files, session.analysis.started, session.analysis.failedFileIds, dispatch]);

  const activeId = session.analysis.activeFileId;
  const activeFile = session.files.find((f) => f.id === activeId);
  const activeProgress = activeId ? session.analysis.progressByFile[activeId] : undefined;
  const narrationPrep =
    activeFile && activeProgress?.step === "preparing-narration" && activeProgress.narrationTotal
      ? { file: activeFile, done: activeProgress.narrationDone ?? 0, total: activeProgress.narrationTotal }
      : null;

  return (
    <section className="stage-shell analysis-stage">
      {narrationPrep && (
        <NarrationPrepOverlay
          assistantName={jack.assistantName}
          fileName={narrationPrep.file.name}
          done={narrationPrep.done}
          total={narrationPrep.total}
        />
      )}
      <div className="jack-stage compact">
        <div className="orb-wrap"><JackOrb state="thinking" size={140} name={jack.assistantName} /></div>
        <div className="jack-status">
          <i /> <strong>{jack.assistantName.toUpperCase()} IS THINKING</strong>
          <small>Reading what you uploaded</small>
        </div>
      </div>

      <h2>Preparing your material</h2>

      <ul className="analysis-list">
        {session.files.map((f) => {
          const progress = session.analysis.progressByFile[f.id];
          const isActive = f.id === activeId && f.status === "parsing";
          return (
            <li key={f.id} className={`analysis-row status-${f.status}`}>
              <span className={`file-badge kind-${f.kind}`}>{f.kind.toUpperCase()}</span>
              <span className="analysis-file-name">
                <strong>{f.name}</strong>
                <small>
                  {f.status === "error"
                    ? f.error
                    : progress
                      ? progress.detail
                        ? `${STEP_LABEL[progress.step]} (${progress.detail})`
                        : STEP_LABEL[progress.step]
                      : "Waiting…"}
                  {isActive && <span className="analysis-spinner" aria-hidden="true" />}
                </small>
              </span>
              {f.status === "error" && (
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => dispatch({ type: "ANALYSIS_RETRY_FILE", fileId: f.id })}
                >
                  Retry
                </button>
              )}
              {f.status === "ready" && <span className="analysis-check" aria-label="Done">✓</span>}
              {f.status === "unsupported" && <span className="analysis-warn" aria-label="Limited support">!</span>}
            </li>
          );
        })}
      </ul>

      <button type="button" className="text-button" onClick={() => dispatch({ type: "BACK_TO_UPLOAD" })}>
        ← Return to upload
      </button>
    </section>
  );
}

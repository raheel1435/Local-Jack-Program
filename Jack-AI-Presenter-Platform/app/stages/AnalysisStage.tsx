"use client";

import { useEffect, useRef } from "react";
import { JackOrb } from "../JackOrb";
import { isUnsupportedFormat, parseFile } from "../lib/parsers";
import { useSession } from "../session/SessionContext";
import type { AnalysisStep } from "../session/types";

const STEP_LABEL: Record<AnalysisStep, string> = {
  reading: "Reading file",
  "detecting-structure": "Detecting structure",
  "preparing-guidance": "Preparing speaker guidance",
  "identifying-questions": "Identifying likely questions",
  done: "Done",
  failed: "Couldn't finish",
};

const STEP_ORDER: AnalysisStep[] = ["reading", "detecting-structure", "preparing-guidance", "identifying-questions"];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function AnalysisStage() {
  const { session, dispatch } = useSession();
  const processingRef = useRef(false);
  const completedRef = useRef(false);

  useEffect(() => {
    if (processingRef.current) return;
    const next = session.files.find((f) => f.status === "queued");
    if (!next) return;

    processingRef.current = true;
    (async () => {
      dispatch({ type: "ANALYSIS_FILE_ACTIVE", fileId: next.id });
      try {
        for (const step of STEP_ORDER) {
          dispatch({ type: "ANALYSIS_STEP", fileId: next.id, step });
          await sleep(280);
        }
        const doc = await parseFile(next.file, next.kind);
        doc.fileId = next.id;
        if (isUnsupportedFormat(doc)) {
          dispatch({ type: "ANALYSIS_FILE_UNSUPPORTED", fileId: next.id, doc });
        } else {
          dispatch({ type: "ANALYSIS_FILE_DONE", fileId: next.id, doc });
        }
      } catch (err) {
        dispatch({
          type: "ANALYSIS_FILE_FAILED",
          fileId: next.id,
          error: err instanceof Error ? err.message : "Something went wrong while reading this file.",
        });
      } finally {
        processingRef.current = false;
      }
    })();
  }, [session.files, dispatch]);

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

  return (
    <section className="stage-shell analysis-stage">
      <div className="jack-stage compact">
        <div className="orb-wrap"><JackOrb state="thinking" size={140} /></div>
        <div className="jack-status">
          <i /> <strong>JACK IS THINKING</strong>
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
                      ? STEP_LABEL[progress.step]
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

"use client";

import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { JackOrb } from "../JackOrb";
import { useJack } from "../jack/JackProvider";
import { ACCEPTED_EXTENSIONS, formatFileSize, validateAndDedupeFiles, type ValidationRejection } from "../lib/validation";
import { useSession } from "../session/SessionContext";

export function UploadStage() {
  const { session, dispatch } = useSession();
  const jack = useJack();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejections, setRejections] = useState<ValidationRejection[]>([]);

  const acceptAttr = ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(",");

  const addFiles = (fileList: FileList | File[]) => {
    const { accepted, rejected } = validateAndDedupeFiles(Array.from(fileList), session.files);
    if (accepted.length > 0) dispatch({ type: "ADD_FILES", files: accepted });
    setRejections(rejected);
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
    e.target.value = "";
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  const removeFile = (id: string) => dispatch({ type: "REMOVE_FILE", id });
  const hasFiles = session.files.length > 0;

  return (
    <section className="stage-shell upload-stage">
      <div className="stage-hero">
        <div className="jack-stage">
          <div className="orb-wrap">
            <JackOrb state="available" size={160} name={jack.assistantName} />
          </div>
          <div className="jack-status">
            <i /> <strong>{jack.assistantName.toUpperCase()} IS AVAILABLE</strong>
            <small>Ready to look at what you bring</small>
          </div>
        </div>
        <div className="stage-copy">
          <div className="eyebrow"><i /> YOUR AI PRESENTATION PARTNER</div>
          <h1>Bring what you already have.<br /><span>{jack.assistantName} gets you ready.</span></h1>
          <p>Upload existing PowerPoint, PDF, or Word files. {jack.assistantName} reads them, prepares speaker guidance, and stays with you through practice and the real thing.</p>
        </div>
      </div>

      <div
        className={`dropzone ${dragging ? "dragging" : ""} ${hasFiles ? "has-file" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={acceptAttr}
          onChange={onInputChange}
          aria-label="Choose presentation files"
        />
        <div className="upload-icon" aria-hidden="true">⇧</div>
        <h2>{hasFiles ? "Add more files" : "Upload your presentation"}</h2>
        <p>Drop PPT, PPTX, PDF, DOC, DOCX, or TXT files here</p>
        {!hasFiles && (
          <button type="button" className="primary" onClick={() => inputRef.current?.click()}>
            Upload files
          </button>
        )}
        <small>PPT · PPTX · PDF · DOC · DOCX · TXT &nbsp;|&nbsp; Up to 100 MB each</small>
      </div>

      {rejections.length > 0 && (
        <ul className="upload-errors" role="alert">
          {rejections.map((r, i) => (
            <li key={`${r.fileName}-${i}`}><strong>{r.fileName}:</strong> {r.reason}</li>
          ))}
        </ul>
      )}

      {hasFiles && (
        <>
          <ul className="file-list">
            {session.files.map((f) => (
              <li key={f.id} className="file-list-row">
                <span className={`file-badge kind-${f.kind}`}>{f.kind.toUpperCase()}</span>
                <span className="file-title">
                  <strong>{f.name}</strong>
                  <small>{formatFileSize(f.size)}</small>
                </span>
                <button
                  type="button"
                  className="file-remove"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => removeFile(f.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          <div className="upload-cta-row">
            <button type="button" className="secondary" onClick={() => inputRef.current?.click()}>
              Upload more files
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => dispatch({ type: "START_ANALYSIS" })}
            >
              Next →
            </button>
          </div>
        </>
      )}

      <p className="privacy-note">
        Your files stay in this browser session — {jack.assistantName} analyzes them locally and nothing is uploaded to an external service.
      </p>
    </section>
  );
}

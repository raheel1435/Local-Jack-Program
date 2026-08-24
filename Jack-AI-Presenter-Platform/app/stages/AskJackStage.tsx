"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { JackOrb } from "../JackOrb";
import { MicDiagnostics } from "../components/MicDiagnostics";
import { useJack } from "../jack/JackProvider";
import { searchDocuments } from "../jack/documentContext";
import { fail, ok, type PresentationController } from "../jack/presentationController";
import { getAskJackProvider } from "../lib/askJackProvider";
import { isDevDiagnosticsEnabled } from "../lib/devDiagnostics";
import { useSession } from "../session/SessionContext";

interface ConversationEntry {
  id: string;
  role: "user" | "jack";
  text: string;
}

const offlineProvider = getAskJackProvider();

export function AskJackStage() {
  const { session, dispatch } = useSession();
  const readyFiles = session.files.filter((f) => f.status === "ready" || f.status === "unsupported");
  // CLAUDE-10 fix: session.activeFileId is the single source of truth --
  // this used to be a separate local `useState`, seeded once from the
  // global value and never written back, so the "Ask about:" dropdown
  // visibly changed but the REAL answer path (runLocalCommand ->
  // answerDeckQuestion, in JackProvider.tsx) reads the global
  // appSessionRef.current.activeFileId and never saw the local selection.
  const activeFileId = session.activeFileId;
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<ConversationEntry[]>([]);
  const [thinking, setThinking] = useState(false);
  const jack = useJack();

  const docs = Object.values(session.parsedDocs);
  const activeDoc = activeFileId ? session.parsedDocs[activeFileId] : undefined;
  const suggestions = activeDoc?.suggestedQuestions.slice(0, 4) ?? [];
  const devDiagnosticsEnabled = isDevDiagnosticsEnabled();
  // The local gateway (llama.cpp/Kokoro/Whisper), not OpenAI -- this mode
  // never needed an OpenAI key and shouldn't ask for one. Only when the
  // local LLM itself is unreachable (jack.localUnavailable) does this fall
  // back to a dumb offline keyword search (no AI at all), same graceful-
  // degradation pattern as Present/Practice's own localUnavailable warning.

  const askModeName = `Ask ${jack.assistantName}`;
  const latest = useRef({ docs, activeFileId, askModeName });
  useEffect(() => {
    latest.current = { docs, activeFileId, askModeName };
  });

  // Controller callbacks read the latest persona name so changing personas
  // cannot leave command results branded with the name from first mount.
  const controllerRef = useRef<PresentationController>({
    modeName: askModeName,
    getPresentationContext: () => {
      const s = latest.current;
      return ok({ title: s.askModeName, totalSlides: s.docs.length, currentSlideIndex: 0, mode: "askJack" });
    },
    startPresentation: () => fail(`There's no presentation to start in ${latest.current.askModeName} mode.`),
    pausePresentation: () => fail(`Not applicable in ${latest.current.askModeName} mode.`),
    resumePresentation: () => fail(`Not applicable in ${latest.current.askModeName} mode.`),
    endPresentation: () => ok({ ended: true as const }),
    goToNextSlide: () => fail(`There are no slides in ${latest.current.askModeName} mode.`),
    goToPreviousSlide: () => fail(`There are no slides in ${latest.current.askModeName} mode.`),
    goToSlide: () => fail(`There are no slides in ${latest.current.askModeName} mode.`),
    getCurrentSlide: () => fail(`There are no slides in ${latest.current.askModeName} mode.`),
    getSlideContent: () => fail(`There are no slides in ${latest.current.askModeName} mode.`),
    getSpeakerNotes: () => fail(`There are no speaker notes in ${latest.current.askModeName} mode.`),
    showSpeakerNotes: () => fail(`Not applicable in ${latest.current.askModeName} mode.`),
    hideSpeakerNotes: () => fail(`Not applicable in ${latest.current.askModeName} mode.`),
    takePresentationControl: () => fail(`Not applicable in ${latest.current.askModeName} mode.`),
    handControlToPresenter: () => fail(`Not applicable in ${latest.current.askModeName} mode.`),
    setPresentationPace: () => fail(`Not applicable in ${latest.current.askModeName} mode.`),
    getRemainingTime: () => ok({ remainingMs: null, message: "No time limit is set." }),
    searchUploadedDocuments: (query) => {
      const s = latest.current;
      return ok({ matches: searchDocuments(query, s.docs, s.activeFileId) });
    },
    showRelevantSource: () => ok({ shown: true as const }),
    queueAudienceQuestion: () => fail(`Not applicable in ${latest.current.askModeName} mode.`),
    markQuestionForFollowUp: () => fail(`Not applicable in ${latest.current.askModeName} mode.`),
    syncJackToCurrentSlide: () => fail(`Not applicable in ${latest.current.askModeName} mode.`),
    setAudienceQuestionPolicy: () => fail(`Not applicable in ${latest.current.askModeName} mode.`),
  });

  useEffect(() => {
    controllerRef.current.modeName = askModeName;
    jack.registerController(askModeName, controllerRef.current);
    return () => jack.unregisterController();
  }, [askModeName, jack]);

  useEffect(() => {
    return () => {
      jack.sleepJackLocal();
      jack.setAmbientListeningEnabled(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
    setHistory((h) => [...h, { id: crypto.randomUUID(), role: "user", text: trimmed }]);
    setQuestion("");
    setThinking(true);
    try {
      if (jack.localUnavailable) {
        const answer = await offlineProvider.ask(trimmed, { docs, activeFileId });
        setHistory((h) => [...h, { id: crypto.randomUUID(), role: "jack", text: answer.text }]);
        return;
      }
      // Reuses the exact same local-intent pipeline every other mode goes
      // through -- an open question classifies as "conversation" and gets
      // answered by the local LLM (with Kokoro speech), not a canned
      // keyword search. Action-shaped input (e.g. someone typing "next
      // slide" out of habit) still gets an honest, spoken failure from this
      // mode's controller ("There are no slides in Ask Jack mode.").
      const outcome = await jack.runLocalCommand(trimmed, "typed");
      setHistory((h) => [
        ...h,
        { id: crypto.randomUUID(), role: "jack", text: outcome.ok ? outcome.message ?? "Done." : (outcome.message ?? "Sorry, I couldn't answer that.") },
      ]);
    } finally {
      setThinking(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void ask(question);
  }

  return (
    <section className="stage-shell ask-jack-stage">
      <button type="button" className="text-button back-link" onClick={() => dispatch({ type: "BACK_TO_MODE_SELECT" })}>← Back</button>

      <div className="jack-stage compact">
        <div className="orb-wrap"><JackOrb state={jack.orb.orbState} size={140} name={jack.assistantName} /></div>
        <div className="jack-status">
          <i /> <strong>{jack.orb.label.toUpperCase()}</strong>
          <small>{jack.localUnavailable ? "Jack Local AI is unavailable — offline keyword search only" : "Ask about anything you uploaded"}</small>
        </div>
      </div>

      {readyFiles.length > 1 && (
        <label className="ask-jack-file-select">
          Ask about:
          <select
            value={activeFileId ?? ""}
            onChange={(e) => dispatch({ type: "SET_ACTIVE_FILE", fileId: e.target.value || null })}
          >
            <option value="">All uploaded files</option>
            {readyFiles.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
      )}

      <div className="ask-jack-conversation" aria-live="polite">
        {history.length === 0 && (
          <p className="ask-jack-empty">Ask {jack.assistantName} a question about your uploaded material below.</p>
        )}
        {history.map((entry) => (
          <div key={entry.id} className={`ask-jack-bubble role-${entry.role}`}>
            <strong>{entry.role === "user" ? "You" : jack.assistantName}</strong>
            <p>{entry.text}</p>
          </div>
        ))}
        {thinking && <div className="ask-jack-bubble role-jack thinking">{jack.assistantName} is thinking…</div>}
      </div>

      {suggestions.length > 0 && history.length === 0 && (
        <div className="ask-jack-suggestions">
          {suggestions.map((s) => (
            <button key={s} type="button" onClick={() => void ask(s)}>{s}</button>
          ))}
        </div>
      )}

      {devDiagnosticsEnabled && <MicDiagnostics jack={jack} />}
      {jack.lastError && <p className="speech-error" role="alert">{jack.lastError}</p>}
      {jack.localMicError && <p className="speech-error" role="alert">{jack.localMicError}</p>}

      <form className="ask-jack-input-row" onSubmit={onSubmit}>
        <button
          type="button"
          className={`jack-mic-btn ${jack.ambientListeningEnabled ? "state-listening" : ""}`}
          onClick={() => jack.setAmbientListeningEnabled(!jack.ambientListeningEnabled)}
          disabled={jack.jackLocalHealth?.whisper === "unavailable"}
          aria-pressed={jack.ambientListeningEnabled}
          aria-label={jack.ambientListeningEnabled ? "Turn mic off" : `Turn mic on -- say "${jack.assistantName}" followed by your question`}
          title={jack.ambientListeningEnabled ? "Turn mic off" : `Turn mic on -- say "${jack.assistantName}" followed by your question`}
        >
          🎤
        </button>
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about your material…"
          aria-label={`Ask ${jack.assistantName} a question`}
        />
        <button type="submit" className="primary" disabled={!question.trim() || thinking}>Ask</button>
      </form>
    </section>
  );
}

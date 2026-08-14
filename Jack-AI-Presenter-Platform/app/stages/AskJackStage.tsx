"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { JackOrb } from "../JackOrb";
import { MicButton } from "../components/MicButton";
import { useJack } from "../jack/JackProvider";
import { searchDocuments } from "../jack/documentContext";
import { fail, ok, type PresentationController } from "../jack/presentationController";
import { getAskJackProvider } from "../lib/askJackProvider";
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
  const [activeFileId, setActiveFileId] = useState<string | null>(session.activeFileId);
  const [question, setQuestion] = useState("");
  const [offlineHistory, setOfflineHistory] = useState<ConversationEntry[]>([]);
  const [offlineThinking, setOfflineThinking] = useState(false);
  const jack = useJack();

  const docs = Object.values(session.parsedDocs);
  const activeDoc = activeFileId ? session.parsedDocs[activeFileId] : undefined;
  const suggestions = activeDoc?.suggestedQuestions.slice(0, 4) ?? [];
  const online = jack.connectionStatus === "connected";

  const latest = useRef({ docs, activeFileId });
  useEffect(() => {
    latest.current = { docs, activeFileId };
  });

  const controllerRef = useRef<PresentationController>({
    modeName: "Ask Jack",
    getPresentationContext: () => {
      const s = latest.current;
      return ok({ title: "Ask Jack", totalSlides: s.docs.length, currentSlideIndex: 0, mode: "askJack" });
    },
    startPresentation: () => fail("There's no presentation to start in Ask Jack mode."),
    pausePresentation: () => fail("Not applicable in Ask Jack mode."),
    resumePresentation: () => fail("Not applicable in Ask Jack mode."),
    endPresentation: () => ok({ ended: true as const }),
    goToNextSlide: () => fail("There are no slides in Ask Jack mode."),
    goToPreviousSlide: () => fail("There are no slides in Ask Jack mode."),
    goToSlide: () => fail("There are no slides in Ask Jack mode."),
    getCurrentSlide: () => fail("There are no slides in Ask Jack mode."),
    getSlideContent: () => fail("There are no slides in Ask Jack mode."),
    getSpeakerNotes: () => fail("There are no speaker notes in Ask Jack mode."),
    showSpeakerNotes: () => fail("Not applicable in Ask Jack mode."),
    hideSpeakerNotes: () => fail("Not applicable in Ask Jack mode."),
    takePresentationControl: () => fail("Not applicable in Ask Jack mode."),
    handControlToPresenter: () => fail("Not applicable in Ask Jack mode."),
    setPresentationPace: () => fail("Not applicable in Ask Jack mode."),
    getRemainingTime: () => ok({ remainingMs: null, message: "No time limit is set." }),
    searchUploadedDocuments: (query) => {
      const s = latest.current;
      return ok({ matches: searchDocuments(query, s.docs, s.activeFileId) });
    },
    showRelevantSource: () => ok({ shown: true as const }),
    queueAudienceQuestion: () => fail("Not applicable in Ask Jack mode."),
    markQuestionForFollowUp: () => fail("Not applicable in Ask Jack mode."),
    syncJackToCurrentSlide: () => fail("Not applicable in Ask Jack mode."),
    setAudienceQuestionPolicy: () => fail("Not applicable in Ask Jack mode."),
  });

  useEffect(() => {
    jack.registerController("Ask Jack", controllerRef.current);
    return () => {
      jack.unregisterController();
      jack.sleep();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function askOffline(text: string) {
    const trimmed = text.trim();
    if (!trimmed || offlineThinking) return;
    setOfflineHistory((h) => [...h, { id: crypto.randomUUID(), role: "user", text: trimmed }]);
    setQuestion("");
    setOfflineThinking(true);
    try {
      const answer = await offlineProvider.ask(trimmed, { docs, activeFileId });
      setOfflineHistory((h) => [...h, { id: crypto.randomUUID(), role: "jack", text: answer.text }]);
    } finally {
      setOfflineThinking(false);
    }
  }

  function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (online) {
      jack.sendText(trimmed);
      setQuestion("");
    } else {
      void askOffline(trimmed);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    ask(question);
  }

  function handleMicToggle() {
    if (jack.micStatus === "listening") jack.mute();
    else if (jack.micStatus === "muted") jack.unmute();
  }

  const onlineHistory: ConversationEntry[] = jack.transcript.map((e) => ({
    id: e.id,
    role: e.role === "presenter" ? "user" : "jack",
    text: e.text,
  }));
  const history = online ? onlineHistory : offlineHistory;
  const thinking = online ? jack.attentionState === "thinking" : offlineThinking;

  return (
    <section className="stage-shell ask-jack-stage">
      <button type="button" className="text-button" onClick={() => dispatch({ type: "BACK_TO_MODE_SELECT" })}>← Back</button>

      <div className="jack-stage compact">
        <div className="orb-wrap"><JackOrb state={jack.orb.orbState} size={140} /></div>
        <div className="jack-status">
          <i /> <strong>{jack.orb.label.toUpperCase()}</strong>
          <small>{online ? "Ask about anything you uploaded" : "Offline mode — local search only"}</small>
        </div>
      </div>

      {!online && (
        <div className="ask-jack-connect">
          <button type="button" className="primary" onClick={jack.wake} disabled={jack.connectionStatus === "connecting"}>
            {jack.connectionStatus === "connecting" ? "Connecting…" : "Talk to Jack"}
          </button>
          <p className="setup-note">
            {jack.lastError ?? "Not connected — you can still search your documents below with local keyword search (not AI)."}
          </p>
        </div>
      )}

      {readyFiles.length > 1 && (
        <label className="ask-jack-file-select">
          Ask about:
          <select value={activeFileId ?? ""} onChange={(e) => setActiveFileId(e.target.value || null)}>
            <option value="">All uploaded files</option>
            {readyFiles.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
      )}

      <div className="ask-jack-conversation" aria-live="polite">
        {history.length === 0 && (
          <p className="ask-jack-empty">Ask Jack a question about your uploaded material below.</p>
        )}
        {history.map((entry) => (
          <div key={entry.id} className={`ask-jack-bubble role-${entry.role}`}>
            <strong>{entry.role === "user" ? "You" : "Jack"}</strong>
            <p>{entry.text}</p>
          </div>
        ))}
        {thinking && <div className="ask-jack-bubble role-jack thinking">Jack is thinking…</div>}
      </div>

      {suggestions.length > 0 && history.length === 0 && (
        <div className="ask-jack-suggestions">
          {suggestions.map((s) => (
            <button key={s} type="button" onClick={() => ask(s)}>{s}</button>
          ))}
        </div>
      )}

      {online && jack.attentionState === "speaking" && (
        <div className="ask-jack-audible">
          <button type="button" className="speech-btn" onClick={jack.interrupt}>■ Stop speaking</button>
        </div>
      )}

      <form className="ask-jack-input-row" onSubmit={onSubmit}>
        <MicButton state={jack.micStatus} level={jack.micLevel} onStart={jack.wake} onStop={jack.sleep} onToggleMute={handleMicToggle} size="small" />
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about your material…"
          aria-label="Ask Jack a question"
        />
        <button type="submit" className="primary" disabled={!question.trim() || thinking}>Ask</button>
      </form>
    </section>
  );
}

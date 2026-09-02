"use client";

import { AskJackStage } from "./stages/AskJackStage";
import { AnalysisStage } from "./stages/AnalysisStage";
import { ModeSelectStage } from "./stages/ModeSelectStage";
import { PracticeStage } from "./stages/PracticeStage";
import { PresentStage } from "./stages/PresentStage";
import { UploadStage } from "./stages/UploadStage";
import { JackProvider, useJack } from "./jack/JackProvider";
import { SessionProvider, useSession } from "./session/SessionContext";

export default function ProductApp() {
  return (
    <SessionProvider>
      <JackProvider>
        <AppShell />
      </JackProvider>
    </SessionProvider>
  );
}

function AppShell() {
  const { session } = useSession();
  const jack = useJack();

  if (session.stage === "present") {
    return <PresentStage />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Jack AI home">
          <span className="brand-mark">J</span>
          <span>JACK <b>AI</b></span>
        </a>
      </header>

      <main>
        {session.stage === "upload" && <UploadStage />}
        {session.stage === "analysis" && <AnalysisStage />}
        {session.stage === "modeSelect" && <ModeSelectStage />}
        {session.stage === "practice" && <PracticeStage />}
        {session.stage === "askJack" && <AskJackStage />}
      </main>

      <footer>
        <span>JACK AI · TURN ANY PRESENTATION INTO A CONVERSATION</span>
        <span>
          {jack.aiProvider === "local"
            ? <>Private by design &nbsp;·&nbsp; Your files stay under your control</>
            : <>Using {jack.aiProvider === "openai" ? "OpenAI" : "Anthropic"} &nbsp;·&nbsp; Relevant text is sent to {jack.aiProvider === "openai" ? "OpenAI" : "Anthropic"} using your own API key</>}
        </span>
      </footer>
    </div>
  );
}

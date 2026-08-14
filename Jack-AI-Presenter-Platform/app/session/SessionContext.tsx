"use client";

import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from "react";
import { initialSessionState, sessionReducer } from "./sessionReducer";
import type { SessionAction, SessionState } from "./types";

interface SessionContextValue {
  session: SessionState;
  dispatch: Dispatch<SessionAction>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, dispatch] = useReducer(sessionReducer, initialSessionState);
  return (
    <SessionContext.Provider value={{ session, dispatch }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}

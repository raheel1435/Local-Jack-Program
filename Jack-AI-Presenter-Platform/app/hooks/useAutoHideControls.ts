"use client";

import { useEffect, useRef, useState } from "react";

/** Shows controls immediately on any pointer/keyboard activity, then hides them after `idleMs` of inactivity. */
export function useAutoHideControls(idleMs = 3000) {
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const reveal = () => {
      setVisible(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setVisible(false), idleMs);
    };
    reveal();
    window.addEventListener("pointermove", reveal);
    window.addEventListener("keydown", reveal);
    window.addEventListener("touchstart", reveal);
    return () => {
      window.removeEventListener("pointermove", reveal);
      window.removeEventListener("keydown", reveal);
      window.removeEventListener("touchstart", reveal);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [idleMs]);

  return visible;
}

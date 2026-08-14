"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

export interface UseFullscreenResult {
  isFullscreen: boolean;
  toggle(): void;
  supported: boolean;
}

interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface WebkitFullscreenDocumentElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

export function useFullscreen(ref: RefObject<HTMLElement | null>): UseFullscreenResult {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const supported =
    typeof document !== "undefined" &&
    (!!document.documentElement.requestFullscreen ||
      !!(document.documentElement as WebkitFullscreenDocumentElement).webkitRequestFullscreen);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = useCallback(() => {
    if (!supported) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    const el = ref.current as WebkitFullscreenElement | null;
    if (!el) return;
    const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
    if (request) void Promise.resolve(request.call(el)).catch(() => {});
  }, [ref, supported]);

  return { isFullscreen, toggle, supported };
}

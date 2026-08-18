/**
 * Acoustic/mic diagnostics gate, shared by every mode that shows a
 * bargeInPhase readout (Present/Practice/Ask Jack): dev build AND an
 * explicit ?dev=1 opt-in, never just a normal dev-server session or a
 * normal viewer. A plain function, not a hook -- it reads nothing reactive
 * (import.meta.env, the URL) that would ever change during a session.
 */
export function isDevDiagnosticsEnabled(): boolean {
  return (
    Boolean(import.meta.env?.DEV) && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("dev") === "1"
  );
}

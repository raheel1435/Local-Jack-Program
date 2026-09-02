"use client";

import { useState } from "react";
import { jackApi, type CredentialProviderId, type CredentialStatusReport } from "../lib/jackApi";

/**
 * BYOK key entry/status for one cloud AI provider (multi-provider AI
 * milestone). Rendered inline by AiProviderSelector when openai/anthropic
 * is the selected provider. The input is ALWAYS empty on mount and after a
 * successful save -- the gateway never returns the saved key (only
 * `lastFour`), so there is nothing to prefill even if this wanted to.
 */
export function AiProviderKeySettings({
  provider,
  status,
  onChange,
}: {
  provider: CredentialProviderId;
  status: CredentialStatusReport | null;
  onChange: () => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = provider === "openai" ? "OpenAI" : "Anthropic";

  async function run(action: () => Promise<CredentialStatusReport>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const handleSave = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    void run(() => jackApi.saveCredential(provider, trimmed)).then(() => setKeyInput(""));
  };

  const handleTest = () => void run(() => jackApi.testCredential(provider));
  const handleRemove = () => void run(() => jackApi.removeCredential(provider));

  const statusLine =
    status?.status === "connected"
      ? `Connected · Key ending in •••• ${status.lastFour ?? "????"}`
      : status?.status === "invalid"
        ? `Invalid key${status.detail ? ` — ${status.detail}` : ""} — check and re-save`
        : "Not configured";

  return (
    <div className="jack-ai-key-settings">
      <p className="jack-settings-section-title">{label} API Key</p>
      <p className={`jack-ai-key-status ${status?.status ?? "not_configured"}`}>{statusLine}</p>
      <div className="jack-ai-key-row">
        <input
          type="password"
          name={`${provider}ApiKey`}
          id={`${provider}-api-key-input`}
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={`Paste your ${label} API key`}
          disabled={busy}
          autoComplete="off"
          aria-label={`${label} API key`}
        />
        <button type="button" onClick={handleSave} disabled={busy || !keyInput.trim()}>
          {status?.status === "not_configured" || !status ? "Save" : "Replace"}
        </button>
        {status && status.status !== "not_configured" && (
          <>
            <button type="button" onClick={handleTest} disabled={busy}>
              Test connection
            </button>
            <button type="button" onClick={handleRemove} disabled={busy}>
              Remove
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="jack-ai-key-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
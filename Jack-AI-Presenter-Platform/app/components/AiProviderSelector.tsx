"use client";

import { useCallback, useEffect, useState } from "react";
import { useJack } from "../jack/JackProvider";
import { jackApi, type CredentialProviderId, type CredentialStatusReport } from "../lib/jackApi";
import { AI_PROVIDER_OPTIONS } from "../jack/aiProviderSettings";
import { AiProviderKeySettings } from "./AiProviderKeySettings";

type CredentialMap = Partial<Record<CredentialProviderId, CredentialStatusReport>>;

/**
 * The AI Assistant (Local / OpenAI / Anthropic) control -- Stage 1's
 * settings-screen counterpart to AsrProviderSelector.tsx. Unlike ASR
 * (binary available/unavailable from jack.jackLocalHealth), a BYOK
 * provider has a genuinely 4th state ("not configured"), so this owns a
 * small local fetch of GET /jack/credentials rather than reusing
 * jackLocalHealth's 2-state shape.
 */
export function AiProviderSelector({ titlePrefix }: { titlePrefix?: string }) {
  const jack = useJack();
  // undefined means the first request is still in flight; null means the
  // gateway did not answer. A failed request must not look like an endless check.
  const [credentials, setCredentials] = useState<CredentialMap | null | undefined>(undefined);

  const refreshCredentials = useCallback(() => {
    jackApi
      .getCredentialStatus()
      .then((result) => setCredentials(result))
      .catch(() => setCredentials(null));
  }, []);

  useEffect(() => {
    refreshCredentials();
  }, [refreshCredentials]);

  function statusFor(id: "local" | "openai" | "anthropic"): { dot: string; label: string } {
    if (id === "local") {
      if (jack.jackLocalHealth === null) return { dot: "", label: "Checking service" };
      if (jack.jackLocalHealth.gateway === "unreachable") return { dot: "unavailable", label: "Service offline" };
      const activeLocal = jack.jackLocalHealth?.activeLlmProvider;
      const localStatus = activeLocal ? jack.jackLocalHealth?.[activeLocal] : undefined;
      if (localStatus === "available") return { dot: "available", label: "Ready" };
      if (localStatus === "unavailable") return { dot: "unavailable", label: "Unavailable" };
      return { dot: "unavailable", label: "Unavailable" };
    }
    if (credentials === undefined) return { dot: "", label: "Checking key" };
    if (credentials === null) return { dot: "unavailable", label: "Status unavailable" };
    const cred = credentials?.[id];
    if (!cred) return { dot: "not-configured", label: "Add a key below" };
    if (cred.status === "connected") return { dot: "available", label: "Ready" };
    if (cred.status === "invalid") return { dot: "unavailable", label: "Invalid key" };
    return { dot: "not-configured", label: "Add a key below" };
  }

  const activeOption = AI_PROVIDER_OPTIONS.find((option) => option.id === jack.aiProvider);

  return (
    <div className="jack-ai-selector">
      {titlePrefix !== undefined && <p className="jack-settings-section-title">{titlePrefix}AI Assistant</p>}
      <div className="jack-ai-segmented" role="group" aria-label="AI assistant provider">
        {AI_PROVIDER_OPTIONS.map((option) => {
          const status = statusFor(option.id);
          return (
            <button
              key={option.id}
              type="button"
              className={`jack-ai-option${jack.aiProvider === option.id ? " active" : ""}`}
              onClick={() => jack.setAiProvider(option.id)}
              aria-pressed={jack.aiProvider === option.id}
            >
              <span>{option.label}</span>
              <span className="jack-ai-option-status">
                <span className={`jack-ai-status-dot ${status.dot}`} />
                {status.label}
              </span>
            </button>
          );
        })}
      </div>
      {activeOption && <p className="jack-settings-note">{activeOption.description}</p>}
      {jack.aiProvider !== "local" && (
        <AiProviderKeySettings
          provider={jack.aiProvider}
          status={credentials?.[jack.aiProvider] ?? null}
          onChange={refreshCredentials}
        />
      )}
    </div>
  );
}

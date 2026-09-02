"use client";

import { useCallback, useEffect, useState } from "react";
import { useJack } from "../jack/JackProvider";
import { jackApi, type CredentialProviderId, type CredentialStatusReport } from "../lib/jackApi";
import { ASR_PROVIDER_OPTIONS } from "../jack/asrProviderSettings";
import { AiProviderKeySettings } from "./AiProviderKeySettings";

type CredentialMap = Partial<Record<CredentialProviderId, CredentialStatusReport>>;

/**
 * The ONE Speech Recognition (Approved Whisper / Test VibeVoice / OpenAI
 * Speech) control -- rendered both on the pre-presentation setup screen and
 * inside Present mode's settings popover (latency-fix milestone: the
 * selector was "too hidden" living only in the in-presentation popover).
 * Both call sites read and write the exact same jack.asrProvider/
 * setAsrProvider from JackProvider -- there is no separate state here, so a
 * choice made before Present starts is already active the moment it
 * begins, and switching mid-presentation (including to/from OpenAI Speech,
 * Stage 2) updates the same single setting Present/Practice/Ask Jack/
 * ambient listening all read.
 *
 * OpenAI Speech is a completely independent axis from the AI Assistant
 * selector (AiProviderSelector) -- picking it here never changes
 * jack.aiProvider, and it reuses the SAME "openai" BYOK credential
 * AiProviderKeySettings already manages, so a key saved for the AI brain
 * "just works" here too (and vice versa) with no second key prompt.
 */
export function AsrProviderSelector({ titlePrefix }: { titlePrefix?: string }) {
  const jack = useJack();
  const [credentials, setCredentials] = useState<CredentialMap | null>(null);

  const refreshCredentials = useCallback(() => {
    jackApi
      .getCredentialStatus()
      .then((result) => setCredentials(result))
      .catch(() => setCredentials(null));
  }, []);

  useEffect(() => {
    refreshCredentials();
  }, [refreshCredentials]);

  function statusFor(id: "whisper" | "vibevoice" | "openai"): { dot: string; label: string } {
    if (id === "whisper" || id === "vibevoice") {
      const status = jack.jackLocalHealth?.[id];
      if (status === "available") return { dot: "available", label: "Ready" };
      if (status === "unavailable") return { dot: "unavailable", label: "Unavailable" };
      return { dot: "", label: "Checking..." };
    }
    const cred = credentials?.openai;
    if (!cred) return { dot: "", label: "Checking..." };
    if (cred.status === "connected") return { dot: "available", label: "Ready" };
    if (cred.status === "invalid") return { dot: "unavailable", label: "Invalid key" };
    return { dot: "not-configured", label: "Add a key below" };
  }

  const activeOption = ASR_PROVIDER_OPTIONS.find((option) => option.id === jack.asrProvider);

  return (
    <div className="jack-asr-selector">
      {titlePrefix !== undefined && <p className="jack-settings-section-title">{titlePrefix}Speech Recognition</p>}
      <div className="jack-asr-segmented" role="group" aria-label="Speech recognition engine">
        {ASR_PROVIDER_OPTIONS.map((option) => {
          const status = statusFor(option.id);
          return (
            <button
              key={option.id}
              type="button"
              className={`jack-asr-option${jack.asrProvider === option.id ? " active" : ""}`}
              onClick={() => jack.setAsrProvider(option.id)}
              aria-pressed={jack.asrProvider === option.id}
            >
              <span>{option.label}</span>
              <span className="jack-asr-option-status">
                <span className={`jack-asr-status-dot ${status.dot}`} />
                {status.label}
              </span>
            </button>
          );
        })}
      </div>
      {activeOption && <p className="jack-settings-note">{activeOption.description}</p>}
      <p className="jack-settings-note">
        Applies everywhere {jack.assistantName} listens (ambient, push-to-talk, Ask {jack.assistantName}, Practice) -- no
        per-screen override. Test and cloud engines are opt-in only and never used automatically if unavailable; switch
        back to Approved if one fails.
      </p>
      {jack.asrProvider === "openai" && (
        <AiProviderKeySettings provider="openai" status={credentials?.openai ?? null} onChange={refreshCredentials} />
      )}
    </div>
  );
}

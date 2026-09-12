"use client";

import type { ProviderFallbackRequest } from "../lib/jackApi";

const LABELS: Record<string, string> = {
  local: "Local AI",
  openai: "OpenAI",
  anthropic: "Anthropic",
  whisper: "Whisper",
  vibevoice: "Vibe",
};

export function ProviderFallbackDialog({ request, onChoose }: { request: ProviderFallbackRequest; onChoose: (choice: string | null) => void }) {
  const failed = LABELS[request.failedProvider] ?? request.failedProvider;
  const noCredential = request.credentialRequired && request.options.length === 0;
  return (
    <div className="provider-fallback-overlay" role="presentation">
      <div className="provider-fallback-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-fallback-title">
        <h3 id="provider-fallback-title">{failed} is unavailable</h3>
        <p>{request.detail}</p>
        {noCredential ? (
          <p className="provider-fallback-note">Add your {LABELS[request.credentialRequired!]} API key in Settings before using this cloud provider.</p>
        ) : (
          <p className="provider-fallback-note">This retries only the current request. Your saved provider will not change.</p>
        )}
        <div className="provider-fallback-actions">
          {noCredential && (
            <button type="button" className="primary" onClick={() => {
              window.dispatchEvent(new Event("jack:open-provider-settings"));
              onChoose(null);
            }}>Open Settings</button>
          )}
          {request.options.map((option) => {
            const cloud = option === "openai" || option === "anthropic";
            return (
              <button key={option} type="button" className="primary" onClick={() => onChoose(option)}>
                Use {LABELS[option] ?? option}
                {cloud && <small>Your request will be sent to {LABELS[option]} using your configured API key.</small>}
              </button>
            );
          })}
          <button type="button" onClick={() => onChoose(null)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

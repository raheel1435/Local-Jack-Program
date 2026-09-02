import { Router } from "express";
import type { CredentialStore } from "../lib/credentialStore.js";
import { isNonEmptyStringWithinLimit, MAX_API_KEY_LENGTH } from "../lib/requestValidation.js";
import type { CredentialProviderId, JackErrorResponse } from "../types/jack.js";

function parseCredentialProvider(value: unknown): CredentialProviderId | "invalid" {
  if (value === "openai" || value === "anthropic") return value;
  return "invalid";
}

function invalidProviderError(raw: unknown): JackErrorResponse {
  return {
    error: "invalid_request",
    detail: `Unknown provider "${String(raw)}". Expected "openai" or "anthropic".`,
  };
}

/**
 * BYOK credential CRUD for the multi-provider AI milestone's settings UI.
 * Discipline matching /health's existing "only ever derived enums, never
 * raw config" precedent: no response from this router -- success, error,
 * or validation-failure -- may ever include the raw apiKey value.
 */
export function credentialsRouter(store: CredentialStore): Router {
  const router = Router();

  router.get("/jack/credentials", async (_req, res) => {
    const [openai, anthropic] = await Promise.all([store.status("openai"), store.status("anthropic")]);
    res.json({ openai, anthropic });
  });

  router.post("/jack/credentials/:provider", async (req, res) => {
    const provider = parseCredentialProvider(req.params.provider);
    if (provider === "invalid") {
      res.status(400).json(invalidProviderError(req.params.provider));
      return;
    }

    const body = req.body as { apiKey?: unknown };
    if (!isNonEmptyStringWithinLimit(body.apiKey, MAX_API_KEY_LENGTH)) {
      const err: JackErrorResponse = {
        error: "invalid_request",
        detail: `\`apiKey\` must be a non-empty string of at most ${MAX_API_KEY_LENGTH} characters.`,
      };
      res.status(400).json(err);
      return;
    }

    try {
      const report = await store.set(provider, body.apiKey);
      res.json(report);
    } catch (e) {
      const err: JackErrorResponse = {
        error: "credential_store_failed",
        detail: e instanceof Error ? e.message : String(e),
      };
      res.status(502).json(err);
    }
  });

  router.delete("/jack/credentials/:provider", async (req, res) => {
    const provider = parseCredentialProvider(req.params.provider);
    if (provider === "invalid") {
      res.status(400).json(invalidProviderError(req.params.provider));
      return;
    }
    await store.remove(provider);
    res.json({ provider, status: "not_configured" });
  });

  router.post("/jack/credentials/:provider/test", async (req, res) => {
    const provider = parseCredentialProvider(req.params.provider);
    if (provider === "invalid") {
      res.status(400).json(invalidProviderError(req.params.provider));
      return;
    }
    const report = await store.testConnection(provider);
    res.json(report);
  });

  return router;
}
import type {
  AiBrainSelector,
  JackChatRequest,
  JackChatResponse,
  LlmProvider,
  LlmProviderName,
} from "../types/jack.js";

export interface BrainProviderRegistry {
  local: LlmProvider;
  openai: LlmProvider;
  anthropic: LlmProvider;
  localFallback?: LlmProvider;
  localProviderName?: LlmProviderName;
  localFallbackProviderName?: LlmProviderName;
}

export class LocalBrainsUnavailableError extends Error {
  constructor(public readonly failures: string[]) {
    super("Both local AI runtimes are unavailable.");
  }
}

/** Executes exactly one selected brain request. Only the local selection may
 * try one alternate local runtime; cloud selectors never enter this branch. */
export async function executeBrainRequest(
  providers: BrainProviderRegistry,
  selected: AiBrainSelector,
  request: JackChatRequest,
): Promise<JackChatResponse> {
  if (selected !== "local") {
    const provider = providers[selected];
    return { ...(await provider.chat(request)), requestedProvider: selected, actualProvider: selected, fallbackUsed: false };
  }

  const primaryName = providers.localProviderName ?? "llamacpp";
  const candidates: Array<{ provider: LlmProvider; name: LlmProviderName; fallback: boolean }> = [
    { provider: providers.local, name: primaryName, fallback: false },
  ];
  if (providers.localFallback) {
    candidates.push({
      provider: providers.localFallback,
      name: providers.localFallbackProviderName ?? (primaryName === "llamacpp" ? "colibri" : "llamacpp"),
      fallback: true,
    });
  }

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      if (await candidate.provider.checkHealth() === "unavailable") {
        failures.push(`${candidate.name}: unavailable`);
        continue;
      }
      const result = await candidate.provider.chat(request);
      if (candidate.fallback) console.warn(`[provider-fallback] ${primaryName} failed; using ${candidate.name} for this request.`);
      return {
        ...result,
        requestedProvider: "local",
        actualProvider: "local",
        actualLocalProvider: candidate.name,
        fallbackUsed: candidate.fallback,
        ...(candidate.fallback ? { fallbackFrom: primaryName } : {}),
      };
    } catch (error) {
      failures.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new LocalBrainsUnavailableError(failures);
}

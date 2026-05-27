import { getRepo } from '../../../repo/index.ts';
import type { TelemetryModelIdentity, TokenUsage } from '../../../repo/types.ts';

const currentHour = (): string => new Date().toISOString().slice(0, 13);

export const hasTokenUsage = (usage: TokenUsage): boolean => usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0;

export const tokenUsage = (inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0): TokenUsage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
});

export const tokenUsageFromPromptTokenResponse = (usage: unknown): TokenUsage | null => {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  return typeof promptTokens === 'number' ? tokenUsage(promptTokens) : null;
};

// OpenAI Images responses report usage as
// `{input_tokens, output_tokens, total_tokens, input_tokens_details, output_tokens_details}`.
// We only track the totals — the per-modality split (text vs image) has
// no column on the usage table and cost computation uses input/output
// against the existing ModelPricing schema.
//
// Either field present as a non-number (e.g. a string "5") is treated as
// a malformed upstream payload rather than silently coerced to 0. That
// matches the project's anti-fallback rule in AGENTS.md: refuse to invent
// numbers for shapes we did not expect.
export const tokenUsageFromImagesResponse = (usage: unknown): TokenUsage | null => {
  if (!usage || typeof usage !== 'object') return null;
  const { input_tokens: input, output_tokens: output } = usage as { input_tokens?: unknown; output_tokens?: unknown };
  if (input !== undefined && typeof input !== 'number') return null;
  if (output !== undefined && typeof output !== 'number') return null;
  if (input === undefined && output === undefined) return null;
  return tokenUsage(input ?? 0, output ?? 0);
};

export const recordTokenUsage = async (keyId: string, modelIdentity: TelemetryModelIdentity, usage: TokenUsage): Promise<void> => {
  await Promise.all([
    getRepo().usage.record({
      keyId,
      model: modelIdentity.model,
      upstream: modelIdentity.upstream,
      modelKey: modelIdentity.modelKey,
      hour: currentHour(),
      requests: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cost: modelIdentity.cost,
    }),
    (async () => {
      const key = await getRepo().apiKeys.getById(keyId);
      if (!key) return;
      await getRepo().apiKeys.save({
        ...key,
        lastUsedAt: new Date().toISOString(),
      });
    })(),
  ]);
};

export const recordTokenUsageForApiKey = async (apiKeyId: string | undefined, modelIdentity: TelemetryModelIdentity, usage: TokenUsage): Promise<void> => {
  // Dashboard playground requests authenticate with ADMIN_KEY and intentionally
  // have no API key id; usage is not recorded for those.
  if (!apiKeyId) return;
  await recordTokenUsage(apiKeyId, modelIdentity, usage);
};

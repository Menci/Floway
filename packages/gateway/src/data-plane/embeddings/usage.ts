import type { TokenUsage } from '../../repo/types.ts';
import { tokenUsage } from '../shared/telemetry/usage.ts';

const isNonArrayObject = (value: unknown): value is object =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const tokenUsageFromEmbeddingsBody = (body: unknown): TokenUsage | null => {
  if (!isNonArrayObject(body)) return null;
  const { usage } = body as { usage?: unknown };
  if (!isNonArrayObject(usage)) return null;
  const { prompt_tokens: promptTokens, total_tokens: totalTokens } = usage as {
    prompt_tokens?: unknown;
    total_tokens?: unknown;
  };
  if (!isTokenCount(promptTokens) || !isTokenCount(totalTokens) || totalTokens !== promptTokens) return null;
  return tokenUsage({ input: promptTokens });
};

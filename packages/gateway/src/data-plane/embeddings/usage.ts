import type { TokenUsage } from '../../repo/types.ts';
import { tokenUsage } from '../shared/telemetry/usage.ts';

export const tokenUsageFromEmbeddingsBody = (body: unknown): TokenUsage | null => {
  if (!body || typeof body !== 'object') return null;
  const { usage } = body as { usage?: unknown };
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  return typeof promptTokens === 'number' ? tokenUsage({ input: promptTokens }) : null;
};

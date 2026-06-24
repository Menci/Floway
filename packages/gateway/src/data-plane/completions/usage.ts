import { tokenUsage } from '../shared/telemetry/usage.ts';
import type { CompletionsStreamEvent, CompletionsUsage } from '@floway-dev/protocols/completions';

// Legacy /v1/completions usage shape: { prompt_tokens, completion_tokens,
// total_tokens }. No cache split, no service tier — the modern surfaces
// (chat-completions, messages, responses) added those after /v1/completions
// was already deprecated. A defensive shape check rejects malformed bodies
// rather than coercing to zero.
export const tokenUsageFromCompletionsUsage = (usage: unknown): ReturnType<typeof tokenUsage> | null => {
  if (!usage || typeof usage !== 'object') return null;
  const { prompt_tokens: input, completion_tokens: output } = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  return tokenUsage({ input, output });
};

// Pull the OpenAI usage chunk shape out of an event. The frame is the
// usage-only chunk (choices: [], usage: defined); we extract the usage
// block and run it through tokenUsageFromCompletionsUsage. Returns null if
// the chunk does not carry a recognizable usage block.
export const completionsUsageFromStreamEvent = (event: CompletionsStreamEvent | unknown): CompletionsUsage | null => {
  if (!event || typeof event !== 'object') return null;
  const { usage } = event as { usage?: unknown };
  if (!usage || typeof usage !== 'object') return null;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') return null;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: typeof totalTokens === 'number' ? totalTokens : promptTokens + completionTokens,
  };
};

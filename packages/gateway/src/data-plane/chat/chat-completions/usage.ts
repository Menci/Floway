import { billableServiceTier, openAICacheTokensFromUsage, tokenUsage } from '../../shared/telemetry/usage.ts';
import type { ChatCompletionsResult } from '@floway-dev/protocols/chat-completions';
import { splitInclusiveInputTokens, USAGE_BILLING } from '@floway-dev/protocols/common';

// OpenAI Chat usage reports prompt_tokens inclusive of cached and cache-
// creation tokens; the shared `openAICacheTokensFromUsage` helper resolves
// the variant cache field names (OpenAI canonical, DeepSeek hit/miss split,
// Moonshot flat, OpenRouter cache_write_tokens) onto a single (read, write)
// pair, which we subtract from prompt_tokens to recover the disjoint bare
// input. The top-level `service_tier` echoes the actual processing tier;
// surface it via `billableServiceTier` so per-tier pricing overrides resolve
// at recording time.
// https://developers.openai.com/api/docs/guides/priority-processing
export const tokenUsageFromChatCompletionsUsage = (u: NonNullable<ChatCompletionsResult['usage']>, serviceTier: string | null | undefined) => {
  const { cacheRead, cacheWrite } = openAICacheTokensFromUsage(u);
  const cacheWrite1h = u[USAGE_BILLING]?.cacheWrite1hTokenCount ?? 0;
  if (cacheWrite1h > cacheWrite) throw new RangeError('1-hour cache-write tokens exceed total cache-write tokens');
  const split = splitInclusiveInputTokens(u.prompt_tokens, cacheRead, cacheWrite);
  return tokenUsage({
    input: split.input,
    input_cache_read: split.cacheRead,
    input_cache_write: split.cacheWrite - cacheWrite1h,
    input_cache_write_1h: cacheWrite1h,
    output: u.completion_tokens,
    tier: billableServiceTier(serviceTier),
  });
};

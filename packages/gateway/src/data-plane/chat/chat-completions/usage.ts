import { billableServiceTier, openAICacheTokensFromUsage, tokenUsage } from '../../shared/telemetry/usage.ts';
import type { ChatCompletionsResult } from '@floway-dev/protocols/chat-completions';

// OpenAI Chat usage reports prompt_tokens inclusive of cached and cache-
// creation tokens; the shared `openAICacheTokensFromUsage` helper resolves
// the variant cache field names (OpenAI canonical, DeepSeek hit/miss split,
// Moonshot flat, OpenRouter cache_write_tokens) onto a single (read, write)
// pair, which we subtract from prompt_tokens to recover the disjoint bare
// input. The top-level `service_tier` echoes the actual processing tier;
// surface it via `billableServiceTier` so service-tier selector entries resolve
// at recording time.
// https://developers.openai.com/api/docs/guides/priority-processing
export const tokenUsageFromChatCompletionsUsage = (u: NonNullable<ChatCompletionsResult['usage']>, serviceTier: string | null | undefined) => {
  const { cacheRead, cacheWrite } = openAICacheTokensFromUsage(u);
  return tokenUsage({
    input: u.prompt_tokens - cacheRead - cacheWrite,
    input_cache_read: cacheRead,
    input_cache_write: cacheWrite,
    output: u.completion_tokens,
    tier: billableServiceTier(serviceTier),
  });
};

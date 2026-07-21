import type { TokenUsage } from '../../repo/types.ts';
import { openAICacheTokensFromUsage, tokenUsage } from '../shared/telemetry/usage.ts';
import { billableServiceTier, splitInclusiveInputTokens } from '@floway-dev/protocols/common';

// `/v1/completions` shares OpenAI's CompletionUsage schema with
// `/v1/chat/completions`. Both routes hand off to the shared
// `openAICacheTokensFromUsage` helper for the cache-read / cache-write
// counts so the variant field names wild OpenAI-compatible upstreams
// emit (DeepSeek's `prompt_cache_hit_tokens`, Moonshot's flat
// `cached_tokens`, OpenRouter's `cache_write_tokens`, …) land in the
// correct metrics automatically. The bare `input` token category subtracts
// both cache counts so the three input metrics stay disjoint.
//
// `service_tier` lives on the response root, not inside `usage`, and is
// supplied separately by the caller. vLLM surfaces it on the
// non-streaming /v1/completions body (observed null on a Zhipu/GLM
// fork); the streaming path was observed to omit the field.

export const tokenUsageFromCompletionsUsage = (usage: unknown, serviceTier: string | null | undefined): TokenUsage | null => {
  if (!usage || typeof usage !== 'object') return null;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') return null;
  const { cacheRead, cacheWrite } = openAICacheTokensFromUsage(usage);
  const split = splitInclusiveInputTokens(promptTokens, cacheRead, cacheWrite);
  return tokenUsage({
    input: split.input,
    input_cache_read: split.cacheRead,
    input_cache_write: split.cacheWrite,
    output: completionTokens,
    tier: billableServiceTier(serviceTier),
  });
};

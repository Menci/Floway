import type { TokenUsage } from '../../repo/types.ts';
import { foldsExclusiveCacheTokens, openAICacheTokensFromUsage, tokenUsage } from '../shared/telemetry/usage.ts';
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
//
// This endpoint is a passthrough with no interceptor chain, so the fold the
// chat targets apply to the usage chunk itself happens here instead, on the
// one read that consumes it. `declaredExclusive` carries the serving
// upstream's `usage-exclusive-cached-tokens` flag and `identity` names it in
// whatever `foldsExclusiveCacheTokens` raises.

export const tokenUsageFromCompletionsUsage = (
  usage: unknown,
  serviceTier: string | null | undefined,
  declaredExclusive: boolean,
  identity: string,
): TokenUsage | null => {
  if (!usage || typeof usage !== 'object') return null;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') return null;
  const { cacheRead, cacheWrite } = openAICacheTokensFromUsage(usage);
  const { total_tokens: totalTokens } = usage as { total_tokens?: unknown };
  const fold = foldsExclusiveCacheTokens(declaredExclusive, {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: typeof totalTokens === 'number' ? totalTokens : undefined,
    cacheRead,
    cacheWrite,
  }, identity);
  const split = splitInclusiveInputTokens(fold ? promptTokens + cacheRead + cacheWrite : promptTokens, cacheRead, cacheWrite);
  return tokenUsage({
    input: split.input,
    input_cache_read: split.cacheRead,
    input_cache_write: split.cacheWrite,
    output: completionTokens,
    tier: billableServiceTier(serviceTier),
  });
};

import type { TokenUsage } from '../../repo/types.ts';
import { billableServiceTier, tokenUsage } from '../shared/telemetry/usage.ts';

// `/v1/completions` shares OpenAI's CompletionUsage schema with
// `/v1/chat/completions` — the same prompt-cache split lives under
// `prompt_tokens_details` when the upstream reports it (vLLM, llama.cpp,
// Fireworks, OpenRouter, xAI Grok all populate it; OpenAI's own text
// models leave it absent). The bare `input` dimension subtracts cache_read
// so the two input dimensions stay disjoint, matching what
// tokenUsageFromChatCompletionsUsage does for chat.
//
// `service_tier` lives on the response root, not inside `usage`. vLLM
// surfaces it on the non-streaming /v1/completions body (observed null
// on a Zhipu/GLM fork). The streaming path was observed to omit the
// field, but `service_tier` rides on every chunk root in the
// chat-completions shape; the gateway's streaming closure tracks it
// independently of the usage-only chunk and hands both to this helper
// at settle time — so the moment any upstream populates the field
// (per-chunk or only on the usage chunk) billing picks it up.

export const tokenUsageFromCompletionsUsage = (usage: unknown, serviceTier: string | null | undefined): TokenUsage | null => {
  if (!usage || typeof usage !== 'object') return null;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens, prompt_tokens_details: details } = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
  };
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') return null;
  const cacheRead = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0;
  return tokenUsage({
    input: promptTokens - cacheRead,
    input_cache_read: cacheRead,
    output: completionTokens,
    tier: billableServiceTier(serviceTier),
  });
};

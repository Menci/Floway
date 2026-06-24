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
// vLLM also surfaces `service_tier` on the /v1/completions response root
// (observed value: null on a Zhipu/GLM fork running vLLM 0.23.1rc1 — the
// field is present and serialized but the upstream doesn't populate it
// for this deployment). The streaming path was observed to omit the
// field entirely from every chunk including the final usage chunk; the
// chat-completions equivalent puts service_tier on every chunk root,
// and vLLM is the likely vector for extending /v1/completions streaming
// to the same shape. The streaming closure in serve.ts tracks the latest
// service_tier seen on any event root and hands it to
// billingFromCompletionsUsageAndTier alongside the usage block from the
// final usage chunk — so the moment any upstream populates the field on
// streaming (per-chunk or only the usage chunk) billing picks it up
// without another code change.

export const billingFromCompletionsUsageAndTier = (usage: unknown, serviceTier: string | null | undefined): TokenUsage | null => {
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

// Body-based extractor for the non-streaming JSON path. Reads `usage` and
// `service_tier` from the parsed body root.
export const tokenUsageFromCompletionsBody = (body: unknown): TokenUsage | null => {
  if (!body || typeof body !== 'object') return null;
  const { usage, service_tier: serviceTier } = body as { usage?: unknown; service_tier?: string | null };
  return billingFromCompletionsUsageAndTier(usage, serviceTier);
};

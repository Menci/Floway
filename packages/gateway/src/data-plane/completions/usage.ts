import { tokenUsage } from '../shared/telemetry/usage.ts';
import type { CompletionsStreamEvent, CompletionsUsage } from '@floway-dev/protocols/completions';

// `/v1/completions` shares OpenAI's CompletionUsage schema with
// `/v1/chat/completions` — the same prompt-cache split lives under
// `prompt_tokens_details` when the upstream reports it (vLLM, llama.cpp,
// Fireworks, OpenRouter, xAI Grok all populate it; OpenAI's own text
// models leave it absent). The bare `input` dimension subtracts cache_read
// so the two input dimensions stay disjoint, matching what
// tokenUsageFromChatCompletionsUsage does for chat. No `service_tier` is
// carried — that field is chat-only across every vendor's wire spec.
export const tokenUsageFromCompletionsUsage = (usage: unknown): ReturnType<typeof tokenUsage> | null => {
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
  });
};

// Pull the OpenAI usage chunk shape out of an event. The frame is the
// usage-only chunk (choices: [], usage: defined); we extract the usage
// block (including the optional prompt-cache split) so settleUsage can
// hand the same shape downstream that the non-streaming path delivers.
// Returns null if the chunk does not carry a recognizable usage block.
export const completionsUsageFromStreamEvent = (event: CompletionsStreamEvent | unknown): CompletionsUsage | null => {
  if (!event || typeof event !== 'object') return null;
  const { usage } = event as { usage?: unknown };
  if (!usage || typeof usage !== 'object') return null;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, prompt_tokens_details: rawDetails } = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
  };
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') return null;
  const result: CompletionsUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: typeof totalTokens === 'number' ? totalTokens : promptTokens + completionTokens,
  };
  if (rawDetails && typeof rawDetails === 'object' && typeof rawDetails.cached_tokens === 'number') {
    result.prompt_tokens_details = { cached_tokens: rawDetails.cached_tokens };
  }
  return result;
};

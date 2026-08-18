import { billableServiceTier, splitInclusiveInputTokens, type BillableUsage } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

type OpenAIChatCompletionsUsage = NonNullable<OpenAIChatCompletionsStreamEvent['usage']>;

export const billableUsageFromOpenAIChatCompletionsUsage = (
  usage: OpenAIChatCompletionsUsage,
  serviceTier: string | null | undefined,
): BillableUsage => {
  const cacheWrite = usage.prompt_tokens_details?.cache_creation_input_tokens
    ?? usage.prompt_tokens_details?.cache_write_tokens
    ?? 0;
  const { input, cacheRead } = splitInclusiveInputTokens(
    usage.prompt_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    cacheWrite,
  );
  const tier = billableServiceTier(serviceTier);
  return {
    input,
    cacheRead,
    cacheWrite,
    // OpenAI Chat Completions has no cache-write TTL split.
    cacheWrite1h: 0,
    output: usage.completion_tokens,
    ...(tier !== null ? { tier } : {}),
  };
};

export const billableUsageFromOpenAIChatCompletionsEvent = (event: OpenAIChatCompletionsStreamEvent): BillableUsage | null =>
  event.usage ? billableUsageFromOpenAIChatCompletionsUsage(event.usage, event.service_tier) : null;

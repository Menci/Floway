import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { billableServiceTier, splitInclusiveInputTokens, type BillableUsage } from '@floway-dev/protocols/common';

type ChatCompletionsUsage = NonNullable<ChatCompletionsStreamEvent['usage']>;

export const billableUsageFromChatCompletionsUsage = (
  usage: ChatCompletionsUsage,
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
    // Chat Completions has no cache-write TTL split.
    cacheWrite1h: 0,
    output: usage.completion_tokens,
    ...(tier !== null ? { tier } : {}),
  };
};

export const billableUsageFromChatCompletionsEvent = (event: ChatCompletionsStreamEvent): BillableUsage | null =>
  event.usage ? billableUsageFromChatCompletionsUsage(event.usage, event.service_tier) : null;

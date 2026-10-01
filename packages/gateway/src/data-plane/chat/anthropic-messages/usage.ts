import type { ChatBillableUsage } from '../shared/usage.ts';
import { mergeAnthropicMessagesUsageSnapshot, anthropicMessagesUsageSnapshot, splitAnthropicMessagesCacheCreationTokens, type AnthropicMessagesStreamEvent, type AnthropicMessagesUsageSnapshot } from '@floway-dev/protocols/anthropic-messages';
import { billableServiceTier } from '@floway-dev/protocols/common';

// Anthropic reports `input_tokens` exclusive of both cache buckets already,
// and splits cache creation by TTL — the two rates we are billed at.
export const billableUsageFromAnthropicMessagesUsage = (usage: AnthropicMessagesUsageSnapshot): ChatBillableUsage | null => {
  if (usage.input_tokens === undefined && usage.output_tokens === undefined) return null;
  const { cacheWrite, cacheWrite1h } = splitAnthropicMessagesCacheCreationTokens(usage);
  const tier = billableServiceTier(usage.speed) ?? billableServiceTier(usage.service_tier);
  return {
    ...(usage.input_tokens === undefined ? {} : { input: usage.input_tokens }),
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite,
    cacheWrite1h,
    ...(usage.output_tokens === undefined ? {} : { output: usage.output_tokens }),
    ...(tier !== null ? { tier } : {}),
  };
};

// Anthropic reports input accounting on `message_start` and output accounting
// on `message_delta`, so the running figure is merged across both.
export const createAnthropicMessagesBillableUsageReader = (): (event: AnthropicMessagesStreamEvent) => ChatBillableUsage | null => {
  let merged = anthropicMessagesUsageSnapshot();
  return event => {
    const usage = event.type === 'message_start' ? event.message.usage
      : event.type === 'message_delta' ? event.usage
        : undefined;
    if (usage === undefined) return null;
    merged = mergeAnthropicMessagesUsageSnapshot(merged, usage);
    return billableUsageFromAnthropicMessagesUsage(merged);
  };
};

import type { ChatBillableUsage } from '../shared/usage.ts';
import { mergeAnthropicMessagesUsageSnapshot, anthropicMessagesUsageSnapshot, splitAnthropicMessagesCacheCreationTokens, type AnthropicMessagesStreamEventEx, type AnthropicMessagesUsageSnapshot } from '@floway-dev/protocols/anthropic-messages';
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
export const createAnthropicMessagesBillableUsageReader = (): (event: AnthropicMessagesStreamEventEx) => ChatBillableUsage | null => {
  let merged = anthropicMessagesUsageSnapshot();
  return event => {
    if (event.type === 'message_start') merged = anthropicMessagesUsageSnapshot(event.message.usage);
    else if (event.type === 'message_delta' && event.usage !== undefined) merged = mergeAnthropicMessagesUsageSnapshot(merged, event.usage);
    else return null;
    return billableUsageFromAnthropicMessagesUsage(merged);
  };
};

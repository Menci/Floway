import { billableServiceTier, type BillableUsage } from '@floway-dev/protocols/common';
import { mergeMessagesUsageSnapshot, messagesUsageSnapshot, splitMessagesCacheCreationTokens, type MessagesStreamEvent, type MessagesUsageSnapshot } from '@floway-dev/protocols/messages';

// Anthropic reports `input_tokens` exclusive of both cache buckets already,
// and splits cache creation by TTL — the two rates we are billed at.
export const billableUsageFromMessagesUsage = (usage: MessagesUsageSnapshot): BillableUsage | null => {
  if (usage.input_tokens === undefined && usage.output_tokens === undefined) return null;
  const { cacheWrite, cacheWrite1h } = splitMessagesCacheCreationTokens(usage);
  const tier = billableServiceTier(usage.speed) ?? billableServiceTier(usage.service_tier);
  return {
    input: usage.input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite,
    cacheWrite1h,
    output: usage.output_tokens ?? 0,
    ...(tier !== null ? { tier } : {}),
  };
};

// Anthropic reports input accounting on `message_start` and output accounting
// on `message_delta`, so the running figure is merged across both.
export const createMessagesBillableUsageReader = (): (event: MessagesStreamEvent) => BillableUsage | null => {
  let merged = messagesUsageSnapshot();
  return event => {
    const usage = event.type === 'message_start' ? event.message.usage
      : event.type === 'message_delta' ? event.usage
        : undefined;
    if (usage === undefined) return null;
    merged = mergeMessagesUsageSnapshot(merged, messagesUsageSnapshot(usage));
    return billableUsageFromMessagesUsage(merged);
  };
};

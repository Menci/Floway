import { billableServiceTier, type BillableUsage } from '@floway-dev/protocols/common';
import { splitMessagesCacheCreationTokens, type MessagesUsageSnapshot } from '@floway-dev/protocols/messages';

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

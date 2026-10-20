import type { IRUsage } from '../../../ir/types.ts';
import { requireTokenCount } from '../../../shared/token-count.ts';
import { type AnthropicMessagesUsageDeltaEx, splitAnthropicMessagesCacheCreationTokens } from '@floway-dev/protocols/anthropic-messages';
import { splitInclusiveInputTokens } from '@floway-dev/protocols/common';

// Messages reports input, cache reads and cache writes as disjoint counts that
// can arrive in different events, while IR stores their inclusive sum.
export interface AnthropicMessagesInputCounts {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export const usageToIR = (usage: Partial<AnthropicMessagesUsageDeltaEx> | null | undefined, counts: AnthropicMessagesInputCounts): IRUsage => {
  const result: Partial<Record<keyof IRUsage, number>> = {};
  if (usage == null) return result;
  const put = (key: keyof IRUsage, value: number | undefined | null): void => { if (value != null) result[key] = requireTokenCount(key, value); };
  if (usage.input_tokens != null) counts.input = requireTokenCount('input_tokens', usage.input_tokens);
  if (usage.cache_read_input_tokens != null) counts.cacheRead = requireTokenCount('cache_read_input_tokens', usage.cache_read_input_tokens);
  const hasCacheWrite = usage.cache_creation_input_tokens != null || usage.cache_creation != null;
  if (hasCacheWrite) {
    const { cacheWrite, cacheWrite1h } = splitAnthropicMessagesCacheCreationTokens({
      ...(usage.cache_creation_input_tokens == null ? {} : { cache_creation_input_tokens: usage.cache_creation_input_tokens }),
      ...(usage.cache_creation == null ? {} : { cache_creation: usage.cache_creation }),
    });
    counts.cacheWrite = cacheWrite + cacheWrite1h;
  }
  if (counts.input !== undefined && (usage.input_tokens != null || usage.cache_read_input_tokens != null || hasCacheWrite)) {
    put('input_tokens_inclusive', counts.input + (counts.cacheRead ?? 0) + (counts.cacheWrite ?? 0));
    splitInclusiveInputTokens(result.input_tokens_inclusive!, counts.cacheRead ?? 0, counts.cacheWrite ?? 0);
  }
  put('output_tokens_inclusive', usage.output_tokens);
  put('cached_input_tokens', usage.cache_read_input_tokens);
  if (hasCacheWrite) put('cache_creation_input_tokens', counts.cacheWrite);
  put('reasoning_tokens', usage.output_tokens_details?.thinking_tokens);
  return result;
};

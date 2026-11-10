import type { IRUsage } from '../../../ir/types.ts';
import { requireTokenCount } from '../../../shared/token-count.ts';
import { type AnthropicMessagesUsage, createAnthropicMessagesUsage } from '@floway-dev/protocols/anthropic-messages';
import { splitInclusiveInputTokens } from '@floway-dev/protocols/common';
export const usageFromIR = (usage: IRUsage): AnthropicMessagesUsage => {
  const count = (key: keyof IRUsage): number | undefined => usage[key] === undefined ? undefined : requireTokenCount(key, usage[key]);
  const input = count('input_tokens_inclusive') ?? 0;
  const output = count('output_tokens_inclusive') ?? 0;
  const cached = count('cached_input_tokens') ?? 0;
  const created = count('cache_creation_input_tokens') ?? 0;
  const split = splitInclusiveInputTokens(input, cached, created);
  const reasoning = count('reasoning_tokens');
  return {
    ...createAnthropicMessagesUsage(split.input, output),
    cache_read_input_tokens: usage.cached_input_tokens === undefined ? null : cached,
    cache_creation_input_tokens: usage.cache_creation_input_tokens === undefined ? null : created,
    output_tokens_details: reasoning === undefined ? null : { thinking_tokens: reasoning },
  };
};

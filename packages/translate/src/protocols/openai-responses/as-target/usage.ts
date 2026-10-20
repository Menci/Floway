import type { IRUsage } from '../../../ir/types.ts';
import { requireTokenCount } from '../../../shared/token-count.ts';
import { splitInclusiveInputTokens } from '@floway-dev/protocols/common';

// The usage fields read here: the protocol usage plus the modality and cache-creation counts that compatible upstreams add.
interface OpenAIResponsesUsageFields {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_creation_input_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
    text_tokens?: number;
  };
  output_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number; text_tokens?: number };
}

export const usageToIR = (usage: OpenAIResponsesUsageFields): IRUsage => {
  const result: Partial<Record<keyof IRUsage, number>> = {};
  const put = (key: keyof IRUsage, value: number | undefined | null): void => { if (value != null) result[key] = requireTokenCount(key, value); };
  put('input_tokens_inclusive', usage.input_tokens);
  put('output_tokens_inclusive', usage.output_tokens);
  put('total_tokens', usage.total_tokens);
  const input = usage.input_tokens_details;
  const output = usage.output_tokens_details;
  put('cached_input_tokens', input?.cached_tokens);
  put('cache_creation_input_tokens', input?.cache_creation_input_tokens ?? input?.cache_write_tokens);
  put('reasoning_tokens', output?.reasoning_tokens);
  put('input_audio_tokens', input?.audio_tokens);
  put('input_text_tokens', input?.text_tokens);
  put('input_image_tokens', input?.image_tokens);
  put('output_audio_tokens', output?.audio_tokens);
  put('output_text_tokens', output?.text_tokens);
  if (result.input_tokens_inclusive !== undefined) {
    splitInclusiveInputTokens(result.input_tokens_inclusive, result.cached_input_tokens ?? 0, result.cache_creation_input_tokens ?? 0);
  }
  return result;
};

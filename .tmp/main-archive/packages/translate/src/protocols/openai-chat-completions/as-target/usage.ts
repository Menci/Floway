import type { IRUsage } from '../../../ir/types.ts';
import { requireTokenCount } from '../../../shared/token-count.ts';
import { splitInclusiveInputTokens } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsUsageEx } from '@floway-dev/protocols/openai-chat-completions';

export const usageToIR = (usage: Partial<OpenAIChatCompletionsUsageEx>): IRUsage => {
  const result: Partial<Record<keyof IRUsage, number>> = {};
  const put = (key: keyof IRUsage, value: number | undefined | null): void => { if (value != null) result[key] = requireTokenCount(key, value); };
  put('input_tokens_inclusive', usage.prompt_tokens);
  put('output_tokens_inclusive', usage.completion_tokens);
  put('total_tokens', usage.total_tokens);
  const input = usage.prompt_tokens_details;
  const output = usage.completion_tokens_details;
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

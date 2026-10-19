import type { IRUsage } from '../../../ir/types.ts';
import { requireTokenCount } from '../../../shared/token-count.ts';
import type { OpenAIChatCompletionsUsageEx } from '@floway-dev/protocols/openai-chat-completions';

export const usageFromIR = (usage: IRUsage): OpenAIChatCompletionsUsageEx => {
  const count = (key: keyof IRUsage): number | undefined => usage[key] === undefined ? undefined : requireTokenCount(key, usage[key]);
  const input = count('input_tokens_inclusive') ?? 0;
  const output = count('output_tokens_inclusive') ?? 0;
  const inputDetails: NonNullable<OpenAIChatCompletionsUsageEx['prompt_tokens_details']> = {};
  const outputDetails: NonNullable<OpenAIChatCompletionsUsageEx['completion_tokens_details']> = {};
  if (usage.cached_input_tokens !== undefined) inputDetails.cached_tokens = count('cached_input_tokens');
  if (usage.cache_creation_input_tokens !== undefined) inputDetails.cache_creation_input_tokens = count('cache_creation_input_tokens');
  if (usage.reasoning_tokens !== undefined) outputDetails.reasoning_tokens = count('reasoning_tokens');
  if (usage.input_audio_tokens !== undefined) inputDetails.audio_tokens = requireTokenCount('input_audio_tokens', usage.input_audio_tokens);
  if (usage.output_audio_tokens !== undefined) outputDetails.audio_tokens = requireTokenCount('output_audio_tokens', usage.output_audio_tokens);
  if (usage.input_image_tokens !== undefined) inputDetails.image_tokens = requireTokenCount('input_image_tokens', usage.input_image_tokens);
  if (usage.input_text_tokens !== undefined) inputDetails.text_tokens = requireTokenCount('input_text_tokens', usage.input_text_tokens);
  if (usage.output_text_tokens !== undefined) outputDetails.text_tokens = requireTokenCount('output_text_tokens', usage.output_text_tokens);
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: count('total_tokens') ?? input + output,
    ...(Object.keys(inputDetails).length === 0 ? {} : { prompt_tokens_details: inputDetails }),
    ...(Object.keys(outputDetails).length === 0 ? {} : { completion_tokens_details: outputDetails }),
  };
};

import type { IRUsage } from '../../../ir/types.ts';
import { requireTokenCount } from '../../../shared/token-count.ts';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

type OpenAIResponsesUsage = NonNullable<OpenAIResponsesResultEx['usage']>;
type OpenAIResponsesInputTokensDetails = NonNullable<OpenAIResponsesUsage['input_tokens_details']>;

export const usageFromIR = (usage: IRUsage): OpenAIResponsesUsage => {
  const count = (key: keyof IRUsage): number | undefined => usage[key] === undefined ? undefined : requireTokenCount(key, usage[key]);
  const input = count('input_tokens_inclusive') ?? 0;
  const output = count('output_tokens_inclusive') ?? 0;
  const inputDetails: Partial<OpenAIResponsesInputTokensDetails> = {};
  const reasoning = count('reasoning_tokens');
  if (usage.cached_input_tokens !== undefined) inputDetails.cached_tokens = count('cached_input_tokens');
  if (usage.cache_creation_input_tokens !== undefined) inputDetails.cache_write_tokens = count('cache_creation_input_tokens');

  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: count('total_tokens') ?? input + output,
    // A cache write may be reported without cache reads, which the wire type does not model.
    ...(Object.keys(inputDetails).length === 0 ? {} : { input_tokens_details: inputDetails as OpenAIResponsesInputTokensDetails }),
    ...(reasoning === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoning } }),
  };
};

import type { IRUsage } from '../../../ir/types.ts';
import { requireTokenCount } from '../../../shared/token-count.ts';
import { splitInclusiveOutputTokens } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentModalityTokenCount, GeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';

export const usageFromIR = (usage: IRUsage): GeminiGenerateContentUsageMetadata => {
  const count = (key: keyof IRUsage): number | undefined => usage[key] === undefined ? undefined : requireTokenCount(key, usage[key]);
  const input = count('input_tokens_inclusive') ?? 0;
  const output = count('output_tokens_inclusive') ?? 0;
  const reasoning = count('reasoning_tokens');
  const split = splitInclusiveOutputTokens(output, reasoning);
  const modalityTokens = (keys: readonly (readonly [modality: string, key: keyof IRUsage])[]): GeminiGenerateContentModalityTokenCount[] =>
    keys.flatMap(([modality, key]) => usage[key] === undefined ? [] : [{ modality, tokenCount: requireTokenCount(key, usage[key]) }]);
  const promptDetails = modalityTokens([['AUDIO', 'input_audio_tokens'], ['IMAGE', 'input_image_tokens'], ['TEXT', 'input_text_tokens']]);
  const candidatesDetails = modalityTokens([['AUDIO', 'output_audio_tokens'], ['TEXT', 'output_text_tokens']]);
  return {
    promptTokenCount: input,
    candidatesTokenCount: split.output,
    totalTokenCount: count('total_tokens') ?? input + output,
    ...(usage.cached_input_tokens === undefined ? {} : { cachedContentTokenCount: count('cached_input_tokens') }),
    ...(reasoning === undefined ? {} : { thoughtsTokenCount: reasoning }),
    ...(promptDetails.length === 0 ? {} : { promptTokensDetails: promptDetails }),
    ...(candidatesDetails.length === 0 ? {} : { candidatesTokensDetails: candidatesDetails }),
  };
};

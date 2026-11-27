import type { IROutputUsage } from '../../../ir/output/types.ts';
import { requireTokenCount } from '../../../shared/token-count.ts';
import { splitInclusiveInputTokens } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentModalityTokenCount, GeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';

const collectModalityCounts = (
  details: readonly GeminiGenerateContentModalityTokenCount[] | undefined,
  mapping: Readonly<Record<string, keyof IROutputUsage>>,
  result: Partial<Record<keyof IROutputUsage, number>>,
): void => {
  if (details === undefined) return;
  for (const entry of details) {
    if (entry.modality === undefined || entry.tokenCount === undefined) continue;
    const key = mapping[entry.modality];
    if (key === undefined) continue;
    result[key] = (result[key] ?? 0) + requireTokenCount(key, entry.tokenCount);
  }
};

// Matches `@floway-dev/protocols`'s `billableUsageFromGeminiGenerateContentUsage`:
// `promptTokenCount` + `toolUsePromptTokenCount` form inclusive input tokens,
// and `candidatesTokenCount` + `thoughtsTokenCount` form inclusive output tokens.
// https://ai.google.dev/api/generate-content#UsageMetadata
export const usageToIR = (usage: GeminiGenerateContentUsageMetadata): IROutputUsage => {
  const result: Partial<Record<keyof IROutputUsage, number>> = {};
  const put = (key: keyof IROutputUsage, value: number | undefined): void => {
    if (value !== undefined) result[key] = requireTokenCount(key, value);
  };

  const prompt = usage.promptTokenCount === undefined
    ? undefined
    : requireTokenCount('input_tokens_inclusive', usage.promptTokenCount);
  const toolUsePrompt = usage.toolUsePromptTokenCount === undefined
    ? undefined
    : requireTokenCount('input_tokens_inclusive', usage.toolUsePromptTokenCount);
  if (prompt !== undefined || toolUsePrompt !== undefined) {
    result.input_tokens_inclusive = (prompt ?? 0) + (toolUsePrompt ?? 0);
  }
  put('cached_input_tokens', usage.cachedContentTokenCount);
  put('total_tokens', usage.totalTokenCount);

  const candidates = usage.candidatesTokenCount === undefined
    ? undefined
    : requireTokenCount('output_tokens_inclusive', usage.candidatesTokenCount);
  const thoughts = usage.thoughtsTokenCount === undefined
    ? undefined
    : requireTokenCount('reasoning_tokens', usage.thoughtsTokenCount);
  if (thoughts !== undefined) result.reasoning_tokens = thoughts;
  if (candidates !== undefined || thoughts !== undefined) {
    result.output_tokens_inclusive = (candidates ?? 0) + (thoughts ?? 0);
  }

  const inputModalities: Readonly<Record<string, keyof IROutputUsage>> = {
    AUDIO: 'input_audio_tokens',
    IMAGE: 'input_image_tokens',
    TEXT: 'input_text_tokens',
  };
  collectModalityCounts(usage.promptTokensDetails, inputModalities, result);
  collectModalityCounts(usage.toolUsePromptTokensDetails, inputModalities, result);
  collectModalityCounts(
    usage.candidatesTokensDetails,
    { AUDIO: 'output_audio_tokens', TEXT: 'output_text_tokens' },
    result,
  );

  if (result.input_tokens_inclusive !== undefined) {
    splitInclusiveInputTokens(result.input_tokens_inclusive, result.cached_input_tokens ?? 0, 0);
  }
  return result;
};

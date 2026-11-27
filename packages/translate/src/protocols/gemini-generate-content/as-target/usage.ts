import type { IROutputUsage } from '../../../ir/output/types.ts';
import { requireTokenCount } from '../../../shared/token-count.ts';
import { splitInclusiveInputTokens } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentModalityTokenCount, GeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';

const INPUT_MODALITIES: Readonly<Record<string, keyof IROutputUsage>> = {
  AUDIO: 'input_audio_tokens',
  IMAGE: 'input_image_tokens',
  TEXT: 'input_text_tokens',
};

const OUTPUT_MODALITIES: Readonly<Record<string, keyof IROutputUsage>> = {
  AUDIO: 'output_audio_tokens',
  TEXT: 'output_text_tokens',
};

export interface GeminiGenerateContentUsageAccumulator {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  promptTokensDetails?: GeminiGenerateContentModalityTokenCount[];
  toolUsePromptTokensDetails?: GeminiGenerateContentModalityTokenCount[];
}

const mergeUsageSnapshot = (
  accumulator: GeminiGenerateContentUsageAccumulator,
  incoming: GeminiGenerateContentUsageMetadata,
): GeminiGenerateContentUsageMetadata => {
  if (incoming.promptTokenCount != null) accumulator.promptTokenCount = incoming.promptTokenCount;
  if (incoming.candidatesTokenCount != null) accumulator.candidatesTokenCount = incoming.candidatesTokenCount;
  if (incoming.cachedContentTokenCount != null) accumulator.cachedContentTokenCount = incoming.cachedContentTokenCount;
  if (incoming.thoughtsTokenCount != null) accumulator.thoughtsTokenCount = incoming.thoughtsTokenCount;
  if (incoming.toolUsePromptTokenCount != null) accumulator.toolUsePromptTokenCount = incoming.toolUsePromptTokenCount;
  if (incoming.promptTokensDetails != null && incoming.promptTokensDetails.length > 0) {
    accumulator.promptTokensDetails = incoming.promptTokensDetails;
  }
  if (incoming.toolUsePromptTokensDetails != null && incoming.toolUsePromptTokensDetails.length > 0) {
    accumulator.toolUsePromptTokensDetails = incoming.toolUsePromptTokensDetails;
  }
  return {
    ...accumulator,
    ...(incoming.totalTokenCount == null ? {} : { totalTokenCount: incoming.totalTokenCount }),
    ...(incoming.candidatesTokensDetails == null || incoming.candidatesTokensDetails.length === 0
      ? {}
      : { candidatesTokensDetails: incoming.candidatesTokensDetails }),
  };
};

const collectModalityCounts = (
  details: readonly GeminiGenerateContentModalityTokenCount[] | null | undefined,
  mapping: Readonly<Record<string, keyof IROutputUsage>>,
  result: Partial<Record<keyof IROutputUsage, number>>,
): void => {
  if (details == null) return;
  for (const entry of details) {
    if (entry.modality == null || entry.tokenCount == null || !Object.hasOwn(mapping, entry.modality)) continue;
    const key = mapping[entry.modality];
    result[key] = (result[key] ?? 0) + requireTokenCount(key, entry.tokenCount);
  }
};

// Matches `@floway-dev/protocols`'s `billableUsageFromGeminiGenerateContentUsage`:
// `promptTokenCount` + `toolUsePromptTokenCount` form inclusive input tokens,
// and `candidatesTokenCount` + `thoughtsTokenCount` form inclusive output tokens.
// https://ai.google.dev/api/generate-content#UsageMetadata
export const usageToIR = (
  incoming: GeminiGenerateContentUsageMetadata,
  accumulator?: GeminiGenerateContentUsageAccumulator,
): IROutputUsage => {
  const usage = accumulator === undefined ? incoming : mergeUsageSnapshot(accumulator, incoming);
  const result: Partial<Record<keyof IROutputUsage, number>> = {};
  const put = (key: keyof IROutputUsage, value: number | null | undefined): void => {
    if (value != null) result[key] = requireTokenCount(key, value);
  };

  const prompt = usage.promptTokenCount == null
    ? undefined
    : requireTokenCount('input_tokens_inclusive', usage.promptTokenCount);
  const toolUsePrompt = usage.toolUsePromptTokenCount == null
    ? undefined
    : requireTokenCount('input_tokens_inclusive', usage.toolUsePromptTokenCount);
  if (prompt !== undefined || toolUsePrompt !== undefined) {
    result.input_tokens_inclusive = (prompt ?? 0) + (toolUsePrompt ?? 0);
  }
  put('cached_input_tokens', usage.cachedContentTokenCount);
  put('total_tokens', usage.totalTokenCount);

  const candidates = usage.candidatesTokenCount == null
    ? undefined
    : requireTokenCount('output_tokens_inclusive', usage.candidatesTokenCount);
  const thoughts = usage.thoughtsTokenCount == null
    ? undefined
    : requireTokenCount('reasoning_tokens', usage.thoughtsTokenCount);
  if (candidates !== undefined || thoughts !== undefined) {
    result.output_tokens_inclusive = (candidates ?? 0) + (thoughts ?? 0);
  }
  if (thoughts !== undefined) result.reasoning_tokens = thoughts;

  collectModalityCounts(usage.promptTokensDetails, INPUT_MODALITIES, result);
  collectModalityCounts(usage.toolUsePromptTokensDetails, INPUT_MODALITIES, result);
  collectModalityCounts(usage.candidatesTokensDetails, OUTPUT_MODALITIES, result);

  if (result.input_tokens_inclusive !== undefined) {
    splitInclusiveInputTokens(result.input_tokens_inclusive, result.cached_input_tokens ?? 0, 0);
  }
  return result;
};

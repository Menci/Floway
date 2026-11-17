import type { GeminiGenerateContentStreamEvent, GeminiGenerateContentUsageMetadata } from './index.ts';
import { billableServiceTier, splitInclusiveInputTokens, type BillableUsage } from '../common/usage.ts';

// Gemini's usage buckets add up as
//   totalTokenCount = promptTokenCount + candidatesTokenCount + toolUsePromptTokenCount + thoughtsTokenCount
// with `promptTokenCount` already including the cached prefix, and
// `candidatesTokenCount` excluding thoughts. Tool-execution results are billed
// as ordinary input, so the billable input is prompt + tool-use prompt.
// https://ai.google.dev/api/generate-content#UsageMetadata
export const billableUsageFromGeminiGenerateContentUsage = (
  usage: GeminiGenerateContentUsageMetadata,
): BillableUsage | null => {
  if (usage.promptTokenCount === undefined && usage.candidatesTokenCount === undefined) return null;
  const prompt = usage.promptTokenCount ?? 0;
  const toolUsePrompt = usage.toolUsePromptTokenCount ?? 0;
  const { input, cacheRead } = splitInclusiveInputTokens(prompt + toolUsePrompt, usage.cachedContentTokenCount, undefined);
  // Thoughts are billed at the output rate, so the billable output is the sum
  // of both buckets — the same inclusive convention the other protocols use
  // for their reasoning tokens.
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const tier = billableServiceTier(usage.serviceTier);
  return {
    input,
    cacheRead,
    // Gemini bills cache storage separately from tokens and reports no
    // cache-write bucket on the response, so there is nothing to price here.
    cacheWrite: 0,
    cacheWrite1h: 0,
    output,
    ...(tier !== null ? { tier } : {}),
  };
};

// `usageMetadata` is cumulative: every chunk of a stream carries the running
// totals, and the terminal chunk carries the final ones. Reporting each
// non-null reading lets the gateway's last-writer-wins bookkeeping land on the
// terminal figure.
export const billableUsageFromGeminiGenerateContentEvent = (event: GeminiGenerateContentStreamEvent): BillableUsage | null =>
  'error' in event || event.usageMetadata === undefined ? null : billableUsageFromGeminiGenerateContentUsage(event.usageMetadata);

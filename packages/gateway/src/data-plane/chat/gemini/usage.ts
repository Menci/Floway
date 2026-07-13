import { tokenUsage } from '../../shared/telemetry/usage.ts';
import { splitInclusiveInputTokens, USAGE_BILLING } from '@floway-dev/protocols/common';
import type { GeminiUsageMetadata } from '@floway-dev/protocols/gemini';

export const tokenUsageFromGeminiUsageMetadata = (metadata: GeminiUsageMetadata) => {
  const billing = metadata[USAGE_BILLING];
  const cacheWrite = billing?.cacheWriteTokenCount ?? 0;
  const cacheWrite1h = billing?.cacheWrite1hTokenCount ?? 0;
  const { input, cacheRead } = splitInclusiveInputTokens(
    metadata.promptTokenCount ?? 0,
    metadata.cachedContentTokenCount,
    cacheWrite + cacheWrite1h,
  );
  return tokenUsage({
    input,
    input_cache_read: cacheRead,
    input_cache_write: cacheWrite,
    input_cache_write_1h: cacheWrite1h,
    output: (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0),
    tier: billing?.serviceTier,
  });
};

import { tokenUsage } from '../../shared/telemetry/usage.ts';
import { splitInclusiveInputTokens } from '@floway-dev/protocols/common';
import { GEMINI_USAGE_BILLING, type GeminiUsageMetadata } from '@floway-dev/protocols/gemini';

export const tokenUsageFromGeminiUsageMetadata = (metadata: GeminiUsageMetadata) => {
  const billing = metadata[GEMINI_USAGE_BILLING];
  const { input, cacheRead, cacheWrite } = splitInclusiveInputTokens(
    metadata.promptTokenCount ?? 0,
    metadata.cachedContentTokenCount,
    billing?.cacheWriteTokenCount,
  );
  return tokenUsage({
    input,
    input_cache_read: cacheRead,
    input_cache_write: cacheWrite,
    output: (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0),
    tier: billing?.serviceTier,
  });
};

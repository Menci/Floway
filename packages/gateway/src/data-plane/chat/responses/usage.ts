import { billableServiceTier, tokenUsage } from '../../shared/telemetry/usage.ts';
import { splitInclusiveInputTokens, USAGE_BILLING } from '@floway-dev/protocols/common';
import type { ResponsesResult } from '@floway-dev/protocols/responses';

// OpenAI Responses reports input_tokens inclusive of cached tokens; subtract
// the cached split to recover the disjoint bare input. The top-level
// `service_tier` echoes the actual processing tier the upstream served the
// request at (e.g. `default` when capacity downgraded a `priority` request).
// We surface it via `billableServiceTier` so per-tier pricing overrides
// resolve at recording time.
// https://developers.openai.com/api/docs/guides/priority-processing
export const tokenUsageFromResponsesResult = (response: ResponsesResult) => {
  const usage = response.usage;
  if (!usage) return null;
  const cacheWrite1h = usage[USAGE_BILLING]?.cacheWrite1hTokenCount ?? 0;
  const { input, cacheRead, cacheWrite } = splitInclusiveInputTokens(
    usage.input_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cache_write_tokens,
  );
  if (cacheWrite1h > cacheWrite) throw new RangeError('1-hour cache-write tokens exceed total cache-write tokens');
  return tokenUsage({
    input,
    input_cache_read: cacheRead,
    input_cache_write: cacheWrite - cacheWrite1h,
    input_cache_write_1h: cacheWrite1h,
    output: usage.output_tokens,
    tier: billableServiceTier(response.service_tier),
  });
};

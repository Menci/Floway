import { billableServiceTier, tokenUsage } from '../../shared/telemetry/usage.ts';
import { splitInclusiveInputTokens } from '@floway-dev/protocols/common';
import type { ResponsesResult } from '@floway-dev/protocols/responses';

// service_tier reports the tier actually served and therefore selects the
// matching pricing entry rather than the tier originally requested.
// https://developers.openai.com/api/docs/guides/priority-processing
export const tokenUsageFromResponsesResult = (response: ResponsesResult) => {
  const usage = response.usage;
  if (!usage) return null;
  const { input, cacheRead, cacheWrite } = splitInclusiveInputTokens(
    usage.input_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cache_write_tokens,
  );
  return tokenUsage({
    input,
    input_cache_read: cacheRead,
    input_cache_write: cacheWrite,
    output: usage.output_tokens,
    tier: billableServiceTier(response.service_tier),
  });
};

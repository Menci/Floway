import { billableServiceTier, splitInclusiveInputTokens, type BillableUsage } from '@floway-dev/protocols/common';
import { responsesResultFromStreamEvent, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// service_tier reports the tier actually served and therefore selects the
// matching pricing entry rather than the tier originally requested.
// https://developers.openai.com/api/docs/guides/priority-processing
// Takes what it reads rather than a whole result, so a compaction body --
// which states `usage` and none of the response-only fields -- can be priced
// through the same helper.
export const billableUsageFromResponsesResult = (response: { readonly usage?: ResponsesResult['usage'] }): BillableUsage | null => {
  const usage = response.usage;
  if (!usage) return null;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  const { input, cacheRead } = splitInclusiveInputTokens(
    usage.input_tokens,
    usage.input_tokens_details?.cached_tokens,
    cacheWrite,
  );
  const tier = billableServiceTier(response.service_tier);
  return {
    input,
    cacheRead,
    cacheWrite,
    // Responses has no cache-write TTL split; every write bills at one rate.
    cacheWrite1h: 0,
    output: usage.output_tokens,
    ...(tier !== null ? { tier } : {}),
  };
};

export const billableUsageFromResponsesEvent = (event: ResponsesStreamEvent): BillableUsage | null => {
  const response = responsesResultFromStreamEvent(event);
  return response === null ? null : billableUsageFromResponsesResult(response);
};

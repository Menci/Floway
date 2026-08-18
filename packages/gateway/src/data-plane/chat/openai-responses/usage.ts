import { billableServiceTier, splitInclusiveInputTokens, type BillableUsage } from '@floway-dev/protocols/common';
import { openaiResponsesResultFromStreamEvent, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

// service_tier reports the tier actually served and therefore selects the
// matching pricing entry rather than the tier originally requested.
// https://developers.openai.com/api/docs/guides/priority-processing
// Takes the two fields it reads rather than a whole result, so a compaction
// body can be priced through the same helper.
export const billableUsageFromOpenAIResponsesResult = (
  response: { readonly usage?: OpenAIResponsesResult['usage']; readonly service_tier?: OpenAIResponsesResult['service_tier'] },
): BillableUsage | null => {
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
    // OpenAI Responses has no cache-write TTL split; every write bills at one rate.
    cacheWrite1h: 0,
    output: usage.output_tokens,
    ...(tier !== null ? { tier } : {}),
  };
};

export const billableUsageFromOpenAIResponsesEvent = (event: OpenAIResponsesStreamEvent): BillableUsage | null => {
  const response = openaiResponsesResultFromStreamEvent(event);
  return response === null ? null : billableUsageFromOpenAIResponsesResult(response);
};

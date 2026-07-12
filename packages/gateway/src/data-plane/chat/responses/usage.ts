import { billableServiceTier, tokenUsage } from '../../shared/telemetry/usage.ts';
import { splitResponsesInputTokens, type ResponsesResult } from '@floway-dev/protocols/responses';

// OpenAI Responses reports input_tokens inclusive of the cache-read and
// cache-write splits; subtract both to recover the disjoint bare input. A
// prompt token is billed under exactly one of input / cache-read / cache-write.
// The top-level `service_tier` echoes the actual processing tier the upstream
// served the request at (e.g. `default` when capacity downgraded a `priority`
// request). We surface it via `billableServiceTier` so per-tier pricing
// overrides resolve at recording time.
//
// If the cache splits exceed the reported input total the payload is malformed
// (cache tokens are a subset of input, never a superset); we reject the whole
// usage object rather than clamp a negative bare input to zero, which would
// silently mis-bill.
// https://developers.openai.com/api/docs/guides/priority-processing
export const tokenUsageFromResponsesResult = (response: ResponsesResult) => {
  const usage = response.usage;
  if (!usage) return null;
  const { input, cacheRead, cacheWrite } = splitResponsesInputTokens(
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

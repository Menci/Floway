import type { UsageObserverContext } from '../pipeline/compute-usage.ts';
import type { UsageMeasurement } from '../shared/telemetry/usage.ts';
import { parseDecimalString } from '@floway-dev/protocols/common';
import { parseRerankUsage, type CanonicalRerankResponse } from '@floway-dev/protocols/rerank';

export const measureRerankUsage = ({ searchUnits, totalTokens }: Pick<CanonicalRerankResponse, 'searchUnits' | 'totalTokens'>): UsageMeasurement | null => {
  if (searchUnits === undefined && totalTokens === undefined) return null;
  return {
    quantities: {
      ...(searchUnits === undefined ? {} : { rerank_searches: parseDecimalString(String(searchUnits)) }),
      ...(totalTokens === undefined ? {} : { input_tokens: parseDecimalString(String(totalTokens)) }),
    },
    pricingFacts: totalTokens === undefined ? {} : { inputTokens: totalTokens },
    dumpTokenUsage: null,
  };
};

export const measureDamagedRerankUsage = (body: unknown, { candidate }: UsageObserverContext): UsageMeasurement | null => {
  const { rerankTarget } = candidate.model;
  if (rerankTarget === undefined) throw new TypeError('Cannot measure a rerank call without its target');
  try {
    return measureRerankUsage(parseRerankUsage(rerankTarget.protocol, body));
  } catch {
    // The provider outcome already carries the parse failure for this invalid usage.
    return null;
  }
};

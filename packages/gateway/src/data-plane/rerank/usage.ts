import type { UsageQuantities } from '../../repo/types.ts';
import { computeUsage } from '../pipeline/compute-usage.ts';
import { parseDecimalString, type RerankSourceProtocol } from '@floway-dev/protocols/common';
import { parseRerankUsage } from '@floway-dev/protocols/rerank';

export const computeRerankUsage = (dialect: RerankSourceProtocol) => computeUsage('rerank', {
  result(value) {
    const { searchUnits, totalTokens } = value instanceof Uint8Array
      ? parseRerankUsage(dialect, JSON.parse(new TextDecoder().decode(value)))
      : value;
    const quantities: UsageQuantities = {};
    if (searchUnits !== undefined) quantities.rerank_searches = parseDecimalString(String(searchUnits));
    if (totalTokens !== undefined) quantities.input_tokens = parseDecimalString(String(totalTokens));
    return [{
      quantities,
      pricingFacts: totalTokens === undefined ? {} : { inputTokens: totalTokens },
      dumpTokenUsage: null,
    }];
  },
});

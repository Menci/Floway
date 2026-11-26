import { computeUsage } from '../pipeline/compute-usage.ts';
import { requestOnlyUsageMeasurement } from '../shared/telemetry/usage.ts';
import { isJsonObject, parseDecimalString, parseJSONWithRawNumbers } from '@floway-dev/protocols/common';
import { parseDecisionUsage } from '@floway-dev/protocols/decision';

export const computeDecisionUsage = computeUsage('decision', {
  result(value) {
    const body: unknown = value instanceof Uint8Array ? parseJSONWithRawNumbers(new TextDecoder().decode(value)) : value.raw;
    if (!isJsonObject(body)) throw new Error('Expected the parsed decision response object');
    const { inputTokens } = parseDecisionUsage(body);
    if (inputTokens === undefined) return [requestOnlyUsageMeasurement()];
    return [{
      quantities: { input_tokens: parseDecimalString(String(inputTokens)) },
      pricingFacts: { inputTokens },
      dumpTokenUsage: null,
    }];
  },
});

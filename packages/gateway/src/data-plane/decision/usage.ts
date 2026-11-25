import type { UsageMeasurement } from '../shared/telemetry/usage.ts';
import { isJsonObject, parseDecimalString } from '@floway-dev/protocols/common';
import { parseDecisionUsage, type CanonicalDecisionResponse } from '@floway-dev/protocols/decision';

export const measureDamagedDecisionUsage = (body: unknown): UsageMeasurement | null => {
  if (!isJsonObject(body)) return null;
  const { inputTokens } = parseDecisionUsage(body);
  if (inputTokens === undefined) return null;
  return {
    quantities: { input_tokens: parseDecimalString(String(inputTokens)) },
    pricingFacts: { inputTokens },
    dumpTokenUsage: null,
  };
};

export const measureDecisionUsage = ({ raw }: CanonicalDecisionResponse): UsageMeasurement | null => measureDamagedDecisionUsage(raw);

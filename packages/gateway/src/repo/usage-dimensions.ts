import type { UsageRecord } from './types.ts';
import { BILLING_DIMENSIONS, type BillingDimension } from '@floway-dev/protocols/common';

interface UsageDimensionWrite {
  dimension: BillingDimension;
  tokens: number;
  unitPrice: number | null;
}

export const usageDimensionRows = (record: UsageRecord): UsageDimensionWrite[] =>
  BILLING_DIMENSIONS.flatMap(dimension => {
    const tokens = record.tokens[dimension] ?? 0;
    return tokens > 0 ? [{ dimension, tokens, unitPrice: record.rates?.[dimension] ?? null }] : [];
  });

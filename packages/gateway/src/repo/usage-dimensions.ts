import type { UsageDimensionRecord, UsageRecord } from './types.ts';
import type { TokenUsage } from './types.ts';
import { BILLING_DIMENSIONS, type PriceVector } from '@floway-dev/protocols/common';

export const usageDimensionRows = (record: UsageRecord): UsageDimensionRecord[] => record.dimensions.filter(row => row.quantity > 0);

export const tokenUsageDimensions = (tokens: TokenUsage, rates: PriceVector | null): UsageDimensionRecord[] =>
  BILLING_DIMENSIONS.flatMap(dimension => {
    const quantity = tokens[dimension] ?? 0;
    return quantity > 0 ? [{ dimension, unit: 'tokens_1m' as const, quantity, unitPrice: rates?.[dimension] ?? null }] : [];
  });

export const tokenCountsFromUsage = (record: UsageRecord): TokenUsage => Object.fromEntries(
  record.dimensions.filter(row => row.unit === 'tokens_1m').map(row => [row.dimension, row.quantity]),
) as TokenUsage;

export const tokenRatesFromUsage = (record: UsageRecord): PriceVector | null => {
  const priced = record.dimensions.filter(row => row.unit === 'tokens_1m' && row.unitPrice !== null);
  return priced.length > 0 ? Object.fromEntries(priced.map(row => [row.dimension, row.unitPrice])) as PriceVector : null;
};

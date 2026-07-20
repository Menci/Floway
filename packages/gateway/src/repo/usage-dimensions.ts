import type { TokenUsage, UsageDimensionRecord, UsageQuantities, UsageRecord } from './types.ts';
import { BILLING_DIMENSIONS, type PriceUnits, type PriceVector } from '@floway-dev/protocols/common';

export const usageDimensionRows = (record: UsageRecord): UsageDimensionRecord[] => record.dimensions.filter(row => row.quantity > 0);

export const usageDimensions = (quantities: UsageQuantities, units: PriceUnits, rates: PriceVector | null): UsageDimensionRecord[] =>
  BILLING_DIMENSIONS.flatMap(dimension => {
    const quantity = quantities[dimension] ?? 0;
    if (quantity <= 0) return [];
    const unit = units[dimension];
    if (unit === undefined) throw new Error(`Usage dimension ${dimension} has no unit`);
    return [{ dimension, unit, quantity, unitPrice: rates?.[dimension] ?? null }];
  });

export const tokenUsageDimensions = (tokens: TokenUsage, rates: PriceVector | null): UsageDimensionRecord[] =>
  usageDimensions(tokens, Object.fromEntries(BILLING_DIMENSIONS.map(dimension => [dimension, 'tokens_1m'])) as PriceUnits, rates);

export const tokenCountsFromUsage = (record: UsageRecord): TokenUsage => Object.fromEntries(
  record.dimensions.filter(row => row.unit === 'tokens_1m').map(row => [row.dimension, row.quantity]),
) as TokenUsage;

export const tokenRatesFromUsage = (record: UsageRecord): PriceVector | null => {
  const priced = record.dimensions.filter(row => row.unit === 'tokens_1m' && row.unitPrice !== null);
  return priced.length > 0 ? Object.fromEntries(priced.map(row => [row.dimension, row.unitPrice])) as PriceVector : null;
};

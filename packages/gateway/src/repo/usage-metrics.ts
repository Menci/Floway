import type { TokenUsage, UsageMetricRecord, UsageQuantities, UsageRecord } from './types.ts';
import { BILLING_METRICS, canonicalDecimalString, decimalStringToNumber, parseNonNegativeDecimalString, type BillingMetric, type PriceVector } from '@floway-dev/protocols/common';

const TOKEN_METRIC_BY_USAGE_KEY = {
  input: 'input_tokens',
  input_cache_read: 'input_cache_read_tokens',
  input_cache_write: 'input_cache_write_tokens',
  input_cache_write_1h: 'input_cache_write_1h_tokens',
  input_image: 'input_image_tokens',
  output: 'output_tokens',
  output_image: 'output_image_tokens',
} as const satisfies Record<Exclude<keyof TokenUsage, 'tier'>, BillingMetric>;

export const usageMetricRows = (record: UsageRecord): UsageMetricRecord[] => {
  const seen = new Set<BillingMetric>();
  for (const row of record.metrics) {
    if (seen.has(row.metric)) throw new Error(`Duplicate usage metric: ${row.metric}`);
    seen.add(row.metric);
    const quantity = parseNonNegativeDecimalString(row.quantity, `usage metric ${row.metric} quantity`);
    if (quantity !== row.quantity) throw new TypeError(`usage metric ${row.metric} quantity must be canonical: ${JSON.stringify(row.quantity)}`);
    if (row.unitPrice !== null) {
      const unitPrice = parseNonNegativeDecimalString(row.unitPrice, `usage metric ${row.metric} unit price`);
      if (unitPrice !== row.unitPrice) throw new TypeError(`usage metric ${row.metric} unit price must be canonical: ${JSON.stringify(row.unitPrice)}`);
    }
  }
  return record.metrics;
};

export const usageMetrics = (quantities: UsageQuantities, rates: PriceVector | null): UsageMetricRecord[] =>
  BILLING_METRICS.flatMap(metric => {
    const quantity = quantities[metric];
    if (quantity === undefined) return [];
    return [{ metric, quantity, unitPrice: rates?.[metric] ?? null }];
  });

export const tokenUsageQuantities = (tokens: TokenUsage): UsageQuantities => {
  const quantities: UsageQuantities = {};
  for (const [key, metric] of Object.entries(TOKEN_METRIC_BY_USAGE_KEY) as [keyof typeof TOKEN_METRIC_BY_USAGE_KEY, BillingMetric][]) {
    const quantity = tokens[key];
    if (quantity !== undefined) quantities[metric] = canonicalDecimalString(String(quantity), `token usage ${key}`);
  }
  return quantities;
};

export const tokenUsageMetrics = (tokens: TokenUsage, rates: PriceVector | null): UsageMetricRecord[] =>
  usageMetrics(tokenUsageQuantities(tokens), rates);

export const tokenCountsFromUsage = (record: UsageRecord): TokenUsage => Object.fromEntries(
  Object.entries(TOKEN_METRIC_BY_USAGE_KEY).flatMap(([key, metric]) => {
    const row = record.metrics.find(candidate => candidate.metric === metric);
    return row ? [[key, decimalStringToNumber(row.quantity)]] : [];
  }),
) as TokenUsage;

export const tokenRatesFromUsage = (record: UsageRecord): PriceVector | null => {
  const priced = record.metrics.filter(row => row.metric.endsWith('_tokens') && row.unitPrice !== null);
  return priced.length > 0 ? Object.fromEntries(priced.map(row => [row.metric, row.unitPrice])) as PriceVector : null;
};

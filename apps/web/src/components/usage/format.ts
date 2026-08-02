import { metricConfig } from './metrics';
import type { TokenSummary, UsageMetric } from './types';
import { decimalStringToPlottableNumber, formatDecimalQuantity, formatUsd, sumDecimalStrings, usdFractionDigits } from '../../lib/decimal-display';
import { formatCompactCount, formatCount } from '../../lib/format-number';
import { NO_READING } from '../../lib/no-reading';
import type { DecimalString } from '@floway-dev/protocols/common';

// A compact spelling is three significant figures by construction, so unlike
// the exact labels it has no precision to keep.
export const formatCompactDecimalCount = (value: DecimalString, locale: string): string =>
  formatCompactCount(decimalStringToPlottableNumber(value), locale);

export const formatRatePercent = (numerator: DecimalString, denominator: DecimalString): string => {
  const total = decimalStringToPlottableNumber(denominator);
  if (total <= 0) return NO_READING;
  return `${((decimalStringToPlottableNumber(numerator) / total) * 100).toFixed(1)}%`;
};

export const formatSummaryMetric = (
  summary: TokenSummary,
  metric: UsageMetric,
  locale: string,
): string => {
  switch (metric) {
  case 'requests':
    return formatCount(summary.requests, locale);
  case 'cost':
    return formatUsd(summary.cost);
  case 'total':
    return formatDecimalQuantity(summary.total);
  case 'input':
    return formatDecimalQuantity(summary.prompt);
  case 'output':
    return formatDecimalQuantity(summary.output);
  case 'prefill':
    return formatDecimalQuantity(summary.prefill);
  case 'cached':
    return formatDecimalQuantity(summary.cacheRead);
  case 'cacheCreation':
    return formatDecimalQuantity(summary.cacheCreation);
  case 'cachedRate':
    return formatRatePercent(summary.cacheRead, summary.prompt);
  case 'cacheHitRate':
    return formatRatePercent(summary.cacheRead, sumDecimalStrings(summary.cacheRead, summary.cacheCreation));
  }
};

export const formatMetricValue = (value: number, metric: UsageMetric, locale: string): string => {
  const kind = metricConfig[metric].kind;
  if (kind === 'percent') return `${value.toFixed(0)}%`;
  if (kind === 'cost') return formatPlottedCost(value);
  if (kind === 'count') return formatCount(value, locale);
  return formatCompactCount(value, locale);
};

const formatPlottedCost = (value: number): string => {
  if (value <= 0) return '$0';
  return `$${value.toFixed(usdFractionDigits(boundary => value >= Number(boundary)))}`;
};

export const formatProvider = (provider: string): string => {
  if (provider === 'microsoft-web-iq') return 'Microsoft Web IQ';
  if (provider === 'tavily') return 'Tavily';
  if (provider === 'jina') return 'Jina';
  return provider;
};

import { metricConfig, summaryFieldForMetric } from './metrics';
import type { TokenSummary, UsageMetric } from './types';
import { decimalStringToPlottableNumber, formatDecimalQuantity, formatUsd, usdFractionDigits } from '../../lib/decimal-display';
import { formatCompactCount, formatCount } from '../../lib/format-number';
import { NO_READING } from '../../lib/no-reading';
import type { DecimalString } from '@floway-dev/protocols/common';

// A compact spelling is three significant figures by construction, so unlike
// the exact labels it has no precision to keep.
export const formatCompactDecimalCount = (value: DecimalString, locale: string): string =>
  formatCompactCount(decimalStringToPlottableNumber(value), locale);

export const formatRatePercent = (rate: number | null): string =>
  rate === null ? NO_READING : `${rate.toFixed(1)}%`;

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
  case 'cachedRate':
  case 'cacheHitRate':
    return formatRatePercent(summary[metric]);
  default:
    return formatDecimalQuantity(summary[summaryFieldForMetric[metric]]);
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

import { metricConfig, summaryFieldForMetric } from './metrics';
import type { TokenSummary, UsageMetric } from './types';
import { decimalStringToPlottableNumber, formatDecimalQuantity, formatUsd, usdFractionDigits } from '../../lib/decimal-display';
import { formatCompactCount, formatCount } from '../../lib/format-number';
import { NO_READING } from '../../lib/no-reading';
import type { DecimalString } from '@floway-dev/protocols/browser';

// A compact spelling is three significant figures by construction, so unlike
// the exact labels it has no precision to keep.
export const formatCompactDecimalCount = (value: DecimalString): string =>
  formatCompactCount(decimalStringToPlottableNumber(value));

export const formatRatePercent = (rate: number | null): string =>
  rate === null ? NO_READING : `${rate.toFixed(1)}%`;

// A tile shows a token total the way the axis and callout spell it; the exact
// figure, which runs to a dozen digits and wrapped mid-number, moves to the
// tile's tooltip. `exact` is null where the shown text already is exact.
export const formatSummaryMetric = (
  summary: TokenSummary,
  metric: UsageMetric,
  locale: string,
): { text: string; exact: string | null } => {
  switch (metric) {
  case 'requests':
    return { text: formatCount(summary.requests, locale), exact: null };
  case 'cost':
    return { text: formatUsd(summary.cost), exact: null };
  case 'cachedRate':
    return { text: formatRatePercent(summary.cachedRate), exact: null };
  default: {
    const value = summary[summaryFieldForMetric[metric]];
    const text = formatCompactDecimalCount(value);
    const exact = formatDecimalQuantity(value);
    return { text, exact: text === exact ? null : exact };
  }
  }
};

export const formatMetricValue = (value: number, metric: UsageMetric, locale: string): string => {
  const kind = metricConfig[metric].kind;
  if (kind === 'percent') return `${value.toFixed(0)}%`;
  if (kind === 'cost') return formatPlottedCost(value);
  if (kind === 'count') return formatCount(value, locale);
  return formatCompactCount(value);
};

const formatPlottedCost = (value: number): string => {
  if (value <= 0) return '$0';
  return `$${value.toFixed(usdFractionDigits(boundary => value >= Number(boundary)))}`;
};

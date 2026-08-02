import type { ChartProps } from '@fluentui/react-charts';

import type { DisplayUsageRecord, SearchChartModel, SearchUsageResponse, TokenChartModel, TokenCounters, TokenSummary, UsageMetric, UsageRange, UsageResponse } from './types';
import type { ControlPlaneModel, BillingMetric } from '../../api/types';
import { decimalStringToPlottableNumber, formatDecimalQuantity, formatUsd, sumDecimalStrings, usdFractionDigits } from '../../lib/decimal-display';
import { formatCompactCount, formatCount } from '../../lib/format-number';
import type { ChartBucket } from '../charts/dashboard-time';
import {
  dashboardBucketFrames,
  dashboardBucketKeyForUtcHour,
} from '../charts/dashboard-time';
import type { ChartSeries } from '../charts/series-legends';
import { withUniqueSeriesLegends } from '../charts/series-legends';
import { areaSeries, lineSeries } from '../charts/series-plot';
import type { DecimalString } from '@floway-dev/protocols/common';

export const metricConfig: Record<
  UsageMetric,
  { labelKey: string; kind: 'count' | 'cost' | 'tokens' | 'percent' }
> = {
  requests: { labelKey: 'dashboard.usage.metrics.requests', kind: 'count' },
  cost: { labelKey: 'dashboard.usage.metrics.cost', kind: 'cost' },
  total: { labelKey: 'dashboard.usage.metrics.total', kind: 'tokens' },
  input: { labelKey: 'dashboard.usage.metrics.input', kind: 'tokens' },
  output: { labelKey: 'dashboard.usage.metrics.output', kind: 'tokens' },
  prefill: { labelKey: 'dashboard.usage.metrics.prefill', kind: 'tokens' },
  cached: { labelKey: 'dashboard.usage.metrics.cached', kind: 'tokens' },
  cachedRate: {
    labelKey: 'dashboard.usage.metrics.cachedRate',
    kind: 'percent',
  },
  cacheCreation: {
    labelKey: 'dashboard.usage.metrics.cacheCreation',
    kind: 'tokens',
  },
  cacheHitRate: {
    labelKey: 'dashboard.usage.metrics.cacheHitRate',
    kind: 'percent',
  },
};

export const summaryMetrics: UsageMetric[][] = [
  ['requests', 'cost'],
  ['total', 'output'],
  ['input', 'prefill'],
  ['cached', 'cachedRate'],
  ['cacheCreation', 'cacheHitRate'],
];

const shortMonthDay = (date: Date, locale: string): string =>
  date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });

// A bucket covers an hour span, so the label names the span rather than its
// start. `formatRange` on an hour-only format is what makes that reading
// locale-owned: `2 – 3 PM` under `en-US` and `14–15` under `zh-CN`, where a
// hand-built `14:00 - 15:00` would impose a 24-hour clock on both.
//
// The end is placed on the start's own calendar day, wrapping past midnight,
// because `formatRange` widens to two full datetimes the moment its endpoints
// fall on different days -- a bucket crossing midnight would read
// `8/2/2026, 11 PM – 8/3/2026, 12 AM` in a label that has room for two clock
// readings. Reversed endpoints are fine: `formatRange` still prints them in
// the order given.
const bucketHourRange = (date: Date, spanHours: number, locale: string): string => {
  const end = new Date(date);
  end.setHours((date.getHours() + spanHours) % 24, 0, 0, 0);
  return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).formatRange(date, end);
};

const bucketLabel = (date: Date, range: UsageRange, locale: string): string => {
  if (range === '30d') return shortMonthDay(date, locale);
  const time = bucketHourRange(date, range === '7d' ? 4 : 1, locale);
  return range === '7d' ? `${shortMonthDay(date, locale)} ${time}` : time;
};

export const dashboardBuckets = (
  range: UsageRange,
  nowMs: number,
  locale: string,
): ChartBucket[] => {
  return dashboardBucketFrames(range, nowMs)
    .map(({ date, key }) => ({ key, label: bucketLabel(date, range, locale), date }));
};

export const buildTokenChart = ({
  records,
  metadata,
  models,
  groupKey,
  hiddenOwn,
  hiddenOther,
  redactKeys,
  metric,
  range,
  buckets,
}: {
  records: DisplayUsageRecord[];
  metadata: UsageResponse['keys'];
  models: ControlPlaneModel[];
  groupKey: 'keyId' | 'model';
  hiddenOwn: Set<string>;
  hiddenOther: Set<string>;
  redactKeys: boolean;
  metric: UsageMetric;
  range: UsageRange;
  buckets: ChartBucket[];
}): TokenChartModel => {
  const otherKey = groupKey === 'keyId' ? 'model' : 'keyId';
  const valueRecords = records.filter(record => !hiddenOther.has(record[otherKey]));
  const { values, details } = aggregateTokenRecords(valueRecords, groupKey, metric, range, buckets);
  const presentGroups = new Set(records.map(record => record[groupKey]));
  const entries =
    groupKey === 'keyId'
      ? keyChartEntries([...presentGroups], metadata, records, redactKeys)
      : modelChartEntries([...presentGroups], models);

  const visibleEntries = entries.filter(entry => !hiddenOwn.has(entry.id));
  const isPercent = metricConfig[metric].kind === 'percent';
  const series = visibleEntries
    .map(entry => ({
      entry,
      data: buckets.map(bucket => {
        const bucketValues = values.get(bucket.key)!;
        return bucketValues.has(entry.id) ? bucketValues.get(entry.id)! : (isPercent ? null : 0);
      }),
    }))
    .filter(({ data, entry }) =>
      isPercent
        ? data.some(value => value !== null)
        : data.some(value => value !== null && value > 0) || hasRequests(details, entry.id));

  return {
    entries,
    buckets,
    details,
    kind: 'token',
    range,
    plot: isPercent
      ? { form: 'line', data: lineChartData(buckets, series) }
      : { form: 'area', data: areaChartData(buckets, series) },
  };
};

type PlottedSeries = Array<{ entry: ChartSeries; data: Array<number | null> }>;

// A null is a bucket the metric was not defined in, which is not the reading
// zero: the point is left out so the curve bridges the gap instead of dipping
// through it. `markerSize` is per point rather than per chart because the area
// form states its point radius once, in `pointOptions`.
const seriesPoints = (
  buckets: ChartBucket[],
  values: Array<number | null>,
  marker?: { markerSize: number },
) => values.flatMap((value, index) => value === null ? [] : [{
  ...marker,
  x: buckets[index]!.date,
  y: value,
  xAxisCalloutData: buckets[index]!.label,
  yAxisCalloutData: String(value),
}]);

const lineChartData = (buckets: ChartBucket[], series: PlottedSeries): ChartProps => ({
  chartTitle: '',
  lineChartData: series.map(({ entry, data }) => lineSeries(entry, seriesPoints(buckets, data, { markerSize: 4 }))),
});

const areaChartData = (buckets: ChartBucket[], series: PlottedSeries): ChartProps => ({
  chartTitle: '',
  pointOptions: { r: 2, strokeWidth: 1.25 },
  lineChartData: series.map(({ entry, data }) => areaSeries(entry, seriesPoints(buckets, data))),
});

export const buildSearchChart = ({
  search,
  hiddenKeys,
  redactKeys,
  range,
  buckets,
}: {
  search: SearchUsageResponse;
  hiddenKeys: Set<string>;
  redactKeys: boolean;
  range: UsageRange;
  buckets: ChartBucket[];
}): SearchChartModel => {
  const groups = new Map<string, Map<string, number>>();
  const presentGroups = new Set<string>();
  const providers = new Set<string>();
  const bucketKeys = new Set(buckets.map(bucket => bucket.key));
  const meta = new Map<string, { name?: string; createdAt?: string }>();
  for (const key of search.keys) meta.set(key.id, { name: key.name, createdAt: key.createdAt });

  // Whichever provider recorded a search, the record is real usage and belongs
  // on the chart. Gating on the currently configured provider would erase the
  // history of every provider the operator has since switched away from — and
  // hide the panel entirely once search is turned off, even though the window
  // still holds the traffic that happened while it was on.
  for (const record of search.records) {
    const bucket = dashboardBucketKeyForUtcHour(range, record.hour);
    if (!bucketKeys.has(bucket)) continue;
    providers.add(record.provider);
    presentGroups.add(record.keyId);
    meta.set(record.keyId, {
      name: record.keyName ?? meta.get(record.keyId)?.name,
      createdAt: record.keyCreatedAt ?? meta.get(record.keyId)?.createdAt,
    });
    const bucketValues = groups.get(record.keyId) ?? new Map<string, number>();
    bucketValues.set(bucket, (bucketValues.get(bucket) ?? 0) + record.requests);
    groups.set(record.keyId, bucketValues);
  }

  const entries = keyChartEntries(
    [...presentGroups],
    search.keys,
    search.records.map(record => ({
      keyId: record.keyId,
      keyName: record.keyName,
      keyCreatedAt: record.keyCreatedAt,
      model: '',
      hour: record.hour,
      requests: record.requests,
      metrics: {},
      cost: null,
    })),
    redactKeys,
  );
  const visibleEntries = entries.filter(entry => !hiddenKeys.has(entry.id));

  return {
    entries,
    buckets,
    kind: 'search',
    providers: [...providers].sort(),
    range,
    plot: {
      form: 'area',
      data: areaChartData(buckets, visibleEntries.map(entry => ({
        entry,
        data: buckets.map(bucket => groups.get(entry.id)?.get(bucket.key) ?? 0),
      }))),
    },
  };
};

const aggregateTokenRecords = (
  records: DisplayUsageRecord[],
  groupKey: 'keyId' | 'model',
  metric: UsageMetric,
  range: UsageRange,
  buckets: ChartBucket[],
) => {
  const values = new Map<string, Map<string, number | null>>();
  const details = new Map<string, Map<string, TokenCounters>>();
  for (const bucket of buckets) {
    values.set(bucket.key, new Map());
    details.set(bucket.key, new Map());
  }

  for (const record of records) {
    const bucket = dashboardBucketKeyForUtcHour(range, record.hour);
    if (!values.has(bucket)) continue;

    const group = record[groupKey];
    const bucketDetails = details.get(bucket)!;
    const detail = bucketDetails.get(group) ?? emptyCounters();
    addRecordToCounters(detail, record);
    bucketDetails.set(group, detail);

    if (metricConfig[metric].kind !== 'percent') {
      const bucketValues = values.get(bucket);
      if (bucketValues === undefined) throw new RangeError(`Bucket is missing from the chart series: ${bucket}`);
      const value = plottableMetricValue(record, metric);
      if (value !== null) {
        bucketValues.set(group, (bucketValues.get(group) ?? 0) + value);
      } else if (!bucketValues.has(group)) {
        bucketValues.set(group, null);
      }
    }
  }

  if (metricConfig[metric].kind === 'percent') {
    for (const [bucket, bucketDetails] of details) {
      const bucketValues = values.get(bucket)!;
      for (const [group, detail] of bucketDetails) {
        bucketValues.set(group, tokenCountersMetricValue(detail, metric));
      }
    }
  }

  return { values, details };
};

const keyChartEntries = (
  presentKeyIds: string[],
  metadata: UsageResponse['keys'],
  records: DisplayUsageRecord[],
  redactKeys: boolean,
): ChartSeries[] => {
  const meta = new Map<string, { name?: string; createdAt?: string }>();
  for (const key of metadata) meta.set(key.id, { name: key.name, createdAt: key.createdAt });
  for (const record of records) {
    const prev = meta.get(record.keyId);
    meta.set(record.keyId, {
      name: record.keyName ?? prev?.name,
      createdAt: record.keyCreatedAt ?? prev?.createdAt,
    });
  }

  const orderedIds = metadata.map(key => key.id);
  const slotById = new Map<string, number>(orderedIds.map((id, index) => [id, index]));
  [...new Set(presentKeyIds)]
    .filter(id => !slotById.has(id))
    .sort()
    .forEach((id, index) => slotById.set(id, orderedIds.length + index));

  return withUniqueSeriesLegends([...new Set(presentKeyIds)]
    .map(id => {
      const colorSlot = slotById.get(id)!;
      return {
        id,
        label: redactKeys ? `${id.startsWith('user-') ? 'user' : 'key'}-${colorSlot + 1}` : meta.get(id)?.name ?? id.slice(0, 8),
        colorSlot,
      };
    })
    .sort((a, b) => a.colorSlot - b.colorSlot));
};

const modelChartEntries = (
  presentModelIds: string[],
  models: ControlPlaneModel[],
): ChartSeries[] => {
  const present = new Set(presentModelIds);
  return withUniqueSeriesLegends([...new Set([...models.map(model => model.id), ...presentModelIds])]
    .sort()
    .map((id, colorSlot) => ({ id, label: id, colorSlot }))
    .filter(entry => present.has(entry.id)));
};

export const summarizeUsage = (records: DisplayUsageRecord[]): TokenSummary => {
  const counters = emptyCounters();
  for (const record of records) addRecordToCounters(counters, record);
  return summarizeCounters(counters);
};

// The single derivation from disjoint counters to displayed figures. The
// summary tiles and the chart callout both read it, so a bucket row and the
// page total can never disagree about what "total" or "prefill" means.
export const summarizeCounters = (counters: TokenCounters): TokenSummary => {
  return {
    requests: counters.requests,
    cost: counters.cost,
    cacheRead: counters.cacheRead,
    cacheCreation: counters.cacheCreation,
    prompt: sumDecimalStrings(counters.input, counters.cacheRead, counters.cacheCreation, counters.inputImage),
    output: sumDecimalStrings(counters.output, counters.outputImage),
    total: sumDecimalStrings(counters.input, counters.output, counters.cacheRead, counters.cacheCreation, counters.inputImage, counters.outputImage),
    prefill: sumDecimalStrings(counters.input, counters.cacheCreation, counters.inputImage),
  };
};

const addRecordToCounters = (counters: TokenCounters, record: DisplayUsageRecord) => {
  counters.requests += record.requests;
  if (record.cost !== null) counters.cost = sumDecimalStrings(counters.cost ?? '0', record.cost);
  counters.input = sumDecimalStrings(counters.input, dim(record, 'input_tokens'));
  counters.output = sumDecimalStrings(counters.output, dim(record, 'output_tokens'));
  counters.cacheRead = sumDecimalStrings(counters.cacheRead, dim(record, 'input_cache_read_tokens'));
  counters.cacheCreation = sumDecimalStrings(counters.cacheCreation, dim(record, 'input_cache_write_tokens'), dim(record, 'input_cache_write_1h_tokens'));
  counters.inputImage = sumDecimalStrings(counters.inputImage, dim(record, 'input_image_tokens'));
  counters.outputImage = sumDecimalStrings(counters.outputImage, dim(record, 'output_image_tokens'));
};

const emptyCounters = (): TokenCounters => {
  return {
    requests: 0,
    cost: null,
    input: '0',
    output: '0',
    cacheRead: '0',
    cacheCreation: '0',
    inputImage: '0',
    outputImage: '0',
  };
};

// Aggregate token counts routinely exceed the safe integer range, and cost is
// billed to sub-cent precision, so both stay decimal strings until they reach a
// chart axis or a formatted label.
const dim = (record: DisplayUsageRecord, key: BillingMetric): DecimalString => {
  return record.metrics[key] ?? '0';
};

const metricValue = (record: DisplayUsageRecord, metric: UsageMetric): DecimalString | number | null => {
  switch (metric) {
  case 'requests':
    return record.requests;
  case 'cost':
    return record.cost;
  case 'total':
    return sumDecimalStrings(
      dim(record, 'input_tokens'),
      dim(record, 'output_tokens'),
      dim(record, 'input_cache_read_tokens'),
      dim(record, 'input_cache_write_tokens'),
      dim(record, 'input_cache_write_1h_tokens'),
      dim(record, 'input_image_tokens'),
      dim(record, 'output_image_tokens'),
    );
  case 'input':
    return sumDecimalStrings(
      dim(record, 'input_tokens'),
      dim(record, 'input_cache_read_tokens'),
      dim(record, 'input_cache_write_tokens'),
      dim(record, 'input_cache_write_1h_tokens'),
      dim(record, 'input_image_tokens'),
    );
  case 'output':
    return sumDecimalStrings(dim(record, 'output_tokens'), dim(record, 'output_image_tokens'));
  case 'prefill':
    return sumDecimalStrings(dim(record, 'input_tokens'), dim(record, 'input_cache_write_tokens'), dim(record, 'input_cache_write_1h_tokens'), dim(record, 'input_image_tokens'));
  case 'cached':
    return dim(record, 'input_cache_read_tokens');
  case 'cacheCreation':
    return sumDecimalStrings(dim(record, 'input_cache_write_tokens'), dim(record, 'input_cache_write_1h_tokens'));
  case 'cachedRate':
  case 'cacheHitRate':
    return null;
  }
};

// Plot values cross into floating point exactly here, at the axis boundary.
const plottableMetricValue = (record: DisplayUsageRecord, metric: UsageMetric): number | null => {
  const value = metricValue(record, metric);
  if (value === null) return null;
  return typeof value === 'number' ? value : decimalStringToPlottableNumber(value);
};

// Ratios are percentages of one aggregate over another, so both sides convert
// to plottable numbers first; the division itself has no precision to protect.
const tokenCountersMetricValue = (counters: TokenCounters, metric: UsageMetric): number | null => {
  const ratio = (numerator: DecimalString, denominator: DecimalString): number | null => {
    const bottom = decimalStringToPlottableNumber(denominator);
    return bottom > 0 ? (decimalStringToPlottableNumber(numerator) / bottom) * 100 : null;
  };
  if (metric === 'cacheHitRate') return ratio(counters.cacheRead, sumDecimalStrings(counters.cacheRead, counters.cacheCreation));
  if (metric === 'cachedRate') return ratio(counters.cacheRead, summarizeCounters(counters).prompt);
  return null;
};

const hasRequests = (details: Map<string, Map<string, TokenCounters>>, id: string): boolean => {
  for (const bucket of details.values()) {
    if ((bucket.get(id)?.requests ?? 0) > 0) return true;
  }
  return false;
};

export const bucketKeyForCallout = (
  value: Date | number | string,
  buckets: ChartBucket[],
): string | null => {
  if (value instanceof Date) {
    return (
      buckets.find(bucket => bucket.date.getTime() === value.getTime())?.key ??
      null
    );
  }
  return null;
};

// The exact labels stay in decimal-string arithmetic right up to the string, so
// a count past the safe integer range is grouped digit-wise rather than rounded.
// A compact spelling has no such exactness to keep -- `1.2M` is three
// significant figures by construction -- so that one crosses into floating point
// here.
export const formatCompactDecimalCount = (value: DecimalString, locale: string): string =>
  formatCompactCount(decimalStringToPlottableNumber(value), locale);

export const formatRatePercent = (numerator: DecimalString, denominator: DecimalString): string => {
  const total = decimalStringToPlottableNumber(denominator);
  if (total <= 0) return '-';
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

// Axis-side formatter: the value here is a plotted point, so it has already
// crossed into floating point and there is no exact decimal left to preserve.
// Summary tiles use formatUsd and formatDecimalQuantity on the decimal values.
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

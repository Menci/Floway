import { curveMonotoneX } from 'd3-shape';

import type { ChartEntry, DisplayUsageRecord, SearchUsageResponse, TokenDetail, TokenSummary, UsageBucket, UsageChartModel, UsageMetric, UsageRange, UsageResponse } from './types';
import type { ControlPlaneModel, BillingMetric } from '../../api/types';
import { decimalStringToPlottableNumber, formatDecimalQuantity, formatUsd, sumDecimalStrings } from '../../utils/decimal-display';
import { colorForSlot } from '../charts/palette';
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

const pad2 = (n: number): string => String(n).padStart(2, '0');

const localHourKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}`;

const localDateKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const local4hBucketStart = (date: Date): Date => {
  const aligned = new Date(date);
  aligned.setMinutes(0, 0, 0);
  aligned.setHours(aligned.getHours() - (aligned.getHours() % 4));
  return aligned;
};

const toUtcHourParam = (date: Date): string => date.toISOString().slice(0, 13);

const shortMonthDay = (date: Date, locale: string): string =>
  date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });

const bucketLabel = (date: Date, range: UsageRange, locale: string): string => {
  if (range === '30d') return shortMonthDay(date, locale);

  const start = date.getHours();
  const end = range === '7d' ? (start + 4) % 24 : (start + 1) % 24;
  const time = `${pad2(start)}:00 - ${pad2(end)}:00`;
  return range === '7d' ? `${shortMonthDay(date, locale)} ${time}` : time;
};

export const dashboardBuckets = (
  range: UsageRange,
  nowMs: number,
  locale: string,
): UsageBucket[] => {
  if (range === 'today') {
    const current = new Date(nowMs);
    current.setMinutes(0, 0, 0);
    return Array.from({ length: 24 }, (_, index) => {
      const date = new Date(current.getTime() - (23 - index) * 3_600_000);
      return { key: localHourKey(date), label: bucketLabel(date, range, locale), date };
    });
  }

  if (range === '7d') {
    const start = local4hBucketStart(new Date(nowMs));
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start.getTime() - (41 - index) * 4 * 3_600_000);
      return { key: localHourKey(date), label: bucketLabel(date, range, locale), date };
    });
  }

  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(nowMs);
    date.setDate(date.getDate() - (29 - index));
    date.setHours(0, 0, 0, 0);
    return { key: localDateKey(date), label: bucketLabel(date, range, locale), date };
  });
};

export const dashboardRangeQuery = (
  range: UsageRange,
  nowMs: number,
): { start: string; end: string; bucket: 'hour' | '4h' | 'day' } => {
  const now = new Date(nowMs);
  const start = new Date(now);
  if (range === 'today') {
    start.setTime(now.getTime() - 23 * 3_600_000);
    start.setMinutes(0, 0, 0);
  } else if (range === '7d') {
    start.setTime(local4hBucketStart(now).getTime() - 41 * 4 * 3_600_000);
  } else {
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
  }
  return {
    start: toUtcHourParam(start),
    end: toUtcHourParam(new Date(now.getTime() + 3_600_000)),
    bucket: range === 'today' ? 'hour' : range === '7d' ? '4h' : 'day',
  };
};

const parseUtcHour = (hour: string): Date => new Date(`${hour}:00:00Z`);

const bucketKeyForUtcHour = (range: UsageRange, hour: string): string => {
  const date = parseUtcHour(hour);
  if (range === 'today') return localHourKey(date);
  if (range === '7d') return localHourKey(local4hBucketStart(date));
  return localDateKey(date);
};

export function buildTokenChart({
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
  buckets: UsageBucket[];
}): UsageChartModel {
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
      data: buckets.map(bucket => values.get(bucket.key)?.get(entry.id) ?? (isPercent ? null : 0)),
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
    stacked: !isPercent,
    data: {
      chartTitle: '',
      lineChartData: series.map(({ entry, data }) => ({
        legend: entry.label,
        color: colorForSlot(entry.colorSlot),
        lineOptions: { strokeWidth: 2, curve: curveMonotoneX },
        data: data.flatMap((value, index) => value === null ? [] : [{
          x: buckets[index]!.date,
          y: value,
          xAxisCalloutData: buckets[index]!.label,
          yAxisCalloutData: String(value),
        }]),
      })),
    },
  };
}

export function buildSearchChart({
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
  buckets: UsageBucket[];
}): UsageChartModel {
  const groups = new Map<string, Map<string, number>>();
  const presentGroups = new Set<string>();
  const meta = new Map<string, { name?: string; createdAt?: string }>();
  for (const key of search.keys) meta.set(key.id, { name: key.name, createdAt: key.createdAt });

  for (const record of search.records) {
    if (record.provider !== search.activeProvider) continue;
    presentGroups.add(record.keyId);
    meta.set(record.keyId, {
      name: record.keyName ?? meta.get(record.keyId)?.name,
      createdAt: record.keyCreatedAt ?? meta.get(record.keyId)?.createdAt,
    });
    const bucket = bucketKeyForUtcHour(range, record.hour);
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
  const details = new Map<string, Map<string, TokenDetail>>();
  for (const bucket of buckets) details.set(bucket.key, new Map());

  return {
    entries,
    buckets,
    details,
    kind: 'search',
    range,
    stacked: true,
    data: {
      chartTitle: '',
      lineChartData: visibleEntries.map(entry => ({
        legend: entry.label,
        color: colorForSlot(entry.colorSlot),
        lineOptions: { strokeWidth: 2, curve: curveMonotoneX },
        data: buckets.map(bucket => ({
          x: bucket.date,
          y: groups.get(entry.id)?.get(bucket.key) ?? 0,
          xAxisCalloutData: bucket.label,
        })),
      })),
    },
  };
}

function aggregateTokenRecords(
  records: DisplayUsageRecord[],
  groupKey: 'keyId' | 'model',
  metric: UsageMetric,
  range: UsageRange,
  buckets: UsageBucket[],
) {
  const values = new Map<string, Map<string, number | null>>();
  const details = new Map<string, Map<string, TokenDetail>>();
  for (const bucket of buckets) {
    values.set(bucket.key, new Map());
    details.set(bucket.key, new Map());
  }

  for (const record of records) {
    const bucket = bucketKeyForUtcHour(range, record.hour);
    if (!values.has(bucket)) continue;

    const group = record[groupKey];
    const bucketDetails = details.get(bucket)!;
    const detail = bucketDetails.get(group) ?? emptyDetail();
    addRecordToDetail(detail, record);
    bucketDetails.set(group, detail);

    if (metricConfig[metric].kind !== 'percent') {
      const bucketValues = values.get(bucket);
      if (bucketValues === undefined) throw new RangeError(`Bucket is missing from the chart series: ${bucket}`);
      bucketValues.set(group, (bucketValues.get(group) ?? 0) + plottableMetricValue(record, metric));
    }
  }

  if (metricConfig[metric].kind === 'percent') {
    for (const [bucket, bucketDetails] of details) {
      const bucketValues = values.get(bucket)!;
      for (const [group, detail] of bucketDetails) {
        bucketValues.set(group, tokenDetailMetricValue(detail, metric));
      }
    }
  }

  return { values, details };
}

function keyChartEntries(
  presentKeyIds: string[],
  metadata: UsageResponse['keys'],
  records: DisplayUsageRecord[],
  redactKeys: boolean,
): ChartEntry[] {
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

  return [...new Set(presentKeyIds)]
    .map(id => ({
      id,
      label: redactKeys ? id.slice(0, 6) : meta.get(id)?.name ?? id.slice(0, 8),
      colorSlot: slotById.get(id)!,
    }))
    .sort((a, b) => a.colorSlot - b.colorSlot);
}

function modelChartEntries(
  presentModelIds: string[],
  models: ControlPlaneModel[],
): ChartEntry[] {
  const present = new Set(presentModelIds);
  return [...new Set([...models.map(model => model.id), ...presentModelIds])]
    .sort()
    .map((id, colorSlot) => ({ id, label: id, colorSlot }))
    .filter(entry => present.has(entry.id));
}

export function summarizeUsage(records: DisplayUsageRecord[]): TokenSummary {
  const summary = emptyDetail();
  for (const record of records) addRecordToDetail(summary, record);
  return {
    requests: summary.requests,
    cost: summary.cost,
    cacheRead: summary.cacheRead,
    cacheCreation: summary.cacheCreation,
    input: sumDecimalStrings(summary.input, summary.cacheRead, summary.cacheCreation, summary.inputImage),
    output: sumDecimalStrings(summary.output, summary.outputImage),
    total: sumDecimalStrings(summary.input, summary.output, summary.cacheRead, summary.cacheCreation, summary.inputImage, summary.outputImage),
    prefill: sumDecimalStrings(summary.input, summary.cacheCreation, summary.inputImage),
  };
}

function addRecordToDetail(detail: TokenDetail, record: DisplayUsageRecord) {
  detail.requests += record.requests;
  if (record.cost !== null) detail.cost = sumDecimalStrings(detail.cost ?? '0', record.cost);
  detail.input = sumDecimalStrings(detail.input, dim(record, 'input_tokens'));
  detail.output = sumDecimalStrings(detail.output, dim(record, 'output_tokens'));
  detail.cacheRead = sumDecimalStrings(detail.cacheRead, dim(record, 'input_cache_read_tokens'));
  detail.cacheCreation = sumDecimalStrings(detail.cacheCreation, dim(record, 'input_cache_write_tokens'), dim(record, 'input_cache_write_1h_tokens'));
  detail.inputImage = sumDecimalStrings(detail.inputImage, dim(record, 'input_image_tokens'));
  detail.outputImage = sumDecimalStrings(detail.outputImage, dim(record, 'output_image_tokens'));
}

function emptyDetail(): TokenDetail {
  return {
    requests: 0,
    cost: null,
    input: '0',
    output: '0',
    total: '0',
    prefill: '0',
    cacheRead: '0',
    cacheCreation: '0',
    inputImage: '0',
    outputImage: '0',
  };
}

// Aggregate token counts routinely exceed the safe integer range, and cost is
// billed to sub-cent precision, so both stay decimal strings until they reach a
// chart axis or a formatted label.
function dim(record: DisplayUsageRecord, key: BillingMetric): DecimalString {
  return record.metrics[key] ?? '0';
}

function metricValue(record: DisplayUsageRecord, metric: UsageMetric): DecimalString | number | null {
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
}

// Plot values cross into floating point exactly here, at the axis boundary.
function plottableMetricValue(record: DisplayUsageRecord, metric: UsageMetric): number {
  const value = metricValue(record, metric);
  if (value === null) return 0;
  return typeof value === 'number' ? value : decimalStringToPlottableNumber(value);
}

// Ratios are percentages of one aggregate over another, so both sides convert
// to plottable numbers first; the division itself has no precision to protect.
function tokenDetailMetricValue(detail: TokenDetail, metric: UsageMetric): number | null {
  const ratio = (numerator: DecimalString, denominator: DecimalString): number | null => {
    const bottom = decimalStringToPlottableNumber(denominator);
    return bottom > 0 ? (decimalStringToPlottableNumber(numerator) / bottom) * 100 : null;
  };
  if (metric === 'cacheHitRate') return ratio(detail.cacheRead, sumDecimalStrings(detail.cacheRead, detail.cacheCreation));
  if (metric === 'cachedRate') {
    return ratio(detail.cacheRead, sumDecimalStrings(detail.input, detail.cacheRead, detail.cacheCreation, detail.inputImage));
  }
  return null;
}

function hasRequests(details: Map<string, Map<string, TokenDetail>>, id: string): boolean {
  for (const bucket of details.values()) {
    if ((bucket.get(id)?.requests ?? 0) > 0) return true;
  }
  return false;
}

export function chartTickValues(buckets: UsageBucket[]): UsageBucket[] {
  if (buckets.length <= 8) return buckets;
  const desired = buckets.length <= 24 ? 6 : 7;
  const step = Math.ceil((buckets.length - 1) / (desired - 1));
  const ticks = buckets.filter((_, index) => index % step === 0);
  const last = buckets[buckets.length - 1];
  if (last && ticks[ticks.length - 1] !== last) ticks.push(last);
  return ticks;
}

export function formatAxisDate(date: Date, range: UsageRange, locale: string): string {
  if (range === 'today') {
    return date.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  if (range === '7d') {
    return date.toLocaleDateString(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    });
  }
  return date.toLocaleDateString(locale, {
    month: '2-digit',
    day: '2-digit',
  });
}

export function formatCalloutTitle(
  value: Date | number | string,
  labelByTime: Map<number, string>,
  range: UsageRange,
  locale: string,
): string {
  if (value instanceof Date) {
    return labelByTime.get(value.getTime()) ?? formatAxisDate(value, range, locale);
  }
  if (typeof value === 'number') return value.toLocaleString(locale);
  return value;
}

export function bucketKeyForCallout(
  value: Date | number | string,
  buckets: UsageBucket[],
): string | null {
  if (value instanceof Date) {
    return (
      buckets.find(bucket => bucket.date.getTime() === value.getTime())?.key ??
      null
    );
  }
  return null;
}

export function formatCount(value: number, locale: string): string {
  return Math.round(value).toLocaleString(locale);
}

export function formatTokenCount(value: number, locale: string): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toLocaleString(locale);
}

// Aggregate token totals are decimal strings; grouping them digit-wise keeps
// counts past the safe integer range exact in the label.
export const formatUsdCost = formatUsd;

export function formatDecimalCount(value: DecimalString): string {
  return formatDecimalQuantity(value);
}

export function formatInputRate(cached: DecimalString, input: DecimalString): string {
  const denominator = decimalStringToPlottableNumber(input);
  if (denominator <= 0) return '-';
  return `${((decimalStringToPlottableNumber(cached) / denominator) * 100).toFixed(1)}%`;
}

export function formatHitRate(cached: DecimalString, created: DecimalString): string {
  const denominator = decimalStringToPlottableNumber(sumDecimalStrings(cached, created));
  if (denominator <= 0) return '-';
  return `${((decimalStringToPlottableNumber(cached) / denominator) * 100).toFixed(1)}%`;
}

export function formatSummaryMetric(
  summary: TokenSummary,
  metric: UsageMetric,
  locale: string,
): string {
  switch (metric) {
  case 'requests':
    return formatCount(summary.requests, locale);
  case 'cost':
    return formatUsd(summary.cost);
  case 'total':
    return formatDecimalCount(summary.total);
  case 'input':
    return formatDecimalCount(summary.input);
  case 'output':
    return formatDecimalCount(summary.output);
  case 'prefill':
    return formatDecimalCount(summary.prefill);
  case 'cached':
    return formatDecimalCount(summary.cacheRead);
  case 'cacheCreation':
    return formatDecimalCount(summary.cacheCreation);
  case 'cachedRate':
    return formatInputRate(summary.cacheRead, summary.input);
  case 'cacheHitRate':
    return formatHitRate(summary.cacheRead, summary.cacheCreation);
  }
}

// Axis-side formatter: the value here is a plotted point, so it has already
// crossed into floating point and there is no exact decimal left to preserve.
// Summary tiles use formatUsd and formatDecimalCount on the decimal values.
export function formatMetricValue(value: number, metric: UsageMetric, locale: string): string {
  const kind = metricConfig[metric].kind;
  if (kind === 'percent') return `${value.toFixed(0)}%`;
  if (kind === 'cost') return formatPlottedCost(value);
  if (kind === 'count') return formatCount(value, locale);
  return formatTokenCount(value, locale);
}

function formatPlottedCost(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return '$0';
}

export function formatProvider(provider: string): string {
  if (provider === 'microsoft-grounding') return 'Microsoft Grounding';
  if (provider === 'tavily') return 'Tavily';
  if (provider === 'jina') return 'Jina';
  return provider;
}

import type { ChartProps } from '@fluentui/react-charts';

import { metricConfig, summaryFieldForMetric } from './metrics';
import type { DisplayUsageRecord, SearchChartModel, SearchUsageResponse, TokenChartModel, TokenCounters, TokenSummary, UsageMetric, UsageRange, UsageResponse } from './types';
import type { ControlPlaneModel } from '../../api/types';
import { decimalStringToPlottableNumber, sumDecimalStrings } from '../../lib/decimal-display';
import type { ChartBucket } from '../charts/dashboard-time';
import {
  dashboardBucketFrames,
  dashboardBucketKeyForUtcHour,
} from '../charts/dashboard-time';
import type { ChartSeries } from '../charts/series-legends';
import { withUniqueSeriesLegends } from '../charts/series-legends';
import { areaSeries, lineSeries } from '../charts/series-plot';
import type { BillingMetric, DecimalString } from '@floway-dev/protocols/common';

const shortMonthDay = (date: Date, locale: string): string =>
  date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });

// `formatRange` keeps the span locale-owned, where a hand-built `14:00 - 15:00`
// would impose a 24-hour clock. The end is wrapped onto the start's own calendar
// day because `formatRange` widens to two full datetimes once its endpoints fall
// on different days; reversed endpoints still print in the order given.
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

  const isPercent = metricConfig[metric].kind === 'percent';
  const series = entries
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

// A null bucket is not the reading zero, so its point is left out and the curve
// bridges the gap instead of dipping through it.
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
  redactKeys,
  range,
  buckets,
}: {
  search: SearchUsageResponse;
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

  // Not gated on the configured provider: that would erase the history of every
  // provider since switched away from, and hide the panel once search is off.
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
  return {
    entries,
    buckets,
    kind: 'search',
    providers: [...providers].sort(),
    range,
    plot: {
      form: 'area',
      data: areaChartData(buckets, entries.map(entry => ({
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
      const value = plottableMetricValue(countersForRecord(record), metric);
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
        bucketValues.set(group, plottableMetricValue(detail, metric));
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

export const summarizeCounters = (counters: TokenCounters): TokenSummary => {
  const prompt = sumDecimalStrings(counters.input, counters.cacheRead, counters.cacheCreation, counters.inputImage);
  return {
    requests: counters.requests,
    cost: counters.cost,
    cacheRead: counters.cacheRead,
    cacheCreation: counters.cacheCreation,
    prompt,
    output: sumDecimalStrings(counters.output, counters.outputImage),
    total: sumDecimalStrings(counters.input, counters.output, counters.cacheRead, counters.cacheCreation, counters.inputImage, counters.outputImage),
    prefill: sumDecimalStrings(counters.input, counters.cacheCreation, counters.inputImage),
    cachedRate: percentOf(counters.cacheRead, prompt),
    cacheHitRate: percentOf(counters.cacheRead, sumDecimalStrings(counters.cacheRead, counters.cacheCreation)),
  };
};

// Ratios divide one aggregate by another, so both sides convert to plottable
// numbers first; the division has no precision to protect.
const percentOf = (numerator: DecimalString, denominator: DecimalString): number | null => {
  const bottom = decimalStringToPlottableNumber(denominator);
  return bottom > 0 ? (decimalStringToPlottableNumber(numerator) / bottom) * 100 : null;
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

const countersForRecord = (record: DisplayUsageRecord): TokenCounters => {
  const counters = emptyCounters();
  addRecordToCounters(counters, record);
  return counters;
};

const dim = (record: DisplayUsageRecord, key: BillingMetric): DecimalString => {
  return record.metrics[key] ?? '0';
};

// Plot values cross into floating point exactly here, at the axis boundary.
const plottableMetricValue = (counters: TokenCounters, metric: UsageMetric): number | null => {
  const value = summarizeCounters(counters)[summaryFieldForMetric[metric]];
  if (value === null) return null;
  return typeof value === 'number' ? value : decimalStringToPlottableNumber(value);
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

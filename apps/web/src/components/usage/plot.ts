import type { ChartProps } from '@fluentui/react-charts';

import { metricConfig, summaryFieldForMetric } from './metrics';
import type { DisplayUsageRecord, SearchChartModel, SearchUsageResponse, TokenChartModel, TokenCounters, TokenSummary, UsageMetric, UsageRange } from './types';
import { decimalStringToPlottableNumber, sumDecimalStrings } from '../../lib/decimal-display';
import type { ChartBucket } from '../charts/dashboard-time';
import { hueForSeriesSlot, OTHER_SERIES_COLOR } from '../charts/palette';
import { OTHER_SERIES_ID, otherSeriesGroup, partitionSeriesForOther, stableSeriesHues } from '../charts/series-grouping';
import type { ChartSeries } from '../charts/series-legends';
import { withUniqueSeriesLegends } from '../charts/series-legends';
import { areaSeries, lineSeries } from '../charts/series-plot';
import type { MultiselectOption } from '../ui/multiselect-combobox';
import { parseTelemetryHour, type BillingMetric, type DecimalString } from '@floway-dev/protocols/browser';

export const buildTokenChart = ({
  records,
  dimensionOptions,
  metric,
  range,
  buckets,
  seriesHues,
  seriesColors,
  seriesWeights,
}: {
  records: DisplayUsageRecord[];
  dimensionOptions: readonly MultiselectOption[];
  metric: UsageMetric;
  range: UsageRange;
  buckets: ChartBucket[];
  seriesHues?: ReadonlyMap<string, number> | undefined;
  seriesColors?: ReadonlyMap<string, string> | undefined;
  seriesWeights?: ReadonlyMap<string, number> | undefined;
}): TokenChartModel => {
  const { values, details } = aggregateTokenRecords(records, metric, range, buckets);
  const presentGroups = new Set(records.map(record => record.group));
  const knownGroups = new Set(dimensionOptions.map(option => option.value));
  const missingGroup = [...presentGroups].find(group => !knownGroups.has(group));
  if (missingGroup !== undefined) {
    throw new TypeError(`Usage overview series group is missing from dimension values: ${missingGroup}`);
  }
  const entries = withUniqueSeriesLegends(dimensionOptions
    .filter(option => presentGroups.has(option.value))
    .map((option, slot) => ({
      id: option.value,
      label: option.label,
      hue: seriesHues?.get(option.value) ?? hueForSeriesSlot(slot),
      color: seriesColors?.get(option.value),
    })));

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
    weights: seriesWeights !== undefined
      ? new Map(entries.map(entry => [entry.id, seriesWeights.get(entry.id) ?? 0]))
      : tokenSeriesWeights(entries, buckets, values, details, isPercent),
    buckets,
    details,
    kind: 'token',
    range,
    plot: isPercent
      ? { form: 'line', data: lineChartData(buckets, series) }
      : { form: 'area', data: areaChartData(buckets, series) },
  };
};

// Cached rate is cacheRead / prompt, so prompt tokens weigh a percent metric
// by its true denominator rather than by request count.
export const usageRecordMetricWeight = (record: DisplayUsageRecord, metric: UsageMetric): number => {
  if (metric === 'requests') return record.requests;
  const counters = countersForRecord(record);
  if (metricConfig[metric].kind === 'percent') return decimalStringToPlottableNumber(summarizeCounters(counters).prompt);
  return plottableMetricValue(counters, metric) ?? 0;
};

const tokenSeriesWeights = (
  entries: readonly ChartSeries[],
  buckets: readonly ChartBucket[],
  values: ReadonlyMap<string, ReadonlyMap<string, number | null>>,
  details: ReadonlyMap<string, ReadonlyMap<string, TokenCounters>>,
  isPercent: boolean,
): Map<string, number> => new Map(entries.map(entry => [entry.id, buckets.reduce((sum, bucket) => {
  if (!isPercent) return sum + (values.get(bucket.key)!.get(entry.id) ?? 0);
  const detail = details.get(bucket.key)!.get(entry.id);
  return sum + (detail === undefined ? 0 : decimalStringToPlottableNumber(summarizeCounters(detail).prompt));
}, 0)]));

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
  range,
  buckets,
  foldSmallSeries,
  hidden,
  otherLabel,
}: {
  search: SearchUsageResponse;
  range: UsageRange;
  buckets: ChartBucket[];
  foldSmallSeries: boolean;
  hidden: ReadonlySet<string>;
  otherLabel: string;
}): SearchChartModel => {
  const groups = new Map<string, Map<string, number>>();
  const presentGroups = new Set<string>();
  const backends = new Set<string>();
  const meta = new Map<string, { name: string | undefined; createdAt: string | undefined }>();
  for (const key of search.keys) meta.set(key.id, { name: key.name, createdAt: key.createdAt });

  // Not gated on the configured backend: that would erase the history of every
  // backend since switched away from, and hide the panel once search is off.
  for (const record of search.records) {
    const hour = parseTelemetryHour(record.hour);
    const bucket = buckets.find(({ start, end }) => start <= hour && hour < end)?.key;
    if (bucket === undefined) continue;
    backends.add(record.backend);
    presentGroups.add(record.keyId);
    meta.set(record.keyId, {
      name: record.keyName ?? meta.get(record.keyId)?.name,
      createdAt: record.keyCreatedAt ?? meta.get(record.keyId)?.createdAt,
    });
    const bucketValues = groups.get(record.keyId) ?? new Map<string, number>();
    bucketValues.set(bucket, (bucketValues.get(bucket) ?? 0) + record.requests);
    groups.set(record.keyId, bucketValues);
  }

  const allWeights = new Map([...groups.entries()].map(([id, bucketValues]) => [
    id,
    [...bucketValues.values()].reduce((sum, value) => sum + value, 0),
  ]));
  const baseEntries = keyChartEntries(
    [...presentGroups],
    search.keys,
    search.records,
    stableSeriesHues([...presentGroups], allWeights),
  );

  const { top, other: otherItems } = partitionSeriesForOther(baseEntries, allWeights, foldSmallSeries);
  let entries = baseEntries;
  let weights = allWeights;

  if (otherItems.length > 0) {
    const otherBuckets = new Map<string, number>();
    for (const entry of otherItems) {
      if (hidden.has(entry.id)) continue;
      for (const [bucket, count] of groups.get(entry.id)!) {
        otherBuckets.set(bucket, (otherBuckets.get(bucket) ?? 0) + count);
      }
    }
    const topSet = new Set(top.map(entry => entry.id));
    const preservedTop = baseEntries.filter(entry => topSet.has(entry.id));
    weights = new Map(preservedTop.map(entry => [entry.id, allWeights.get(entry.id)!]));
    if (otherBuckets.size > 0) {
      groups.set(OTHER_SERIES_ID, otherBuckets);
      entries = withUniqueSeriesLegends([
        ...preservedTop,
        { id: OTHER_SERIES_ID, label: otherLabel, hue: 0, color: OTHER_SERIES_COLOR },
      ]);
      weights.set(OTHER_SERIES_ID, [...otherBuckets.values()].reduce((sum, value) => sum + value, 0));
    } else {
      entries = preservedTop;
    }
  }

  return {
    entries,
    weights,
    buckets,
    kind: 'search',
    backends: [...backends].sort(),
    range,
    other: otherSeriesGroup(otherItems),
    plot: {
      form: 'area',
      data: areaChartData(buckets, entries.map(entry => ({
        entry,
        data: buckets.map(bucket => groups.get(entry.id)!.get(bucket.key) ?? 0),
      }))),
    },
  };
};

const aggregateTokenRecords = (
  records: DisplayUsageRecord[],
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
    const bucket = record.bucket;
    if (!values.has(bucket)) continue;

    const group = record.group;
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
  metadata: SearchUsageResponse['keys'],
  records: SearchUsageResponse['records'],
  seriesHues?: ReadonlyMap<string, number>,
): ChartSeries[] => {
  const meta = new Map<string, { name: string | undefined; createdAt: string | undefined }>();
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
      const slot = slotById.get(id)!;
      return {
        id,
        label: meta.get(id)?.name ?? id.slice(0, 8),
        hue: seriesHues?.get(id) ?? hueForSeriesSlot(slot),
        slot,
      };
    })
    .sort((a, b) => a.slot - b.slot)
    .map(({ slot: _, ...entry }) => entry));
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

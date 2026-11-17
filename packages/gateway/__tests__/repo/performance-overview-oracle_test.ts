import { test } from 'vitest';

import { aggregatePerformanceForDisplay } from './performance-overview-oracle.ts';
import type { PerformanceDisplayRecord, PerformanceTelemetryRecord } from '../../src/repo/types.ts';
import { createTelemetryBucket, type TelemetryBucketOptions } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

type AggregateOptions = TelemetryBucketOptions & {
  groupBy: import('../../src/repo/types.ts').PerformanceGroupBy;
};

// The oracle is multi-axis; every case focuses on a single axis, so unwrap it
// through a one-axis map to keep the test surface flat.
const aggregateSingle = (
  records: readonly PerformanceTelemetryRecord[],
  options: AggregateOptions,
  keyToUser: ReadonlyMap<string, number> = new Map(),
): PerformanceDisplayRecord[] =>
  aggregatePerformanceForDisplay(records, {
    axis: { groupBy: options.groupBy, bucketForHour: createTelemetryBucket(options) },
  }, keyToUser, new Set(records.map(item => item.keyId))).axis;

const record = (overrides: Partial<PerformanceTelemetryRecord> = {}): PerformanceTelemetryRecord => ({
  hour: '2026-04-30T10',
  keyId: 'key_a',
  model: 'claude-opus-4-7',
  upstream: 'copilot:1',
  operation: 'chat',
  runtimeLocation: 'LOCAL',
  requests: 1,
  ttftSamplesOk: 1,
  errorsWithOutput: 0,
  errorsNoOutput: 0,
  neutral: 0,
  tpotSamples: 1,
  ttftMsSum: 100,
  tpotUsSum: 500,
  // Bucket edges here are illustrative test fixtures, not the production edge set.
  buckets: [
    { metric: 'ttft_ms', lower: 50, upper: 100, count: 1 },
    { metric: 'tpot_us', lower: 200, upper: 500, count: 1 },
  ],
  ...overrides,
});

// A singleton bucket places its sole sample's expected order statistic at
// the interval midpoint, so every percentile has the same estimate.
const TTFT_MID = (50 + 100) / 2;
const TPOT_MID = (200 + 500) / 2;

test('Performance overview oracle produces correct averages and percentiles for a single record', () => {
  const rows = aggregateSingle(
    [record()],
    { bucket: 'hour', groupBy: 'model', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows, [
    {
      bucket: '2026-04-30T10',
      group: 'claude-opus-4-7',
      requests: 1,
      errors: 0,
      ttftSamples: 1,
      tpotSamples: 1,
      neutral: 0,
      ttftMsP50: TTFT_MID,
      ttftMsP95: TTFT_MID,
      ttftMsP99: TTFT_MID,
      tpotUsP50: TPOT_MID,
      tpotUsP95: TPOT_MID,
      tpotUsP99: TPOT_MID,
    },
  ]);
});

test('Performance overview oracle groups by userId via keyToUser and drops orphan-key rows', () => {
  // key_a → user 7, key_b → user 42, key_ghost → hard-deleted (not in map).
  // The orphan row must not surface as a synthetic userId 0 bucket.
  const rows = aggregateSingle(
    [
      record({
        keyId: 'key_a',
        requests: 2,
        ttftSamplesOk: 0,
        errorsWithOutput: 0,
        errorsNoOutput: 0,
        neutral: 2,
        tpotSamples: 0,
        ttftMsSum: 0,
        tpotUsSum: 0,
        buckets: [],
      }),
      record({
        keyId: 'key_b',
        requests: 5,
        ttftSamplesOk: 0,
        errorsWithOutput: 0,
        errorsNoOutput: 0,
        neutral: 5,
        tpotSamples: 0,
        ttftMsSum: 0,
        tpotUsSum: 0,
        buckets: [],
      }),
      record({
        keyId: 'key_ghost',
        requests: 9,
        ttftSamplesOk: 0,
        errorsWithOutput: 0,
        errorsNoOutput: 0,
        neutral: 9,
        tpotSamples: 0,
        ttftMsSum: 0,
        tpotUsSum: 0,
        buckets: [],
      }),
    ],
    {
      bucket: 'all',
      groupBy: 'userId',
      timezoneOffsetMinutes: 0,
    },
    new Map([['key_a', 7], ['key_b', 42]]),
  );

  assertEquals(rows.length, 2);
  const byGroup = Object.fromEntries(rows.map(r => [r.group, r.requests]));
  assertEquals(byGroup, { 7: 2, 42: 5 });
});

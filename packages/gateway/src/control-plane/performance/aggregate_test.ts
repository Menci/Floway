import { test } from 'vitest';

import { aggregatePerformanceForDisplay, type AggregateOptions, type PerformanceDisplayRecord } from './aggregate.ts';
import type { PerformanceTelemetryRecord } from '../../repo/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

// The production aggregator is multi-axis: one traversal produces every
// per-axis breakdown. Every case here focuses on a single axis, so unwrap
// it through a one-axis map to keep the test surface flat.
const aggregateSingle = (
  records: readonly PerformanceTelemetryRecord[],
  options: AggregateOptions,
  keyToUser: ReadonlyMap<string, number> = new Map(),
): PerformanceDisplayRecord[] =>
  aggregatePerformanceForDisplay(records, { axis: options }, keyToUser, new Set(records.map(item => item.keyId))).axis;

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

test('aggregatePerformanceForDisplay produces correct averages and percentiles for a single record', () => {
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

test('aggregatePerformanceForDisplay counts zero-output-error rows as displayed requests without fabricating latency', () => {
  const rows = aggregateSingle(
    [
      record({
        model: 'gpt-5.5-pro-2026-04-23',
        upstream: 'codex:1',
        requests: 3,
        ttftSamplesOk: 0,
        errorsWithOutput: 0,
        errorsNoOutput: 3,
        neutral: 0,
        tpotSamples: 0,
        ttftMsSum: 0,
        tpotUsSum: 0,
        buckets: [],
      }),
    ],
    { bucket: 'all', groupBy: 'model', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows, [
    {
      bucket: 'all',
      group: 'gpt-5.5-pro-2026-04-23',
      requests: 3,
      errors: 3,
      ttftSamples: 0,
      tpotSamples: 0,
      neutral: 0,
      ttftMsP50: null,
      ttftMsP95: null,
      ttftMsP99: null,
      tpotUsP50: null,
      tpotUsP95: null,
      tpotUsP99: null,
    },
  ]);
});

test('aggregatePerformanceForDisplay merges two hours under bucket: all', () => {
  const rows = aggregateSingle(
    [record({ hour: '2026-04-30T10' }), record({ hour: '2026-04-30T11' })],
    { bucket: 'all', groupBy: 'model', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows.length, 1);
  assertEquals(rows[0].bucket, 'all');
  assertEquals(rows[0].requests, 2);
  assertEquals(rows[0].ttftSamples, 2);
  assertEquals(rows[0].tpotSamples, 2);
  // The merged bucket has count 2, so p50 is its first order statistic.
  assertEquals(rows[0].ttftMsP50, 50 + 50 / 3);
});

test('aggregatePerformanceForDisplay splits rows by upstream when groupBy is upstream', () => {
  const rows = aggregateSingle(
    [
      record({ upstream: 'copilot:1' }),
      record({ upstream: 'codex:2' }),
    ],
    { bucket: 'hour', groupBy: 'upstream', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows.length, 2);
  const groups = rows.map(r => r.group).sort();
  assertEquals(groups, ['codex:2', 'copilot:1']);
});

test('aggregatePerformanceForDisplay returns lower edge for overflow-bucket percentile', () => {
  // A ttftMs value above the highest edge falls into the overflow bucket
  // { lower: <top-finite-edge>, upper: null }. percentileFromBuckets returns
  // bucket.lower when upper is null because a finite uniform distribution
  // cannot be inferred without an upper edge.
  const rows = aggregateSingle(
    [
      record({
        ttftMsSum: 600_000,
        ttftSamplesOk: 1,
        tpotSamples: 1,
        requests: 1,
        buckets: [{ metric: 'ttft_ms', lower: 300_000, upper: null, count: 1 }],
      }),
    ],
    { bucket: 'hour', groupBy: 'model', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows[0].ttftMsP50, 300_000);
  assertEquals(rows[0].ttftMsP99, 300_000);
});

test('aggregatePerformanceForDisplay groups days using caller timezone offset', () => {
  const rows = aggregateSingle([record({ hour: '2026-04-30T16' })], { bucket: 'day', groupBy: 'none', timezoneOffsetMinutes: -480 });

  assertEquals(rows[0].bucket, '2026-05-01');
});

test('aggregatePerformanceForDisplay groups hours using caller timezone offset', () => {
  const rows = aggregateSingle([record({ hour: '2026-04-30T16' })], { bucket: 'hour', groupBy: 'none', timezoneOffsetMinutes: -480 });

  assertEquals(rows[0].bucket, '2026-05-01T00');
});

test('aggregatePerformanceForDisplay aligns 4h buckets to {00,04,08,12,16,20}', () => {
  const rows = aggregateSingle([record({ hour: '2026-04-30T09' }), record({ hour: '2026-04-30T11' }), record({ hour: '2026-04-30T15' })], {
    bucket: '4h',
    groupBy: 'none',
    timezoneOffsetMinutes: 0,
  });

  assertEquals(rows.length, 2);
  assertEquals(rows[0].bucket, '2026-04-30T08');
  assertEquals(rows[0].requests, 2);
  assertEquals(rows[1].bucket, '2026-04-30T12');
  assertEquals(rows[1].requests, 1);
});

test('aggregatePerformanceForDisplay aligns 8h buckets to {00,08,16}', () => {
  const rows = aggregateSingle([record({ hour: '2026-04-30T09' }), record({ hour: '2026-04-30T15' })], { bucket: '8h', groupBy: 'none', timezoneOffsetMinutes: 0 });

  assertEquals(rows.length, 1);
  assertEquals(rows[0].bucket, '2026-04-30T08');
  assertEquals(rows[0].requests, 2);
});

test('aggregatePerformanceForDisplay aligns 8h buckets in caller timezone', () => {
  // local = UTC-08:00; UTC 16:00 -> local 08:00 -> 8h bucket starts at 08:00.
  const rows = aggregateSingle([record({ hour: '2026-04-30T16' })], { bucket: '8h', groupBy: 'none', timezoneOffsetMinutes: 480 });

  assertEquals(rows[0].bucket, '2026-04-30T08');
});

test('aggregatePerformanceForDisplay splits rows by operation when groupBy is operation', () => {
  const rows = aggregateSingle(
    [
      record({ operation: 'chat' }),
      record({
        operation: 'embeddings',
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
    ],
    { bucket: 'all', groupBy: 'operation', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows.length, 2);
  const groups = rows.map(r => r.group).sort();
  assertEquals(groups, ['chat', 'embeddings']);
});

test('aggregatePerformanceForDisplay derives errors and ttftSamples from the partition counters', () => {
  // requests = ttftSamplesOk + errorsWithOutput + errorsNoOutput + neutral = 5
  // Derived totals: errors = errorsWithOutput + errorsNoOutput = 2,
  //                 ttftSamples = ttftSamplesOk + errorsWithOutput = 4.
  const rows = aggregateSingle(
    [
      record({
        requests: 5,
        ttftSamplesOk: 3,
        errorsWithOutput: 1,
        errorsNoOutput: 1,
        neutral: 0,
        tpotSamples: 3,
        ttftMsSum: 300,
        tpotUsSum: 1500,
        buckets: [
          { metric: 'ttft_ms', lower: 50, upper: 100, count: 4 },
          { metric: 'tpot_us', lower: 200, upper: 500, count: 3 },
        ],
      }),
    ],
    { bucket: 'all', groupBy: 'none', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows[0].requests, 5);
  assertEquals(rows[0].errors, 2);
  assertEquals(rows[0].ttftSamples, 4);
  assertEquals(rows[0].tpotSamples, 3);
  assertEquals(rows[0].neutral, 0);
});

test('aggregatePerformanceForDisplay carries neutral straight from the recorder partition', () => {
  const rows = aggregateSingle(
    [record({
      requests: 5,
      ttftSamplesOk: 3,
      errorsWithOutput: 0,
      errorsNoOutput: 1,
      neutral: 1,
      tpotSamples: 3,
      ttftMsSum: 300,
      tpotUsSum: 1500,
      buckets: [
        { metric: 'ttft_ms', lower: 50, upper: 100, count: 3 },
        { metric: 'tpot_us', lower: 200, upper: 500, count: 3 },
      ],
    })],
    { bucket: 'all', groupBy: 'none', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows[0].neutral, 1);
  assertEquals(rows[0].errors, 1);
  assertEquals(rows[0].ttftSamples, 3);
});

test('aggregatePerformanceForDisplay tpot percentiles derive from the tpot bucket set only, unaffected by TTFT-only samples', () => {
  // Mix: one full sample (contributes ttft + tpot) + one TTFT-only sample (ttft only).
  // The tpot histogram carries only the full sample's bucket, so tpot percentiles
  // reflect that single point without dilution from the TTFT-only row.
  const rows = aggregateSingle(
    [record({
      requests: 2,
      ttftSamplesOk: 2,
      tpotSamples: 1,
      buckets: [
        { metric: 'ttft_ms', lower: 50, upper: 100, count: 2 },
        { metric: 'tpot_us', lower: 200, upper: 500, count: 1 },
      ],
    })],
    { bucket: 'all', groupBy: 'none', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows[0].ttftSamples, 2);
  assertEquals(rows[0].tpotSamples, 1);
  assertEquals(rows[0].tpotUsP50, TPOT_MID);
  assertEquals(rows[0].neutral, 0);
});

test('aggregatePerformanceForDisplay groups by userId via keyToUser and drops orphan-key rows', () => {
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

test('aggregatePerformanceForDisplay does not conflate a real userId 0 with orphan-key rows', () => {
  // key_zero legitimately maps to user 0; key_ghost is hard-deleted. Only the
  // real user 0 row must appear, and its request count must exclude the ghost.
  const rows = aggregateSingle(
    [
      record({
        keyId: 'key_zero',
        requests: 3,
        ttftSamplesOk: 0,
        errorsWithOutput: 0,
        errorsNoOutput: 0,
        neutral: 3,
        tpotSamples: 0,
        ttftMsSum: 0,
        tpotUsSum: 0,
        buckets: [],
      }),
      record({
        keyId: 'key_ghost',
        requests: 11,
        ttftSamplesOk: 0,
        errorsWithOutput: 0,
        errorsNoOutput: 0,
        neutral: 11,
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
    new Map([['key_zero', 0]]),
  );

  assertEquals(rows.length, 1);
  assertEquals(rows[0].group, '0');
  assertEquals(rows[0].requests, 3);
});

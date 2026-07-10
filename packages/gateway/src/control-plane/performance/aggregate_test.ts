import { test } from 'vitest';

import { aggregatePerformanceForDisplay } from './aggregate.ts';
import type { PerformanceTelemetryRecord } from '../../repo/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

const record = (overrides: Partial<PerformanceTelemetryRecord> = {}): PerformanceTelemetryRecord => ({
  hour: '2026-04-30T10',
  keyId: 'key_a',
  model: 'claude-opus-4-7',
  upstream: 'copilot:1',
  operation: 'chat',
  runtimeLocation: 'LOCAL',
  requests: 1,
  errors: 0,
  ttftSamples: 1,
  tpotSamples: 1,
  failedWithOutput: 0,
  ttftMsSum: 100,
  tpotUsSum: 500,
  // Bucket edges here are illustrative test fixtures, not the production edge set.
  // ttft bucket [50, 100] → geometric midpoint sqrt(5000) ≈ 70.71
  // tpot bucket [200, 500] → geometric midpoint sqrt(100000) ≈ 316.23
  buckets: [
    { metric: 'ttft_ms', lower: 50, upper: 100, count: 1 },
    { metric: 'tpot_us', lower: 200, upper: 500, count: 1 },
  ],
  ...overrides,
});

// Geometric midpoints of the fixture buckets — expected percentile values.
const TTFT_MID = Math.sqrt(50 * 100);
const TPOT_MID = Math.sqrt(200 * 500);

test('aggregatePerformanceForDisplay produces correct averages and percentiles for a single record', () => {
  const rows = aggregatePerformanceForDisplay(
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
      failedWithOutput: 0,
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

test('aggregatePerformanceForDisplay counts error-only rows as displayed requests without fabricating latency', () => {
  const rows = aggregatePerformanceForDisplay(
    [
      record({
        model: 'gpt-5.5-pro-2026-04-23',
        upstream: 'codex:1',
        requests: 3,
        errors: 3,
        ttftSamples: 0,
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
      failedWithOutput: 0,
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
  const rows = aggregatePerformanceForDisplay(
    [record({ hour: '2026-04-30T10' }), record({ hour: '2026-04-30T11' })],
    { bucket: 'all', groupBy: 'model', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows.length, 1);
  assertEquals(rows[0].bucket, 'all');
  assertEquals(rows[0].requests, 2);
  assertEquals(rows[0].ttftSamples, 2);
  assertEquals(rows[0].tpotSamples, 2);
  assertEquals(rows[0].ttftMsP50, TTFT_MID);
});

test('aggregatePerformanceForDisplay splits rows by upstream when groupBy is upstream', () => {
  const rows = aggregatePerformanceForDisplay(
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
  // bucket.lower when upper is null (geometric midpoint is undefined without an
  // upper edge).
  const rows = aggregatePerformanceForDisplay(
    [
      record({
        ttftMsSum: 600_000,
        ttftSamples: 1,
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
  const rows = aggregatePerformanceForDisplay([record({ hour: '2026-04-30T16' })], { bucket: 'day', groupBy: 'none', timezoneOffsetMinutes: -480 });

  assertEquals(rows[0].bucket, '2026-05-01');
});

test('aggregatePerformanceForDisplay groups hours using caller timezone offset', () => {
  const rows = aggregatePerformanceForDisplay([record({ hour: '2026-04-30T16' })], { bucket: 'hour', groupBy: 'none', timezoneOffsetMinutes: -480 });

  assertEquals(rows[0].bucket, '2026-05-01T00');
});

test('aggregatePerformanceForDisplay aligns 4h buckets to {00,04,08,12,16,20}', () => {
  const rows = aggregatePerformanceForDisplay([record({ hour: '2026-04-30T09' }), record({ hour: '2026-04-30T11' }), record({ hour: '2026-04-30T15' })], {
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
  const rows = aggregatePerformanceForDisplay([record({ hour: '2026-04-30T09' }), record({ hour: '2026-04-30T15' })], { bucket: '8h', groupBy: 'none', timezoneOffsetMinutes: 0 });

  assertEquals(rows.length, 1);
  assertEquals(rows[0].bucket, '2026-04-30T08');
  assertEquals(rows[0].requests, 2);
});

test('aggregatePerformanceForDisplay aligns 8h buckets in caller timezone', () => {
  // local = UTC-08:00; UTC 16:00 -> local 08:00 -> 8h bucket starts at 08:00.
  const rows = aggregatePerformanceForDisplay([record({ hour: '2026-04-30T16' })], { bucket: '8h', groupBy: 'none', timezoneOffsetMinutes: 480 });

  assertEquals(rows[0].bucket, '2026-04-30T08');
});

test('aggregatePerformanceForDisplay splits rows by operation when groupBy is operation', () => {
  const rows = aggregatePerformanceForDisplay(
    [
      record({ operation: 'chat' }),
      record({ operation: 'embeddings', requests: 2, errors: 0, ttftSamples: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0, buckets: [] }),
    ],
    { bucket: 'all', groupBy: 'operation', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows.length, 2);
  const groups = rows.map(r => r.group).sort();
  assertEquals(groups, ['chat', 'embeddings']);
});

test('aggregatePerformanceForDisplay derives neutral as requests - ttftSamples - errors + failedWithOutput', () => {
  const rows = aggregatePerformanceForDisplay(
    [
      record({
        requests: 5, ttftSamples: 3, tpotSamples: 3, errors: 1, ttftMsSum: 300, tpotUsSum: 1500, buckets: [
          { metric: 'ttft_ms', lower: 50, upper: 100, count: 3 },
          { metric: 'tpot_us', lower: 200, upper: 500, count: 3 },
        ],
      }),
    ],
    { bucket: 'all', groupBy: 'none', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows[0].neutral, 1);
  assertEquals(rows[0].requests, 5);
  assertEquals(rows[0].ttftSamples, 3);
  assertEquals(rows[0].tpotSamples, 3);
  assertEquals(rows[0].errors, 1);
});

test('aggregatePerformanceForDisplay backs partial-output failures out of neutral via failedWithOutput', () => {
  // A row where one of the two errors is a partial-output failure (both in
  // errors AND ttftSamples). Without the overlap subtraction, neutral would
  // read `4 - 3 - 2 = -1`; with `failedWithOutput = 1` the aggregator gets
  // `4 - 3 - 2 + 1 = 0`, matching the recorder's actual partition.
  const rows = aggregatePerformanceForDisplay(
    [
      record({
        requests: 4, ttftSamples: 3, tpotSamples: 3, errors: 2, failedWithOutput: 1, ttftMsSum: 300, tpotUsSum: 1500, buckets: [
          { metric: 'ttft_ms', lower: 50, upper: 100, count: 3 },
          { metric: 'tpot_us', lower: 200, upper: 500, count: 3 },
        ],
      }),
    ],
    { bucket: 'all', groupBy: 'none', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows[0].neutral, 0);
  assertEquals(rows[0].failedWithOutput, 1);
  assertEquals(rows[0].errors, 2);
  assertEquals(rows[0].ttftSamples, 3);
});

test('aggregatePerformanceForDisplay surfaces negative neutral when input row breaks the recorder invariant', () => {
  // Recorder atomicity + parsePerformanceRecords guarantee
  // `errors + ttftSamples - failedWithOutput <= requests` for anything Floway
  // wrote. A negative neutral therefore indicates the row was corrupted outside
  // the recorder path (manual D1 UPDATE, future recorder bug). We pass the raw
  // subtraction through so the corruption surfaces on the dashboard rather than
  // hiding behind a floor.
  const rows = aggregatePerformanceForDisplay(
    [record({
      requests: 2, ttftSamples: 3, tpotSamples: 3, errors: 1, ttftMsSum: 300, tpotUsSum: 1500, buckets: [
        { metric: 'ttft_ms', lower: 50, upper: 100, count: 3 },
        { metric: 'tpot_us', lower: 200, upper: 500, count: 3 },
      ],
    })],
    { bucket: 'all', groupBy: 'none', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows[0].neutral, -2);
});

test('aggregatePerformanceForDisplay neutral is zero for pure chat rows (ttftSamples + errors - failedWithOutput = requests)', () => {
  const rows = aggregatePerformanceForDisplay(
    [record({
      requests: 4, ttftSamples: 3, tpotSamples: 3, errors: 1, ttftMsSum: 300, tpotUsSum: 1500, buckets: [
        { metric: 'ttft_ms', lower: 50, upper: 100, count: 3 },
        { metric: 'tpot_us', lower: 200, upper: 500, count: 3 },
      ],
    })],
    { bucket: 'all', groupBy: 'none', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows[0].neutral, 0);
});

test('aggregatePerformanceForDisplay tpot percentiles derive from the tpot bucket set only, unaffected by TTFT-only samples', () => {
  // Mix: one full sample (contributes ttft + tpot) + one TTFT-only sample (ttft only).
  // The tpot histogram carries only the full sample's bucket, so tpot percentiles
  // reflect that single point without dilution from the TTFT-only row.
  const rows = aggregatePerformanceForDisplay(
    [record({
      requests: 2, ttftSamples: 2, tpotSamples: 1, buckets: [
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
  const rows = aggregatePerformanceForDisplay(
    [
      record({ keyId: 'key_a', requests: 2, ttftSamples: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0, buckets: [] }),
      record({ keyId: 'key_b', requests: 5, ttftSamples: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0, buckets: [] }),
      record({ keyId: 'key_ghost', requests: 9, ttftSamples: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0, buckets: [] }),
    ],
    {
      bucket: 'all',
      groupBy: 'userId',
      timezoneOffsetMinutes: 0,
      keyToUser: new Map([['key_a', 7], ['key_b', 42]]),
    },
  );

  assertEquals(rows.length, 2);
  const byGroup = Object.fromEntries(rows.map(r => [r.group, r.requests]));
  assertEquals(byGroup, { 7: 2, 42: 5 });
});

test('aggregatePerformanceForDisplay does not conflate a real userId 0 with orphan-key rows', () => {
  // key_zero legitimately maps to user 0; key_ghost is hard-deleted. Only the
  // real user 0 row must appear, and its request count must exclude the ghost.
  const rows = aggregatePerformanceForDisplay(
    [
      record({ keyId: 'key_zero', requests: 3, ttftSamples: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0, buckets: [] }),
      record({ keyId: 'key_ghost', requests: 11, ttftSamples: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0, buckets: [] }),
    ],
    {
      bucket: 'all',
      groupBy: 'userId',
      timezoneOffsetMinutes: 0,
      keyToUser: new Map([['key_zero', 0]]),
    },
  );

  assertEquals(rows.length, 1);
  assertEquals(rows[0].group, '0');
  assertEquals(rows[0].requests, 3);
});

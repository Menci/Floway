import { test } from 'vitest';

import { aggregatePerformanceForDisplay } from './aggregate.ts';
import type { PerformanceTelemetryRecord } from '../../repo/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

const record = (overrides: Partial<PerformanceTelemetryRecord> = {}): PerformanceTelemetryRecord => ({
  hour: '2026-04-30T10',
  keyId: 'key_a',
  model: 'claude-opus-4-7',
  upstream: 'copilot:1',
  runtimeLocation: 'LOCAL',
  requests: 1,
  errors: 0,
  samples: 1,
  ttftMsSum: 100,
  tpotUsSum: 500,
  // ttftMs=100 → bucket [50,100]; tpotUs=500 → bucket [200,500]
  buckets: [
    { metric: 'ttft_ms', lower: 50, upper: 100, count: 1 },
    { metric: 'tpot_us', lower: 200, upper: 500, count: 1 },
  ],
  ...overrides,
});

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
      samples: 1,
      ttftMsAvg: 100,
      ttftMsP50: 100,
      ttftMsP95: 100,
      ttftMsP99: 100,
      tpotUsAvg: 500,
      tpotUsP50: 500,
      tpotUsP95: 500,
      tpotUsP99: 500,
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
        samples: 0,
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
      samples: 0,
      ttftMsAvg: null,
      ttftMsP50: null,
      ttftMsP95: null,
      ttftMsP99: null,
      tpotUsAvg: null,
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
  assertEquals(rows[0].samples, 2);
  assertEquals(rows[0].ttftMsAvg, 100);
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
  // A ttftMs value above the highest edge (1_800_000 ms) falls into the
  // overflow bucket { lower: 1_800_000, upper: null }. percentileFromBuckets
  // returns bucket.lower when upper is null.
  const rows = aggregatePerformanceForDisplay(
    [
      record({
        ttftMsSum: 3_600_000,
        samples: 1,
        requests: 1,
        buckets: [{ metric: 'ttft_ms', lower: 1_800_000, upper: null, count: 1 }],
      }),
    ],
    { bucket: 'hour', groupBy: 'model', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows[0].ttftMsP50, 1_800_000);
  assertEquals(rows[0].ttftMsP99, 1_800_000);
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

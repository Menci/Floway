import { test } from 'vitest';

import { aggregatePerformanceForDisplay } from './aggregate.ts';
import type { PerformanceTelemetryRecord } from '../../repo/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

const record = (overrides: Partial<PerformanceTelemetryRecord>): PerformanceTelemetryRecord => ({
  hour: '2026-04-30T10',
  metricScope: 'request_total',
  keyId: 'key_a',
  model: 'claude-opus-4-7',
  upstream: 'copilot:1',
  modelKey: 'claude-opus-4.7',
  stream: true,
  runtimeLocation: 'LOCAL',
  requests: 1,
  errors: 0,
  totalMsSum: 100,
  buckets: [{ lowerMs: 0, upperMs: 100, count: 1 }],
  ...overrides,
});

test('aggregatePerformanceForDisplay groups provider model keys by public model', () => {
  const rows = aggregatePerformanceForDisplay(
    [
      record({
        requests: 90,
        totalMsSum: 9000,
        buckets: [{ lowerMs: 0, upperMs: 100, count: 90 }],
      }),
      record({
        modelKey: 'claude-opus-4.7-xhigh',
        requests: 10,
        totalMsSum: 3000,
        buckets: [{ lowerMs: 100, upperMs: 300, count: 10 }],
      }),
    ],
    { bucket: 'hour', groupBy: 'model', timezoneOffsetMinutes: 0 },
  );

  assertEquals(rows, [
    {
      bucket: '2026-04-30T10',
      group: 'claude-opus-4-7',
      requests: 100,
      errors: 0,
      totalMsSum: 12000,
      avgMs: 120,
      p50Ms: 100,
      p95Ms: 300,
      p99Ms: 300,
    },
  ]);
});

test('aggregatePerformanceForDisplay counts error-only rows as displayed requests without fabricating latency', () => {
  const rows = aggregatePerformanceForDisplay(
    [
      record({
        model: 'gpt-5.5-pro-2026-04-23',
        modelKey: 'gpt-5.5-pro-2026-04-23',
        requests: 0,
        errors: 3,
        totalMsSum: 0,
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
      totalMsSum: 0,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    },
  ]);
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

import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import type { PerformanceRepo } from './types.ts';
import { latencyBucketForMs } from '../shared/performance-histogram.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

const baseSample = {
  hour: '2026-04-30T10',
  keyId: 'key_a',
  model: 'claude-opus-4-7',
  upstream: 'copilot:1',
  modelKey: 'claude-opus-4.7-xhigh',
  stream: true,
  runtimeLocation: 'LOCAL',
};

async function exercisePerformanceRepo(repo: PerformanceRepo) {
  await repo.deleteAll();
  await repo.recordLatency({
    ...baseSample,
    metricScope: 'request_total',
    durationMs: 120,
  });
  await repo.recordLatency({
    ...baseSample,
    metricScope: 'request_total',
    durationMs: 130,
  });
  await repo.recordError({
    ...baseSample,
    metricScope: 'request_total',
  });
  await repo.recordLatency({
    ...baseSample,
    metricScope: 'upstream_success',
    durationMs: 500,
  });
  await repo.recordLatency({
    ...baseSample,
    hour: '2026-04-30T11',
    metricScope: 'request_total',
    durationMs: 1000,
  });

  const requestRows = await repo.query({
    start: '2026-04-30T10',
    end: '2026-04-30T11',
    metricScope: 'request_total',
  });
  assertEquals(requestRows.length, 1);
  assertEquals(requestRows[0].requests, 2);
  assertEquals(requestRows[0].errors, 1);
  assertEquals(requestRows[0].totalMsSum, 250);
  assertEquals(requestRows[0].buckets, [{ ...latencyBucketForMs(120), count: 2 }]);

  const upstreamRows = await repo.query({
    start: '2026-04-30T10',
    end: '2026-04-30T11',
    metricScope: 'upstream_success',
  });
  assertEquals(upstreamRows.length, 1);
  assertEquals(upstreamRows[0].requests, 1);
  assertEquals(upstreamRows[0].errors, 0);
  assertEquals(upstreamRows[0].totalMsSum, 500);
  assertEquals(upstreamRows[0].buckets, [{ ...latencyBucketForMs(500), count: 1 }]);

  const replacement = {
    ...baseSample,
    metricScope: 'request_total' as const,
    requests: 7,
    errors: 2,
    totalMsSum: 1400,
    buckets: [{ lowerMs: 100, upperMs: 142, count: 7 }],
  };
  await repo.set(replacement);
  assertEquals(await repo.listAll(), [
    replacement,
    {
      ...baseSample,
      metricScope: 'upstream_success',
      requests: 1,
      errors: 0,
      totalMsSum: 500,
      buckets: [{ ...latencyBucketForMs(500), count: 1 }],
    },
    {
      ...baseSample,
      hour: '2026-04-30T11',
      metricScope: 'request_total',
      requests: 1,
      errors: 0,
      totalMsSum: 1000,
      buckets: [{ ...latencyBucketForMs(1000), count: 1 }],
    },
  ]);

  await repo.deleteAll();
  assertEquals(
    await repo.query({
      start: '2026-04-30T10',
      end: '2026-04-30T12',
    }),
    [],
  );
}

test('memory performance repo records, queries, and clears telemetry', async () => {
  await exercisePerformanceRepo(new InMemoryRepo().performance);
});

class FakePerformanceSqlPreparedStatement {
  private binds: unknown[] = [];

  constructor(private db: FakePerformanceSqlDatabase, private query: string) {}

  bind(...values: unknown[]): FakePerformanceSqlPreparedStatement {
    this.binds = values;
    return this;
  }

  first(): Promise<null> {
    throw new Error(`Unsupported first() query in performance test: ${this.query}`);
  }

  all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.includes('FROM performance_summary')) {
      return Promise.resolve({
        results: this.db.selectSummaries(this.query, this.binds) as T[],
        success: true,
        meta: {},
      });
    }
    if (this.query.includes('FROM performance_latency_buckets')) {
      return Promise.resolve({
        results: this.db.selectBuckets(this.query, this.binds) as T[],
        success: true,
        meta: {},
      });
    }

    throw new Error(`Unsupported all() query in performance test: ${this.query}`);
  }

  run(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.startsWith('INSERT INTO performance_summary')) {
      this.db.upsertSummary(this.query, this.binds);
      return Promise.resolve({ results: [], success: true, meta: {} });
    }
    if (this.query.startsWith('INSERT INTO performance_latency_buckets')) {
      this.db.upsertBucket(this.binds);
      return Promise.resolve({ results: [], success: true, meta: {} });
    }
    if (this.query === 'DELETE FROM performance_latency_buckets') {
      this.db.buckets = [];
      return Promise.resolve({ results: [], success: true, meta: {} });
    }
    if (this.query.startsWith('DELETE FROM performance_latency_buckets')) {
      this.db.deleteBuckets(this.binds);
      return Promise.resolve({ results: [], success: true, meta: {} });
    }
    if (this.query === 'DELETE FROM performance_summary') {
      this.db.summaries = [];
      return Promise.resolve({ results: [], success: true, meta: {} });
    }

    throw new Error(`Unsupported run() query in performance test: ${this.query}`);
  }
}

type FakePerformanceDimensionsRow = {
  hour: string;
  metric_scope: string;
  key_id: string;
  model: string;
  upstream: string | null;
  model_key: string;
  stream: number;
  runtime_location: string;
};

type FakePerformanceSummaryRow = FakePerformanceDimensionsRow & {
  requests: number;
  errors: number;
  total_ms_sum: number;
};

type FakePerformanceBucketRow = FakePerformanceDimensionsRow & {
  lower_ms: number;
  upper_ms: number;
  count: number;
};

class FakePerformanceSqlDatabase implements SqlDatabase {
  exec(): Promise<unknown> { return Promise.resolve(undefined); }

  summaries: FakePerformanceSummaryRow[] = [];
  buckets: FakePerformanceBucketRow[] = [];

  prepare(query: string): FakePerformanceSqlPreparedStatement {
    return new FakePerformanceSqlPreparedStatement(this, query);
  }

  async batch(statements: Parameters<NonNullable<SqlDatabase['batch']>>[0]) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  upsertSummary(query: string, binds: unknown[]): void {
    const row = summaryRowFromBinds(binds);
    const existing = this.summaries.find(candidate => sameDimensions(candidate, row));
    if (existing) {
      if (query.includes('requests = excluded.requests')) {
        existing.requests = row.requests;
        existing.errors = row.errors;
        existing.total_ms_sum = row.total_ms_sum;
      } else {
        existing.requests += row.requests;
        existing.errors += row.errors;
        existing.total_ms_sum += row.total_ms_sum;
      }
      return;
    }
    this.summaries.push(row);
  }

  upsertBucket(binds: unknown[]): void {
    const row = bucketRowFromBinds(binds);
    const existing = this.buckets.find(candidate => sameDimensions(candidate, row) && candidate.lower_ms === row.lower_ms && candidate.upper_ms === row.upper_ms);
    if (existing) {
      existing.count += row.count;
      return;
    }
    this.buckets.push(row);
  }

  deleteBuckets(binds: unknown[]): void {
    const dimensions = dimensionsRowFromBinds(binds);
    this.buckets = this.buckets.filter(row => !sameDimensions(row, dimensions));
  }

  selectSummaries(query: string, binds: unknown[]): FakePerformanceSummaryRow[] {
    return this.summaries.filter(row => matchesPerformanceWhere(row, query, binds)).toSorted(compareFakePerformanceRows);
  }

  selectBuckets(query: string, binds: unknown[]): FakePerformanceBucketRow[] {
    return this.buckets.filter(row => matchesPerformanceWhere(row, query, binds)).toSorted((a, b) => compareFakePerformanceRows(a, b) || a.upper_ms - b.upper_ms);
  }
}

function summaryRowFromBinds(binds: unknown[]): FakePerformanceSummaryRow {
  const [hour, metricScope, keyId, model, upstream, modelKey, stream, runtimeLocation, requests, errors, totalMsSum] = binds as [
    string,
    string,
    string,
    string,
    string | null,
    string,
    number,
    string,
    number,
    number,
    number,
  ];
  return {
    hour,
    metric_scope: metricScope,
    key_id: keyId,
    model,
    upstream,
    model_key: modelKey,
    stream,
    runtime_location: runtimeLocation,
    requests,
    errors,
    total_ms_sum: totalMsSum,
  };
}

function dimensionsRowFromBinds(binds: unknown[]): FakePerformanceDimensionsRow {
  const [hour, metricScope, keyId, model, upstream, modelKey, stream, runtimeLocation] = binds as [
    string,
    string,
    string,
    string,
    string | null,
    string,
    number,
    string,
  ];
  return {
    hour,
    metric_scope: metricScope,
    key_id: keyId,
    model,
    upstream,
    model_key: modelKey,
    stream,
    runtime_location: runtimeLocation,
  };
}

function bucketRowFromBinds(binds: unknown[]): FakePerformanceBucketRow {
  const [hour, metricScope, keyId, model, upstream, modelKey, stream, runtimeLocation, lowerMs, upperMs, count] = binds as [
    string,
    string,
    string,
    string,
    string | null,
    string,
    number,
    string,
    number,
    number,
    number,
  ];
  return {
    hour,
    metric_scope: metricScope,
    key_id: keyId,
    model,
    upstream,
    model_key: modelKey,
    stream,
    runtime_location: runtimeLocation,
    lower_ms: lowerMs,
    upper_ms: upperMs,
    count,
  };
}

function sameDimensions(a: FakePerformanceDimensionsRow, b: FakePerformanceDimensionsRow): boolean {
  return (
    a.hour === b.hour &&
    a.metric_scope === b.metric_scope &&
    a.key_id === b.key_id &&
    a.model === b.model &&
    a.upstream === b.upstream &&
    a.model_key === b.model_key &&
    a.stream === b.stream &&
    a.runtime_location === b.runtime_location
  );
}

function matchesPerformanceWhere(row: FakePerformanceDimensionsRow, query: string, binds: unknown[]): boolean {
  if (!query.includes('hour >= ?')) return true;

  const [start, end, ...rest] = binds as string[];
  if (row.hour < start || row.hour >= end) return false;

  let index = 0;
  if (query.includes('key_id = ?')) {
    const keyId = rest[index++];
    if (row.key_id !== keyId) return false;
  }
  if (query.includes('metric_scope = ?')) {
    const metricScope = rest[index++];
    if (row.metric_scope !== metricScope) return false;
  }
  return true;
}

function compareFakePerformanceRows(a: FakePerformanceDimensionsRow, b: FakePerformanceDimensionsRow): number {
  return (
    a.hour.localeCompare(b.hour) ||
    a.metric_scope.localeCompare(b.metric_scope) ||
    a.key_id.localeCompare(b.key_id) ||
    a.model.localeCompare(b.model) ||
    (a.upstream ?? '').localeCompare(b.upstream ?? '') ||
    a.model_key.localeCompare(b.model_key) ||
    a.stream - b.stream ||
    a.runtime_location.localeCompare(b.runtime_location)
  );
}

test('SQL performance repo records, queries, and clears telemetry', async () => {
  await exercisePerformanceRepo(new SqlRepo(new FakePerformanceSqlDatabase()).performance);
});

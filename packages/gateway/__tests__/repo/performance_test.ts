import { describe, expect, it } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { type CompletedStatement, recordCompletedStatements } from './recording-sql.ts';
import { assertD1CompoundSelectLimit, createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type {
  ApiKey,
  PerformanceDimensions,
  PerformanceOverviewQueryOptions,
  PerformanceRepo,
  PerformanceSample,
  PerformanceTelemetryRecord,
} from '../../src/repo/types.ts';

const apiKey = (id: string, userId: number): ApiKey => ({
  id,
  userId,
  name: id,
  key: `raw-${id}`,
  serverSecret: String(userId).padStart(2, '0').repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
});

const sample = (over: Partial<PerformanceSample> = {}): PerformanceSample => ({
  hour: '2026-06-30T09',
  keyId: 'key_a',
  model: 'claude-opus-4-8',
  upstream: 'anthropic-1',
  operation: 'chat',
  runtimeLocation: 'hkg',
  ttftMs: 340,
  tpotUs: 15_000,
  success: true,
  ...over,
});

const errSample = (over: Partial<PerformanceDimensions> = {}): PerformanceDimensions => ({
  hour: '2026-06-30T09',
  keyId: 'key_a',
  model: 'claude-opus-4-8',
  upstream: 'anthropic-1',
  operation: 'chat',
  runtimeLocation: 'hkg',
  ...over,
});

const impls: Array<{ name: string; open: () => Promise<PerformanceRepo> }> = [
  { name: 'memory', open: async () => new InMemoryRepo().performance },
  { name: 'sqlite', open: async () => new SqlRepo(await createSqliteTestDb()).performance },
];

for (const impl of impls) {
  describe(`PerformanceRepo (${impl.name})`, () => {
    it('records a sample into summary + one TTFT bucket + one TPOT bucket', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample());
      const rows = await repo.listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        hour: '2026-06-30T09',
        keyId: 'key_a',
        model: 'claude-opus-4-8',
        upstream: 'anthropic-1',
        runtimeLocation: 'hkg',
        requests: 1,
        ttftSamplesOk: 1,
        errorsWithOutput: 0,
        errorsNoOutput: 0,
        neutral: 0,
        tpotSamples: 1,
        ttftMsSum: 340,
        tpotUsSum: 15_000,
      });
      const ttft = rows[0]!.buckets.find(b => b.metric === 'ttft_ms')!;
      const tpot = rows[0]!.buckets.find(b => b.metric === 'tpot_us')!;
      expect(ttft).toEqual({ metric: 'ttft_ms', lower: 300, upper: 500, count: 1 });
      expect(tpot).toEqual({ metric: 'tpot_us', lower: 14_286, upper: 16_667, count: 1 });
    });

    it('records a zero-output error into summary requests + errorsNoOutput only, no bucket rows', async () => {
      const repo = await impl.open();
      await repo.recordZeroOutputError(errSample());
      const rows = await repo.listAll();
      expect(rows[0]).toMatchObject({ requests: 1, ttftSamplesOk: 0, errorsWithOutput: 0, errorsNoOutput: 1, neutral: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0 });
      expect(rows[0]!.buckets).toEqual([]);
    });

    it('routes a failed sample into errorsWithOutput (not ttftSamplesOk)', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ success: false }));
      const [row] = await repo.listAll();
      expect(row).toMatchObject({
        requests: 1,
        ttftSamplesOk: 0,
        errorsWithOutput: 1,
        errorsNoOutput: 0,
        neutral: 0,
        tpotSamples: 1,
        ttftMsSum: 340,
        tpotUsSum: 15_000,
      });
      expect(row!.buckets.some(b => b.metric === 'ttft_ms')).toBe(true);
      expect(row!.buckets.some(b => b.metric === 'tpot_us')).toBe(true);
    });

    it('additive upsert accumulates sums, samples, and bucket counts', async () => {
      const repo = await impl.open();
      // Both samples fall in the same TTFT bucket [200, 300] and same TPOT bucket [10000, 12500]
      // so a single (lower, upper) entry accumulates count=2 for each metric.
      await repo.recordSample(sample({ ttftMs: 250, tpotUs: 10_500 }));
      await repo.recordSample(sample({ ttftMs: 260, tpotUs: 11_500 }));
      const [row] = await repo.listAll();
      expect(row).toMatchObject({ requests: 2, ttftSamplesOk: 2, tpotSamples: 2, ttftMsSum: 510, tpotUsSum: 22_000 });
      const ttft = row!.buckets.find(b => b.metric === 'ttft_ms' && b.lower === 200 && b.upper === 300)!;
      expect(ttft.count).toBe(2);
      const tpot = row!.buckets.find(b => b.metric === 'tpot_us' && b.lower === 10_000 && b.upper === 12_500)!;
      expect(tpot.count).toBe(2);
    });

    it('separates rows by any dimension change (upstream)', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ upstream: 'anthropic-1' }));
      await repo.recordSample(sample({ upstream: 'anthropic-2' }));
      const rows = await repo.listAll();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map(r => r.upstream))).toEqual(new Set(['anthropic-1', 'anthropic-2']));
    });

    it('set() replaces (not adds) a row and its buckets', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ ttftMs: 100, tpotUs: 8_000 }));
      const [orig] = await repo.listAll();
      await repo.set({
        ...orig!,
        requests: 5,
        ttftSamplesOk: 5,
        errorsWithOutput: 0,
        errorsNoOutput: 0,
        neutral: 0,
        tpotSamples: 5,
        ttftMsSum: 500,
        tpotUsSum: 40_000,
        buckets: [
          { metric: 'ttft_ms', lower: 0, upper: 50, count: 5 },
          { metric: 'tpot_us', lower: 5_000, upper: 10_000, count: 5 },
        ],
      });
      const [after] = await repo.listAll();
      expect(after).toMatchObject({ requests: 5, ttftSamplesOk: 5, tpotSamples: 5, ttftMsSum: 500, tpotUsSum: 40_000 });
      expect(after!.buckets).toHaveLength(2);
    });

    it('records TTFT overflow bucket for very slow requests beyond the top edge', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ ttftMs: 600_000 }));
      const [row] = await repo.listAll();
      const overflow = row!.buckets.find(b => b.metric === 'ttft_ms' && b.upper === null)!;
      expect(overflow).toEqual({ metric: 'ttft_ms', lower: 300_000, upper: null, count: 1 });
    });

    it('TTFT-only sample (no tpotUs) records TTFT bucket without touching TPOT columns', async () => {
      const repo = await impl.open();
      const { tpotUs: _tpot, ...ttftOnly } = sample();
      await repo.recordSample(ttftOnly);
      const [row] = await repo.listAll();
      expect(row).toMatchObject({ requests: 1, ttftSamplesOk: 1, tpotSamples: 0, ttftMsSum: 340, tpotUsSum: 0 });
      expect(row!.buckets.some(b => b.metric === 'ttft_ms')).toBe(true);
      expect(row!.buckets.some(b => b.metric === 'tpot_us')).toBe(false);
    });

    it('recordNeutral bumps requests and neutral', async () => {
      const repo = await impl.open();
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      const rows = await repo.listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ requests: 1, neutral: 1, ttftSamplesOk: 0, errorsWithOutput: 0, errorsNoOutput: 0, tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0 });
      expect(rows[0]!.buckets).toEqual([]);
    });

    it('recordNeutral is additive across calls', async () => {
      const repo = await impl.open();
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      const [row] = await repo.listAll();
      expect(row!.requests).toBe(3);
      expect(row!.neutral).toBe(3);
      expect(row!.errorsNoOutput).toBe(0);
      expect(row!.ttftSamplesOk).toBe(0);
      expect(row!.tpotSamples).toBe(0);
    });

    it('different operations create different rows', async () => {
      const repo = await impl.open();
      await repo.recordSample(sample({ operation: 'chat' }));
      await repo.recordNeutral(errSample({ operation: 'embeddings' }));
      const rows = await repo.listAll();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map(r => r.operation))).toEqual(new Set(['chat', 'embeddings']));
    });
  });
}

describe('SqlPerformanceRepo upsertSummary set-mode guard', () => {
  it('throws when set() is handed a record missing a count column', async () => {
    const repo = new SqlRepo(await createSqliteTestDb()).performance;
    // TS enforces every count on the public shape; test the runtime guard by
    // casting a partial through, mirroring an `as`-cast slipping past compile.
    const incomplete = {
      ...errSample(),
      requests: 5,
      ttftSamplesOk: 5,
      errorsWithOutput: 0,
      errorsNoOutput: 0,
      neutral: 0,
      tpotSamples: 5,
      // ttftMsSum omitted on purpose
      tpotUsSum: 40_000,
      buckets: [],
    } as unknown as PerformanceTelemetryRecord;
    await expect(repo.set(incomplete)).rejects.toThrow(/missing count column ttft_ms_sum/);
  });
});

describe('SqlPerformanceRepo operation vocabulary', () => {
  it('persists audio transcription rows through the open operation schema', async () => {
    const repo = new SqlRepo(await createSqliteTestDb()).performance;
    await repo.recordNeutral(errSample({ operation: 'audio_transcription' }));
    const [row] = await repo.listAll();
    expect(row).toMatchObject({ operation: 'audio_transcription', requests: 1, neutral: 1 });
  });

  it('persists rerank rows through the open operation schema', async () => {
    const repo = new SqlRepo(await createSqliteTestDb()).performance;
    await repo.recordNeutral(errSample({ operation: 'rerank' }));
    const [row] = await repo.listAll();
    expect(row).toMatchObject({ operation: 'rerank', requests: 1, neutral: 1 });
  });

  it('rejects an unknown stored operation at hydration', async () => {
    const db = await createSqliteTestDb();
    await db.prepare(
      `INSERT INTO performance_summary (hour, key_id, model, upstream, operation, runtime_location)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind('2026-06-30T09', 'key_a', 'model', 'upstream', 'future-operation', 'hkg').run();

    const repo = new SqlRepo(db).performance;
    await expect(repo.listAll()).rejects.toThrow('Invalid performance operation: "future-operation"');
  });
});

it('SQL Performance overview matches the in-memory oracle across every grouping and filter', async () => {
  const sql = new SqlRepo(await createSqliteTestDb());
  const memory = new InMemoryRepo();
  const repos = [sql, memory];
  for (const repo of repos) {
    await repo.apiKeys.save(apiKey('key-1', 1));
    await repo.apiKeys.save(apiKey('key-2', 2));
    await Promise.all([
      repo.performance.set({
        hour: '2026-11-01T05', keyId: 'key-1', model: 'model-a', upstream: 'up-a',
        operation: 'chat', runtimeLocation: 'SJC', requests: 100,
        ttftSamplesOk: 90, errorsWithOutput: 10, errorsNoOutput: 0, neutral: 0,
        tpotSamples: 90, ttftMsSum: 12_000, tpotUsSum: 45_000,
        buckets: [
          { metric: 'ttft_ms', lower: 0, upper: 100, count: 90 },
          { metric: 'ttft_ms', lower: 200, upper: 300, count: 10 },
          { metric: 'tpot_us', lower: 0, upper: 500, count: 90 },
        ],
      }),
      repo.performance.set({
        hour: '2026-11-01T06', keyId: 'key-2', model: 'model-b', upstream: 'up-b',
        operation: 'embeddings', runtimeLocation: 'LOCAL', requests: 4,
        ttftSamplesOk: 0, errorsWithOutput: 0, errorsNoOutput: 1, neutral: 3,
        tpotSamples: 0, ttftMsSum: 0, tpotUsSum: 0, buckets: [],
      }),
      repo.performance.set({
        hour: '2026-11-01T06', keyId: 'ghost', model: 'model-b', upstream: 'up-b',
        operation: 'chat', runtimeLocation: 'LOCAL', requests: 2,
        ttftSamplesOk: 2, errorsWithOutput: 0, errorsNoOutput: 0, neutral: 0,
        tpotSamples: 2, ttftMsSum: 600_000, tpotUsSum: 20_000_000,
        buckets: [
          { metric: 'ttft_ms', lower: 300_000, upper: null, count: 2 },
          { metric: 'tpot_us', lower: 2_500_000, upper: 10_000_000, count: 2 },
        ],
      }),
    ]);
  }
  const options: PerformanceOverviewQueryOptions = {
    actorUserId: 1,
    isAdmin: true,
    start: '2026-11-01T05',
    end: '2026-11-01T07',
    groupBy: 'model',
    filters: {
      keyIds: [], userIds: [], models: [], upstreams: [], operations: [], runtimeLocations: [],
    },
    bucketForHour: () => '2026-11-01T01',
  };

  for (const groupBy of ['model', 'upstream', 'operation', 'runtimeLocation', 'userId', 'keyId'] as const) {
    expect(await sql.performance.queryOverview({ ...options, groupBy }))
      .toEqual(await memory.performance.queryOverview({ ...options, groupBy }));
  }
  for (const filters of [
    { ...options.filters, models: ['model-a', 'model-b'], upstreams: ['up-b'] },
    { ...options.filters, userIds: [1], keyIds: ['key-1'] },
    { ...options.filters, operations: ['chat'], runtimeLocations: ['LOCAL'] },
    { ...options.filters, models: ['missing'] },
  ]) {
    expect(await sql.performance.queryOverview({ ...options, filters }))
      .toEqual(await memory.performance.queryOverview({ ...options, filters }));
  }
  expect(await sql.performance.queryOverview({ ...options, actorUserId: 2, isAdmin: false }))
    .toEqual(await memory.performance.queryOverview({ ...options, actorUserId: 2, isAdmin: false }));
});

it('SQL Performance overview rejects a histogram row without its summary identity', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  await db.prepare(`INSERT INTO performance_buckets (
    hour, key_id, model, upstream, operation, runtime_location, metric, lower, upper, count
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    '2026-06-30T09', 'ghost', 'model', 'upstream', 'chat', 'LOCAL',
    'ttft_ms', 0, 100, 1,
  ).run();

  await expect(repo.performance.queryOverview({
    actorUserId: 1,
    isAdmin: true,
    start: '2026-06-30T00',
    end: '2026-06-30T23',
    groupBy: 'model',
    filters: {
      keyIds: [], userIds: [], models: [], upstreams: [], operations: [], runtimeLocations: [],
    },
    bucketForHour: hour => hour,
  })).rejects.toThrow('performance_buckets row has no matching summary');
});

it('SQL Performance overview ignores out-of-scope orphan histograms under key grouping', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  await repo.apiKeys.save(apiKey('key-1', 1));
  await repo.apiKeys.save(apiKey('key-2', 2));
  await repo.performance.recordNeutral(errSample({ keyId: 'key-1' }));
  await db.prepare(`INSERT INTO performance_buckets (
    hour, key_id, model, upstream, operation, runtime_location, metric, lower, upper, count
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    '2026-06-30T09', 'key-2', 'model', 'upstream', 'chat', 'LOCAL',
    'ttft_ms', 0, 100, 1,
  ).run();

  const overview = await repo.performance.queryOverview({
    actorUserId: 1,
    isAdmin: true,
    start: '2026-06-30T00',
    end: '2026-06-30T23',
    groupBy: 'keyId',
    filters: {
      keyIds: [], userIds: [], models: [], upstreams: [], operations: [], runtimeLocations: [],
    },
    bucketForHour: hour => hour,
  });
  expect(overview.axes.none[0]?.requests).toBe(1);
});

it('Performance overview repositories reject inconsistent upper bounds for one merged histogram bucket', async () => {
  for (const repo of [new SqlRepo(await createSqliteTestDb()), new InMemoryRepo()]) {
    await repo.apiKeys.save(apiKey('key-1', 1));
    await repo.apiKeys.save(apiKey('key-2', 2));
    for (const [keyId, upper] of [['key-1', 100], ['key-2', 200]] as const) {
      await repo.performance.set({
        hour: '2026-06-30T09', keyId, model: 'model', upstream: 'upstream',
        operation: 'chat', runtimeLocation: 'LOCAL', requests: 1,
        ttftSamplesOk: 1, errorsWithOutput: 0, errorsNoOutput: 0, neutral: 0,
        tpotSamples: 0, ttftMsSum: 50, tpotUsSum: 0,
        buckets: [{ metric: 'ttft_ms', lower: 0, upper, count: 1 }],
      });
    }

    await expect(repo.performance.queryOverview({
      actorUserId: 1,
      isAdmin: true,
      start: '2026-06-30T00',
      end: '2026-06-30T23',
      groupBy: 'model',
      filters: {
        keyIds: [], userIds: [], models: [], upstreams: [], operations: [], runtimeLocations: [],
      },
      bucketForHour: hour => hour,
    })).rejects.toThrow('performance_buckets rows disagree on histogram bounds');
  }
});

it('SQL Performance overview uses actor indexes and returns aggregate cardinality', async () => {
  const db = await createSqliteTestDb();
  const seedRepo = new SqlRepo(db);
  await seedRepo.apiKeys.save(apiKey('key-1', 1));
  for (let index = 0; index < 40; index++) {
    await seedRepo.performance.set({
      hour: new Date(Date.UTC(2026, 5, 1, index)).toISOString().slice(0, 13),
      keyId: 'key-1', model: 'shared-model', upstream: 'shared-upstream',
      operation: 'chat', runtimeLocation: 'LOCAL', requests: 1,
      ttftSamplesOk: 1, errorsWithOutput: 0, errorsNoOutput: 0, neutral: 0,
      tpotSamples: 1, ttftMsSum: 100, tpotUsSum: 500,
      buckets: [
        { metric: 'ttft_ms', lower: 0, upper: 100, count: 1 },
        { metric: 'tpot_us', lower: 0, upper: 500, count: 1 },
      ],
    });
  }
  const completed: CompletedStatement[] = [];
  const repo = new SqlRepo(recordCompletedStatements(db, completed));

  const overview = await repo.performance.queryOverview({
    actorUserId: 1,
    isAdmin: true,
    start: '2026-06-01T00',
    end: '2026-08-01T00',
    groupBy: 'keyId',
    filters: {
      keyIds: [], userIds: [], models: [], upstreams: [], operations: [], runtimeLocations: [],
    },
    bucketForHour: () => 'one-bucket',
  });

  const aggregates = completed.filter(statement => statement.query.startsWith('/* performance-overview */'));
  const aggregate = aggregates.at(-1);
  if (!aggregate) throw new Error('Performance overview SQL evidence was not captured');
  assertD1CompoundSelectLimit(aggregate.query);
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${aggregate.query}`)
    .bind(...aggregate.binds)
    .all<{ detail: string }>();
  const plan = results.map(row => row.detail).join('\n');
  const rawRows = await db.prepare('SELECT (SELECT COUNT(*) FROM performance_summary) + (SELECT COUNT(*) FROM performance_buckets) AS count')
    .first<{ count: number }>();
  expect(plan).toContain('idx_performance_summary_key_hour');
  expect(rawRows?.count).toBe(120);
  expect(aggregates).toHaveLength(1);
  expect(aggregate.resultCount).toBeLessThan(120);
  expect(overview.axes.none[0]).toMatchObject({ requests: 40, ttftSamples: 40, tpotSamples: 40 });
});

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
} from '../../src/repo/types.ts';

const apiKey = (id: string, userId: number): ApiKey => ({
  id,
  userId,
  name: id,
  key: `raw-${id}`,
  serverSecret: String(userId).padStart(2, '0').repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  randomizeUpstreams: false,
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
  });
}

describe('SqlPerformanceRepo operation vocabulary', () => {
  it('rejects an unknown stored operation at hydration', async () => {
    const db = await createSqliteTestDb();
    await db.prepare(
      `INSERT INTO performance_summary (hour, key_id, model, upstream, operation, runtime_location)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind('2026-06-30T09', 'key_a', 'model', 'upstream', 'future-operation', 'hkg').run();

    const repo = new SqlRepo(db).performance;
    await expect(repo.listAll()).rejects.toThrow(TypeError);
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
      repo.performance.set({
        hour: '2026-11-01T06', keyId: 'key-1', model: 'model-a', upstream: 'up-a',
        operation: 'chat', runtimeLocation: 'SJC', requests: 2,
        ttftSamplesOk: 2, errorsWithOutput: 0, errorsNoOutput: 0, neutral: 0,
        tpotSamples: 0, ttftMsSum: 300, tpotUsSum: 0,
        buckets: [{ metric: 'ttft_ms', lower: 100, upper: 200, count: 2 }],
      }),
    ]);
  }
  const options: PerformanceOverviewQueryOptions = {
    actorUserId: 1,
    isAdmin: true,
    visibleUserIds: [],
    visibleUpstreams: [],
    start: '2026-11-01T05',
    end: '2026-11-01T07',
    groupBy: 'model',
    filters: {
      keyIds: [], userIds: [], models: [], upstreams: [], operations: [], runtimeLocations: [],
    },
    bucketForHour: () => '2026-11-01T01',
  };

  for (const bucketForHour of [options.bucketForHour, (hour: string) => hour, (hour: string) => hour.slice(0, 10)]) {
    for (const actor of [
      { actorUserId: 1, isAdmin: true, visibleUserIds: [], visibleUpstreams: [] },
      { actorUserId: 2, isAdmin: false, visibleUserIds: [2], visibleUpstreams: [] },
      { actorUserId: 2, isAdmin: false, visibleUserIds: [1, 2], visibleUpstreams: [] },
      { actorUserId: 2, isAdmin: false, visibleUserIds: [], visibleUpstreams: ['up-b'] },
    ]) {
      for (const groupBy of ['model', 'upstream', 'operation', 'runtimeLocation', 'userId', 'keyId'] as const) {
        for (const filters of [
          options.filters,
          { ...options.filters, models: ['model-a', 'model-b'], upstreams: ['up-b'] },
          { ...options.filters, userIds: [1], keyIds: ['key-1'] },
          { ...options.filters, operations: ['chat'], runtimeLocations: ['LOCAL'] },
          { ...options.filters, models: ['missing'] },
          {
            models: ['model-a'], upstreams: ['up-a'], userIds: [1], keyIds: ['key-1'],
            operations: ['chat'], runtimeLocations: ['SJC'],
          },
        ]) {
          const queryOptions = { ...options, ...actor, groupBy, bucketForHour, filters };
          expect(await sql.performance.queryOverview(queryOptions))
            .toEqual(await memory.performance.queryOverview(queryOptions));
        }
      }
    }
  }
  expect(await sql.performance.queryOverview({ ...options, actorUserId: 2, isAdmin: false }))
    .toEqual(await memory.performance.queryOverview({ ...options, actorUserId: 2, isAdmin: false }));
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
    visibleUserIds: [],
    visibleUpstreams: [],
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

it('SQL Performance overview stays within the D1 compound-select limit and returns aggregate cardinality', async () => {
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
    visibleUserIds: [],
    visibleUpstreams: [],
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
  const rawRows = await db.prepare('SELECT (SELECT COUNT(*) FROM performance_summary) + (SELECT COUNT(*) FROM performance_buckets) AS count')
    .first<{ count: number }>();
  expect(rawRows?.count).toBe(120);
  expect(aggregates).toHaveLength(1);
  expect(aggregate.resultCount).toBeLessThan(120);
  expect(overview.axes.none[0]).toMatchObject({ requests: 40, ttftSamples: 40, tpotSamples: 40 });
});

import { describe, expect, it } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { UpstreamMetricRecord } from '../../src/repo/types.ts';
import type { UpstreamMetricIdentity } from '@floway-dev/provider';

const point = (timestamp: number, value: number, identity: UpstreamMetricIdentity = { name: 'quota.remaining', labels: { quota: 'premium_interactions' } }): UpstreamMetricRecord => ({ upstreamId: 'up-1', ...identity, timestamp, value });

for (const [name, create] of [
  ['SQL', async () => new SqlRepo(await createSqliteTestDb())],
  ['memory', async () => new InMemoryRepo()],
] as const) {
  describe(`${name} upstream metrics gauges`, () => {
    it('restores complete gauge snapshots and clears them for replacement imports', async () => {
      const repo = (await create()).upstreamMetrics;
      await repo.set(point(70_000, 20));
      await repo.set(point(1_000, 20));
      await repo.set(point(70_000, 30));
      await repo.record(point(20_000, 25));
      expect(await repo.listAll()).toEqual([point(20_000, 25), point(70_000, 30)]);
      await repo.deleteAll();
      expect(await repo.query('up-1', 0, 90_000, 60_000)).toEqual([]);
    });

    it('keeps the latest observation per minute and preserves resets', async () => {
      const repo = (await create()).upstreamMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(20_000, 25));
      await repo.record(point(30_000, 26));
      await repo.record(point(60_000, 0));
      expect(await repo.query('up-1', 0, 90_000, 60_000)).toEqual([point(30_000, 26), point(60_000, 0)]);
    });

    it('stores Claude header and OAuth readings as one percent gauge per quota', async () => {
      const repo = (await create()).upstreamMetrics;
      const identity = { name: 'quota.utilization', labels: { quota: 'five_hour' } };
      await repo.record(point(1_000, 25, identity));
      await repo.record(point(20_000, 30, identity));
      expect(await repo.listAll()).toEqual([point(20_000, 30, identity)]);
    });

    it('records unchanged values and keeps the latest observation in each minute across delayed arrivals', async () => {
      const repo = (await create()).upstreamMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(61_000, 20));
      await repo.record(point(121_000, 30));
      await repo.record(point(80_000, 25));
      await repo.record(point(70_000, 24));
      await repo.record(point(121_000, 40, { name: 'quota.remaining', labels: { quota: 'future_metric' } }));
      await repo.record({ ...point(121_000, 90), upstreamId: 'up-2' });
      const records = await repo.listAll();
      expect(await repo.query('up-1', 0, 180_000, 60_000)).toHaveLength(4);
      expect(records).toHaveLength(5);
      expect(records.filter(record => record.upstreamId === 'up-1' && record.name === 'quota.remaining' && record.labels.quota === 'premium_interactions')).toEqual([point(1_000, 20), point(80_000, 25), point(121_000, 30)]);
    });

    it('retains a changed value when two observations share a capture timestamp', async () => {
      const repo = (await create()).upstreamMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(1_000, 25));
      expect(await repo.query('up-1', 0, 60_000, 60_000)).toEqual([point(1_000, 25)]);
    });

    it('returns only observations inside the half-open interval', async () => {
      const repo = (await create()).upstreamMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(61_000, 30));
      await repo.record(point(121_000, 40));
      await repo.record(point(181_000, 50));
      expect(await repo.query('up-1', 61_000, 181_000, 60_000)).toEqual([point(61_000, 30), point(121_000, 40)]);
      expect(await repo.query('up-1', 200_000, 300_000, 60_000)).toEqual([]);
    });

    it('downsamples each series to its latest sample per step counted from the interval start', async () => {
      const repo = (await create()).upstreamMetrics;
      const other = { name: 'quota.remaining', labels: { quota: 'chat' } };
      for (const [timestamp, value] of [[10_000, 1], [70_000, 2], [130_000, 3], [190_000, 4], [250_000, 5], [310_000, 6]] as const) {
        await repo.record(point(timestamp, value));
      }
      await repo.record(point(100_000, 7, other));
      await repo.record(point(200_000, 8, other));
      expect(await repo.query('up-1', 10_000, 320_000, 120_000)).toEqual([
        point(70_000, 2), point(100_000, 7, other), point(190_000, 4), point(200_000, 8, other), point(310_000, 6),
      ]);
    });
  });
}

it('shares per-minute coalescing and ordering across independent SQL repository instances', async () => {
  const db = await createSqliteTestDb();
  const first = new SqlRepo(db).upstreamMetrics;
  const second = new SqlRepo(db).upstreamMetrics;
  await Promise.all([first.record(point(1_000, 20)), second.record(point(20_000, 30))]);
  await first.record(point(10_000, 25));
  expect(await second.query('up-1', 0, 60_000, 60_000)).toEqual([point(20_000, 30)]);
});

it('declares JSON metric labels and stores canonical flat objects in SQLite', async () => {
  const db = await createSqliteTestDb();
  const { results } = await db.prepare('PRAGMA table_info(upstream_metrics)').all<{ name: string; type: string }>();
  expect(results.find(column => column.name === 'metric_labels')!.type).toBe('JSON');
  const repo = new SqlRepo(db).upstreamMetrics;
  await repo.set(point(1_000, 20, { name: 'quota.remaining', labels: { z: 'last', a: 'first' } }));
  expect(await repo.listAll()).toEqual([point(1_000, 20, { name: 'quota.remaining', labels: { a: 'first', z: 'last' } })]);
  for (const labels of [[], { nested: {} }, { missing: undefined }, { infinite: Infinity }]) {
    await expect(repo.set(point(61_000, 20, { name: 'invalid', labels } as never))).rejects.toThrow();
  }
});

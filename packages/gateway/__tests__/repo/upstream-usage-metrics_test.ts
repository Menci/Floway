import { describe, expect, it } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { UpstreamUsageMetricRecord } from '../../src/repo/types.ts';

const point = (timestamp: number, value: number, key = 'premium_interactions'): UpstreamUsageMetricRecord => ({ upstreamId: 'up-1', key, timestamp, value });

for (const [name, create] of [
  ['SQL', async () => new SqlRepo(await createSqliteTestDb())],
  ['memory', async () => new InMemoryRepo()],
] as const) {
  describe(`${name} upstream usage gauges`, () => {
    it('restores complete gauge snapshots and clears them for replacement imports', async () => {
      const repo = (await create()).upstreamUsageMetrics;
      await repo.set(point(70_000, 20));
      await repo.set(point(1_000, 20));
      await repo.set(point(70_000, 30));
      await repo.record(point(20_000, 25));
      expect(await repo.listAll()).toEqual([point(1_000, 20), point(70_000, 30)]);
      await repo.deleteAll();
      expect(await repo.query(0, 90_000)).toEqual([]);
    });

    it('coalesces changes to the latest observation per minute and preserves resets', async () => {
      const repo = (await create()).upstreamUsageMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(20_000, 25));
      await repo.record(point(30_000, 26));
      await repo.record(point(60_000, 0));
      expect(await repo.query(0, 90_000)).toEqual([point(30_000, 26), point(60_000, 0)]);
    });

    it('skips unchanged values and delayed observations without merging metric identities', async () => {
      const repo = (await create()).upstreamUsageMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(61_000, 20));
      await repo.record(point(121_000, 30));
      await repo.record(point(80_000, 25));
      await repo.record(point(121_000, 40, 'dynamic_quota'));
      await repo.record({ ...point(121_000, 90), upstreamId: 'up-2' });
      const records = await repo.query(0, 180_000);
      expect(records).toHaveLength(4);
      expect(records.filter(record => record.upstreamId === 'up-1' && record.key === 'premium_interactions')).toEqual([point(1_000, 20), point(121_000, 30)]);
    });

    it('retains a changed value when two observations share a capture timestamp', async () => {
      const repo = (await create()).upstreamUsageMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(1_000, 25));
      expect(await repo.query(0, 60_000)).toEqual([point(1_000, 25)]);
    });

    it('returns one baseline per identity and uses an exclusive end', async () => {
      const repo = (await create()).upstreamUsageMetrics;
      await repo.record(point(1_000, 20));
      await repo.record(point(61_000, 30));
      await repo.record(point(121_000, 40));
      await repo.record(point(181_000, 50));
      expect(await repo.query(100_000, 181_000)).toEqual([point(61_000, 30), point(121_000, 40)]);
      expect(await repo.query(200_000, 300_000)).toEqual([point(181_000, 50)]);
    });
  });
}

it('shares coalescing and deduplication across independent SQL repository instances', async () => {
  const db = await createSqliteTestDb();
  const first = new SqlRepo(db).upstreamUsageMetrics;
  const second = new SqlRepo(db).upstreamUsageMetrics;
  await Promise.all([first.record(point(1_000, 20)), second.record(point(20_000, 30))]);
  await first.record(point(10_000, 25));
  expect(await second.query(0, 60_000)).toEqual([point(20_000, 30)]);
});

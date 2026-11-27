import { describe, expect, it } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { UpstreamMetricRecord } from '../../src/repo/types.ts';
import type { UpstreamMetricIdentity } from '@floway-dev/upstream';

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

it('stores canonical flat metric label objects in SQLite', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreamMetrics;
  await repo.set(point(1_000, 20, { name: 'quota.remaining', labels: { z: 'last', a: 'first' } }));
  expect(await repo.listAll()).toEqual([point(1_000, 20, { name: 'quota.remaining', labels: { a: 'first', z: 'last' } })]);
  for (const labels of [[], { nested: {} }, { missing: undefined }, { infinite: Infinity }]) {
    await expect(repo.set(point(61_000, 20, { name: 'invalid', labels } as never))).rejects.toThrow();
  }
});

describe('SQL upstream metric resets', () => {
  it('finds every observed refill after depletion, independent of adjacent and future samples', async () => {
    const repo = (new SqlRepo(await createSqliteTestDb())).upstreamMetrics;
    const identity = { name: 'quota.utilization', labels: { quota: 'five_hour' } };
    const other = { name: 'quota.remaining_percent', labels: { window: 'weekly' } };
    const before = 600_000;
    for (const [minute, value] of [[0, 0], [1, 10], [2, 0], [3, 0], [4, 70], [5, 5], [6, 0], [7, 40], [8, 0], [9, 20], [10, 0]] as const) {
      await repo.record(point(minute * 60_000, value, identity));
    }
    await repo.record(point(61_000, 25, other));
    await repo.record(point(541_000, 100, other));
    await repo.record({ ...point(540_000, 0, identity), upstreamId: 'up-2' });
    await repo.record(point(before, 25, { name: 'future', labels: {} }));
    expect(await repo.listIdentities('up-1', before)).toEqual([other, identity]);
    expect(await repo.queryResetStarts('up-1', identity, { direction: 'used', full: 0 }, before)).toEqual([480_000, 360_000, 120_000]);
    expect(await repo.queryResetStarts('up-1', other, { direction: 'remaining', full: 100 }, before)).toEqual([541_000]);
  });

  it('requires a contemporaneous positive allowance and an actual refill for absolute balances', async () => {
    const repo = (new SqlRepo(await createSqliteTestDb())).upstreamMetrics;
    const balance = { name: 'quota.remaining', labels: { quota: 'premium_interactions' } };
    const allowance = { name: 'quota.entitlement', labels: balance.labels };
    for (const [index, [remaining, full]] of ([[40, 100], [40, 40], [20, null], [100, 100], [70, 100], [100, 100], [0, 0]] as const).entries()) {
      const time = index * 60_000;
      await repo.record(point(time, remaining, balance));
      if (full !== null) await repo.record(point(time, full, allowance));
    }
    expect(await repo.queryResetStarts('up-1', balance, { direction: 'remaining', full: allowance }, 600_000)).toEqual([300_000]);
  });
});

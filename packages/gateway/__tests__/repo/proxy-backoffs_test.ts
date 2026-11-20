import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';
import { buildCustomUpstreamRecord } from '../test-utils/app.ts';

// The geometric backoff schedule and the per-(proxy, upstream) row state
// are spec'd identically across both backends — but the SQL impl reaches
// the schedule through SQLite's UPDATE eval-order ('reads RHS column refs
// at the start of the UPDATE, before the increment is applied'), so the
// memory-only test would never have caught a drift between the JS mirror
// and the SQL expression. Run the suite against both backends.
const REPO_BACKENDS: Array<readonly [string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

const seedPair = async (repo: Repo, proxyId: string, upstreamId: string): Promise<void> => {
  if (await repo.proxies.getById(proxyId) === null) {
    await repo.proxies.insert({ id: proxyId, name: proxyId, url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });
  }
  if (await repo.upstreams.getById(upstreamId) === null) {
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: upstreamId, proxyFallbackList: [] }));
  }
};

for (const [backend, makeRepo] of REPO_BACKENDS) {
  describe(`[${backend}] proxy_upstream_backoffs repo`, () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    const baseUnix = Math.floor(Date.UTC(2026, 5, 1) / 1000);

    it('exponentially backs off and caps at 1h', async () => {
      const repo = await makeRepo();
      await seedPair(repo, 'p', 'u');
      const expected = [60, 120, 240, 480, 960, 1920, 3600, 3600];
      for (let n = 0; n < expected.length; n++) {
        await repo.proxyBackoffs.recordDialFailure('p', 'u', `failure ${n + 1}`);
        const [row] = await repo.proxyBackoffs.listForUpstream('u');
        expect(row!.failCount).toBe(n + 1);
        expect(row!.expiresAt - baseUnix).toBe(expected[n]);
      }
    });

    it('clears the row on dial success', async () => {
      const repo = await makeRepo();
      await seedPair(repo, 'p', 'u');
      await repo.proxyBackoffs.recordDialFailure('p', 'u', 'x');
      await repo.proxyBackoffs.recordDialSuccess('p', 'u');
      expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
    });

    it('rejects a row whose proxy or upstream does not exist', async () => {
      const repo = await makeRepo();
      await seedPair(repo, 'p', 'u');
      await expect(repo.proxyBackoffs.recordDialFailure('p', 'u_missing', 'x')).rejects.toThrow(/FOREIGN KEY constraint failed/);
      await expect(repo.proxyBackoffs.recordDialFailure('p_missing', 'u', 'x')).rejects.toThrow(/FOREIGN KEY constraint failed/);
      expect(await repo.proxyBackoffs.listAll()).toEqual([]);
    });

    it('drops rows with the proxy or upstream they reference', async () => {
      const repo = await makeRepo();
      for (const [proxyId, upstreamId] of [['p1', 'u1'], ['p1', 'u2'], ['p2', 'u1'], ['p2', 'u2']] as const) {
        await seedPair(repo, proxyId, upstreamId);
        await repo.proxyBackoffs.recordDialFailure(proxyId, upstreamId, 'x');
      }

      await repo.upstreams.delete('u1');
      await repo.proxies.delete('p1');

      expect((await repo.proxyBackoffs.listAll()).map(row => `${row.proxyId}/${row.upstreamId}`)).toEqual(['p2/u2']);
    });
  });
}

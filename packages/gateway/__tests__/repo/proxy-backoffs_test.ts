import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';

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

for (const [backend, makeRepo] of REPO_BACKENDS) {

  describe(`[${backend}] proxy_upstream_backoffs repo`, () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    const baseUnix = Math.floor(Date.UTC(2026, 5, 1) / 1000);

    it('records first failure with 60s expiry', async () => {
      const repo = await makeRepo();
      await repo.proxyBackoffs.recordDialFailure('p', 'u', 'tcp refused');
      const rows = await repo.proxyBackoffs.listForUpstream('u');
      expect(rows).toEqual([
        {
          proxyId: 'p',
          upstreamId: 'u',
          failCount: 1,
          expiresAt: baseUnix + 60,
          lastError: 'tcp refused',
          lastErrorAt: baseUnix,
        },
      ]);
    });

    it('exponentially backs off and caps at 1h', async () => {
      const repo = await makeRepo();
      const expected = [60, 120, 240, 480, 960, 1920, 3600, 3600];
      for (let n = 0; n < expected.length; n++) {
        await repo.proxyBackoffs.recordDialFailure('p', 'u', `failure ${n + 1}`);
        const [row] = await repo.proxyBackoffs.listForUpstream('u');
        expect(row!.failCount).toBe(n + 1);
        expect(row!.expiresAt - baseUnix).toBe(expected[n]);
      }
    });

    it('saturates at 3600s once fail_count climbs past the exponent clamp (no JS shift overflow)', async () => {
      const repo = await makeRepo();
      // Push fail_count well past the exponent clamp at 6 — both backends
      // saturate the schedule at 3600s regardless of how high fail_count
      // climbs, with no JS 32-bit shift surprise creeping back in.
      for (let n = 0; n < 50; n++) {
        await repo.proxyBackoffs.recordDialFailure('p', 'u', `failure ${n + 1}`);
      }
      const [row] = await repo.proxyBackoffs.listForUpstream('u');
      expect(row!.failCount).toBe(50);
      expect(row!.expiresAt - baseUnix).toBe(3600);
    });

    it('clears the row on dial success', async () => {
      const repo = await makeRepo();
      await repo.proxyBackoffs.recordDialFailure('p', 'u', 'x');
      await repo.proxyBackoffs.recordDialSuccess('p', 'u');
      expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
    });

    it('isolates state between upstreams', async () => {
      const repo = await makeRepo();
      await repo.proxyBackoffs.recordDialFailure('p', 'uA', 'x');
      expect(await repo.proxyBackoffs.listForUpstream('uB')).toEqual([]);
      expect(await repo.proxyBackoffs.listForUpstream('uA')).toHaveLength(1);
    });

    it('reset removes all rows for the proxy', async () => {
      const repo = await makeRepo();
      await repo.proxyBackoffs.recordDialFailure('p', 'u1', 'x');
      await repo.proxyBackoffs.recordDialFailure('p', 'u2', 'x');
      await repo.proxyBackoffs.resetForProxy('p');
      expect(await repo.proxyBackoffs.listForProxy('p')).toEqual([]);
    });

    it('reset for a single (proxy, upstream)', async () => {
      const repo = await makeRepo();
      await repo.proxyBackoffs.recordDialFailure('p', 'u1', 'x');
      await repo.proxyBackoffs.recordDialFailure('p', 'u2', 'x');
      await repo.proxyBackoffs.reset('p', 'u1');
      const ids = (await repo.proxyBackoffs.listForProxy('p')).map(r => r.upstreamId);
      expect(ids).toEqual(['u2']);
    });

    it('resetForUpstream removes every row scoped to the upstream', async () => {
      const repo = await makeRepo();
      await repo.proxyBackoffs.recordDialFailure('pA', 'u1', 'x');
      await repo.proxyBackoffs.recordDialFailure('pB', 'u1', 'x');
      await repo.proxyBackoffs.recordDialFailure('pA', 'u2', 'x');
      await repo.proxyBackoffs.resetForUpstream('u1');
      expect(await repo.proxyBackoffs.listForUpstream('u1')).toEqual([]);
      expect((await repo.proxyBackoffs.listForUpstream('u2')).length).toBe(1);
    });

    it('listAll returns every row', async () => {
      const repo = await makeRepo();
      await repo.proxyBackoffs.recordDialFailure('p1', 'u1', 'x');
      await repo.proxyBackoffs.recordDialFailure('p2', 'u2', 'x');
      expect(await repo.proxyBackoffs.listAll()).toHaveLength(2);
    });
  });

}

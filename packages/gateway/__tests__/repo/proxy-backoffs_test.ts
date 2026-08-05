import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from './test-sqlite.ts';
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

const proxyUrl = (id: string): string => `socks5://${id}.example.test:1080`;

const insertProxy = async (repo: Repo, id: string): Promise<void> => {
  await repo.proxies.insert({ id, name: id, url: proxyUrl(id), dialTimeoutSeconds: null });
};

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
      await insertProxy(repo, 'p');
      await repo.proxyBackoffs.recordDialFailure('p', 'u', proxyUrl('p'), 'tcp refused');
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

    it('ignores outcomes from a stale proxy URL generation', async () => {
      const repo = await makeRepo();
      const oldUrl = proxyUrl('p');
      const newUrl = 'socks5://replacement.example.test:1080';
      await insertProxy(repo, 'p');
      expect(await repo.proxyBackoffs.recordDialFailure('p', 'u', oldUrl, 'old failure')).toBe(true);

      await repo.proxies.patch('p', { url: newUrl });
      expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
      expect(await repo.proxyBackoffs.recordDialFailure('p', 'u', oldUrl, 'late old failure')).toBe(false);
      expect(await repo.proxyBackoffs.recordDialFailure('p', 'u', newUrl, 'new failure')).toBe(true);
      expect((await repo.proxyBackoffs.listForUpstream('u'))[0]?.failCount).toBe(1);

      expect(await repo.proxyBackoffs.recordDialSuccess('p', 'u', oldUrl)).toBe(false);
      expect(await repo.proxyBackoffs.listForUpstream('u')).toHaveLength(1);
      expect(await repo.proxyBackoffs.recordDialSuccess('p', 'u', newUrl)).toBe(true);
      expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
    });

    it('cascades proxy deletion and rejects a late orphan outcome', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      await repo.proxyBackoffs.recordDialFailure('p', 'u', proxyUrl('p'), 'failure');

      expect(await repo.proxies.delete('p')).toBe(true);
      expect(await repo.proxyBackoffs.listAll()).toEqual([]);
      expect(await repo.proxyBackoffs.recordDialFailure('p', 'u', proxyUrl('p'), 'late failure')).toBe(false);
      expect(await repo.proxyBackoffs.listAll()).toEqual([]);
    });

    it('exponentially backs off and caps at 1h', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      const expected = [60, 120, 240, 480, 960, 1920, 3600, 3600];
      for (let n = 0; n < expected.length; n++) {
        await repo.proxyBackoffs.recordDialFailure('p', 'u', proxyUrl('p'), `failure ${n + 1}`);
        const [row] = await repo.proxyBackoffs.listForUpstream('u');
        expect(row!.failCount).toBe(n + 1);
        expect(row!.expiresAt - baseUnix).toBe(expected[n]);
      }
    });

    it('saturates at 3600s once fail_count climbs past the exponent clamp (no JS shift overflow)', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      // Push fail_count well past the exponent clamp at 6 — both backends
      // saturate the schedule at 3600s regardless of how high fail_count
      // climbs, with no JS 32-bit shift surprise creeping back in.
      for (let n = 0; n < 50; n++) {
        await repo.proxyBackoffs.recordDialFailure('p', 'u', proxyUrl('p'), `failure ${n + 1}`);
      }
      const [row] = await repo.proxyBackoffs.listForUpstream('u');
      expect(row!.failCount).toBe(50);
      expect(row!.expiresAt - baseUnix).toBe(3600);
    });

    it('clears the row on dial success', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      await repo.proxyBackoffs.recordDialFailure('p', 'u', proxyUrl('p'), 'x');
      await repo.proxyBackoffs.recordDialSuccess('p', 'u', proxyUrl('p'));
      expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
    });

    it('isolates state between upstreams', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      await repo.proxyBackoffs.recordDialFailure('p', 'uA', proxyUrl('p'), 'x');
      expect(await repo.proxyBackoffs.listForUpstream('uB')).toEqual([]);
      expect(await repo.proxyBackoffs.listForUpstream('uA')).toHaveLength(1);
    });

    it('reset removes all rows for the proxy', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      await repo.proxyBackoffs.recordDialFailure('p', 'u1', proxyUrl('p'), 'x');
      await repo.proxyBackoffs.recordDialFailure('p', 'u2', proxyUrl('p'), 'x');
      await repo.proxyBackoffs.resetForProxy('p');
      expect(await repo.proxyBackoffs.listForProxy('p')).toEqual([]);
    });

    it('reset for a single (proxy, upstream)', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      await repo.proxyBackoffs.recordDialFailure('p', 'u1', proxyUrl('p'), 'x');
      await repo.proxyBackoffs.recordDialFailure('p', 'u2', proxyUrl('p'), 'x');
      await repo.proxyBackoffs.reset('p', 'u1');
      const ids = (await repo.proxyBackoffs.listForProxy('p')).map(r => r.upstreamId);
      expect(ids).toEqual(['u2']);
    });

    it('resetForUpstream removes every row scoped to the upstream', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'pA');
      await insertProxy(repo, 'pB');
      await repo.proxyBackoffs.recordDialFailure('pA', 'u1', proxyUrl('pA'), 'x');
      await repo.proxyBackoffs.recordDialFailure('pB', 'u1', proxyUrl('pB'), 'x');
      await repo.proxyBackoffs.recordDialFailure('pA', 'u2', proxyUrl('pA'), 'x');
      await repo.proxyBackoffs.resetForUpstream('u1');
      expect(await repo.proxyBackoffs.listForUpstream('u1')).toEqual([]);
      expect((await repo.proxyBackoffs.listForUpstream('u2')).length).toBe(1);
    });

    it('listAll returns every row', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p1');
      await insertProxy(repo, 'p2');
      await repo.proxyBackoffs.recordDialFailure('p1', 'u1', proxyUrl('p1'), 'x');
      await repo.proxyBackoffs.recordDialFailure('p2', 'u2', proxyUrl('p2'), 'x');
      expect(await repo.proxyBackoffs.listAll()).toHaveLength(2);
    });
  });

}

it('proxy backoff generation migration carries current rows and drops existing orphans', async () => {
  const db = await createSqlJsDatabase();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0077_proxy_backoff_generation.sql') break;
    db.run(sql);
  }
  db.run(
    `INSERT INTO proxies (id, name, url, dial_timeout_seconds, created_at, updated_at)
     VALUES ('p', 'Proxy', '${proxyUrl('p')}', NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
  );
  db.run(
    `INSERT INTO proxy_upstream_backoffs
       (proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at)
     VALUES
       ('p', 'u', 3, 1234, 'current', 1200),
       ('missing', 'u', 2, 1234, 'orphan', 1200)`,
  );

  const migration = migrationSqlByFilename.find(([filename]) => filename === '0077_proxy_backoff_generation.sql')?.[1];
  if (migration === undefined) throw new Error('missing proxy backoff generation migration');
  db.run(migration);

  const repo = new SqlRepo(wrapSqlJsDatabase(db));
  expect(await repo.proxyBackoffs.listAll()).toEqual([{
    proxyId: 'p',
    upstreamId: 'u',
    failCount: 3,
    expiresAt: 1234,
    lastError: 'current',
    lastErrorAt: 1200,
  }]);
  expect(db.exec('SELECT proxy_url FROM proxy_upstream_backoffs')[0]?.values).toEqual([[proxyUrl('p')]]);
});

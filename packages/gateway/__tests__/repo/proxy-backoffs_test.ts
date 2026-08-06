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
const sharedSqlRepo = createSqliteTestDb().then(db => new SqlRepo(db));

const resetSharedSqlRepo = async (): Promise<Repo> => {
  const repo = await sharedSqlRepo;
  await repo.proxyBackoffs.deleteAll();
  await repo.proxies.deleteAll();
  return repo;
};

const REPO_BACKENDS: Array<readonly [string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  // Cases in this file are sequential. Reusing the migrated database while
  // clearing both owned tables preserves isolation without replaying the full
  // migration corpus for every small repository assertion.
  ['sql', resetSharedSqlRepo],
];

const proxyUrl = (id: string): string => `socks5://${id}.example.test:1080`;

const insertProxy = async (repo: Repo, id: string): Promise<void> => {
  await repo.proxies.insert({ id, name: id, url: proxyUrl(id), dialTimeoutSeconds: null });
};

const proxyRevision = async (repo: Repo, id: string): Promise<number> => {
  const proxy = await repo.proxies.getById(id);
  if (proxy === null) throw new Error(`missing proxy ${id}`);
  return proxy.revision;
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
      await repo.proxyBackoffs.recordDialFailure('p', 'u', await proxyRevision(repo, 'p'), 'tcp refused');
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

    it('rejects stale outcomes after the URL returns to its original value', async () => {
      const repo = await makeRepo();
      const oldUrl = proxyUrl('p');
      const newUrl = 'socks5://replacement.example.test:1080';
      await insertProxy(repo, 'p');
      const oldRevision = await proxyRevision(repo, 'p');
      expect(await repo.proxyBackoffs.recordDialFailure('p', 'u', oldRevision, 'old failure')).toBe(true);

      await repo.proxies.patch('p', { url: newUrl });
      expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
      await repo.proxies.patch('p', { url: oldUrl });
      const currentRevision = await proxyRevision(repo, 'p');
      expect(currentRevision).toBe(oldRevision + 2);
      expect(await repo.proxyBackoffs.recordDialFailure('p', 'u', oldRevision, 'late old failure')).toBe(false);
      expect(await repo.proxyBackoffs.recordDialFailure('p', 'u', currentRevision, 'new failure')).toBe(true);
      expect((await repo.proxyBackoffs.listForUpstream('u'))[0]?.failCount).toBe(1);

      expect(await repo.proxyBackoffs.recordDialSuccess('p', 'u', oldRevision)).toBe(false);
      expect(await repo.proxyBackoffs.listForUpstream('u')).toHaveLength(1);
      expect(await repo.proxyBackoffs.recordDialSuccess('p', 'u', currentRevision)).toBe(true);
      expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
    });

    it('never reuses a revision after deleting and recreating the same proxy id', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      const oldRevision = await proxyRevision(repo, 'p');

      expect(await repo.proxies.delete('p')).toBe(true);
      await insertProxy(repo, 'p');
      const recreatedRevision = await proxyRevision(repo, 'p');

      expect(recreatedRevision).toBeGreaterThan(oldRevision);
      expect(await repo.proxyBackoffs.recordDialFailure('p', 'u', oldRevision, 'late old failure')).toBe(false);
      expect(await repo.proxyBackoffs.recordDialFailure('p', 'u', recreatedRevision, 'new failure')).toBe(true);
      expect((await repo.proxyBackoffs.listForUpstream('u'))[0]?.lastError).toBe('new failure');
    });

    it('changes revision when dial timeout changes but not for metadata-only edits', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      const initial = await proxyRevision(repo, 'p');

      await repo.proxies.patch('p', { name: 'renamed' });
      expect(await proxyRevision(repo, 'p')).toBe(initial);

      await repo.proxies.patch('p', { dialTimeoutSeconds: 30 });
      expect(await proxyRevision(repo, 'p')).toBeGreaterThan(initial);
    });

    it('cascades proxy deletion and rejects a late orphan outcome', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      const revision = await proxyRevision(repo, 'p');
      await repo.proxyBackoffs.recordDialFailure('p', 'u', revision, 'failure');

      expect(await repo.proxies.delete('p')).toBe(true);
      expect(await repo.proxyBackoffs.listAll()).toEqual([]);
      expect(await repo.proxyBackoffs.recordDialFailure('p', 'u', revision, 'late failure')).toBe(false);
      expect(await repo.proxyBackoffs.listAll()).toEqual([]);
    });

    it('exponentially backs off and caps at 1h', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      const expected = [60, 120, 240, 480, 960, 1920, 3600, 3600];
      for (let n = 0; n < expected.length; n++) {
        await repo.proxyBackoffs.recordDialFailure('p', 'u', await proxyRevision(repo, 'p'), `failure ${n + 1}`);
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
        await repo.proxyBackoffs.recordDialFailure('p', 'u', await proxyRevision(repo, 'p'), `failure ${n + 1}`);
      }
      const [row] = await repo.proxyBackoffs.listForUpstream('u');
      expect(row!.failCount).toBe(50);
      expect(row!.expiresAt - baseUnix).toBe(3600);
    });

    it('clears the row on dial success', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      const revision = await proxyRevision(repo, 'p');
      await repo.proxyBackoffs.recordDialFailure('p', 'u', revision, 'x');
      await repo.proxyBackoffs.recordDialSuccess('p', 'u', revision);
      expect(await repo.proxyBackoffs.listForUpstream('u')).toEqual([]);
    });

    it('isolates state between upstreams', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      await repo.proxyBackoffs.recordDialFailure('p', 'uA', await proxyRevision(repo, 'p'), 'x');
      expect(await repo.proxyBackoffs.listForUpstream('uB')).toEqual([]);
      expect(await repo.proxyBackoffs.listForUpstream('uA')).toHaveLength(1);
    });

    it('reset removes all rows for the proxy', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      const revision = await proxyRevision(repo, 'p');
      await repo.proxyBackoffs.recordDialFailure('p', 'u1', revision, 'x');
      await repo.proxyBackoffs.recordDialFailure('p', 'u2', revision, 'x');
      await repo.proxyBackoffs.resetForProxy('p');
      expect(await repo.proxyBackoffs.listForProxy('p')).toEqual([]);
    });

    it('reset for a single (proxy, upstream)', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p');
      const revision = await proxyRevision(repo, 'p');
      await repo.proxyBackoffs.recordDialFailure('p', 'u1', revision, 'x');
      await repo.proxyBackoffs.recordDialFailure('p', 'u2', revision, 'x');
      await repo.proxyBackoffs.reset('p', 'u1');
      const ids = (await repo.proxyBackoffs.listForProxy('p')).map(r => r.upstreamId);
      expect(ids).toEqual(['u2']);
    });

    it('resetForUpstream removes every row scoped to the upstream', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'pA');
      await insertProxy(repo, 'pB');
      await repo.proxyBackoffs.recordDialFailure('pA', 'u1', await proxyRevision(repo, 'pA'), 'x');
      await repo.proxyBackoffs.recordDialFailure('pB', 'u1', await proxyRevision(repo, 'pB'), 'x');
      await repo.proxyBackoffs.recordDialFailure('pA', 'u2', await proxyRevision(repo, 'pA'), 'x');
      await repo.proxyBackoffs.resetForUpstream('u1');
      expect(await repo.proxyBackoffs.listForUpstream('u1')).toEqual([]);
      expect((await repo.proxyBackoffs.listForUpstream('u2')).length).toBe(1);
    });

    it('listAll returns every row', async () => {
      const repo = await makeRepo();
      await insertProxy(repo, 'p1');
      await insertProxy(repo, 'p2');
      await repo.proxyBackoffs.recordDialFailure('p1', 'u1', await proxyRevision(repo, 'p1'), 'x');
      await repo.proxyBackoffs.recordDialFailure('p2', 'u2', await proxyRevision(repo, 'p2'), 'x');
      expect(await repo.proxyBackoffs.listAll()).toHaveLength(2);
    });
  });

}

it('stores one bounded revision per backoff even when the proxy URL is very large', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  await repo.proxies.insert({
    id: 'p_large',
    name: 'Large',
    url: `socks5://${'a'.repeat(1_000_000)}`,
    dialTimeoutSeconds: null,
  });
  const revision = await proxyRevision(repo, 'p_large');
  for (let index = 0; index < 100; index++) {
    await repo.proxyBackoffs.recordDialFailure('p_large', `up_${index}`, revision, 'failure');
  }

  const storage = await db.prepare(
    `SELECT COUNT(*) AS row_count,
            SUM(LENGTH(CAST(proxy_revision AS TEXT))) AS revision_bytes
     FROM proxy_upstream_backoffs`,
  ).first<{ row_count: number; revision_bytes: number }>();
  expect(storage).not.toBeNull();
  expect(storage!.row_count).toBe(100);
  expect(storage!.revision_bytes).toBeLessThanOrEqual(1_600);
});

it('rolls back a proxy config edit when the bounded SQL revision clock is exhausted', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  const original = await repo.proxies.insert({
    id: 'p_exhausted',
    name: 'Exhausted',
    url: proxyUrl('old'),
    dialTimeoutSeconds: null,
  });
  await db.prepare('UPDATE proxy_revision_counter SET revision = ? WHERE singleton = 1')
    .bind(Number.MAX_SAFE_INTEGER)
    .run();

  await expect(repo.proxies.patch('p_exhausted', { url: proxyUrl('new') })).rejects.toThrow();
  expect(await repo.proxies.getById('p_exhausted')).toEqual(original);
});

it('proxy backoff generation migration carries current rows and drops existing orphans', async () => {
  const db = await createSqlJsDatabase();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === '0079_proxy_backoff_generation.sql') break;
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

  const migration = migrationSqlByFilename.find(([filename]) => filename === '0079_proxy_backoff_generation.sql')?.[1];
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
  const columns = db.exec("SELECT name, type FROM pragma_table_info('proxy_upstream_backoffs')")[0];
  expect(columns.values).toContainEqual(['proxy_revision', 'INTEGER']);
  expect(columns.values.some(([name]) => name === 'proxy_url')).toBe(false);
  expect(db.exec('SELECT proxy_revision FROM proxy_upstream_backoffs')[0]?.values).toEqual([[1]]);
  expect(() => db.run('UPDATE proxies SET revision = 1.5 WHERE id = \'p\'')).toThrow();
  expect(() => db.run('UPDATE proxy_upstream_backoffs SET proxy_revision = 1.5')).toThrow();
});

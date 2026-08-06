import { expect, test, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';
import type { SqlBindValue, SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';
import type { ProxyFallbackEntry, UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

// Both backends must agree on the proxies repo contract.
// Memory drives the unit tests by default, but the production deployments
// run on D1 and node:sqlite — running the same scenarios against SqlRepo
// (with sql.js applying every migration) is what catches schema drift,
// SQLite-specific eval-order assumptions, and missing column wiring.
const sharedSqlRepo = createSqliteTestDb().then(db => new SqlRepo(db));

const resetSharedSqlRepo = async (): Promise<Repo> => {
  const repo = await sharedSqlRepo;
  await repo.proxyBackoffs.deleteAll();
  await repo.upstreams.deleteAll();
  await repo.proxies.deleteAll();
  return repo;
};

const REPO_BACKENDS: Array<readonly [string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', resetSharedSqlRepo],
];

const upstreamFixture = (id: string, proxyFallbackList: ProxyFallbackEntry[]): UpstreamRecord => ({
  id,
  kind: 'custom',
  name: id,
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  config: { baseUrl: 'https://example.test', authStyle: 'bearer', apiKey: 'sk', endpoints: { chatCompletions: {} } },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList,
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

for (const [backend, makeRepo] of REPO_BACKENDS) {

  test(`[${backend}] proxies repo inserts and lists ordered by createdAt`, async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
      const repo = await makeRepo();
      await repo.proxies.insert({ id: 'a', name: 'A', url: 'socks5://host-a:1080', dialTimeoutSeconds: null });
      vi.advanceTimersByTime(1);
      await repo.proxies.insert({ id: 'b', name: 'B', url: 'socks5://host-b:1080', dialTimeoutSeconds: null });
      const list = await repo.proxies.list();
      assertEquals(list.map(p => p.id), ['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  test(`[${backend}] proxies repo findUpstreamsReferencing returns ids of upstreams whose fallback list contains the proxy`, async () => {
    const repo = await makeRepo();
    await repo.proxies.insert({ id: 'p', name: 'P', url: 'socks5://host:1080', dialTimeoutSeconds: null });
    await repo.upstreams.save(upstreamFixture('up_1', [{ id: 'p' }, { id: 'direct_fetch' }]));
    await repo.upstreams.save(upstreamFixture('up_2', [{ id: 'direct_fetch' }, { id: 'p' }]));
    await repo.upstreams.save(upstreamFixture('up_3', [{ id: 'direct_fetch' }]));

    const ids = (await repo.proxies.findUpstreamsReferencing('p')).toSorted();
    assertEquals(ids, ['up_1', 'up_2']);
  });

  test(`[${backend}] proxies repo delete returns false when id is unknown`, async () => {
    const repo = await makeRepo();
    assertEquals(await repo.proxies.delete('nope'), false);
  });

  test(`[${backend}] proxies repo delete returns true and removes the row`, async () => {
    const repo = await makeRepo();
    await repo.proxies.insert({ id: 'a', name: 'A', url: 'socks5://host:1080', dialTimeoutSeconds: null });
    assertEquals(await repo.proxies.delete('a'), true);
    assertEquals(await repo.proxies.getById('a'), null);
  });

  test(`[${backend}] proxies repo delete atomically refuses a referenced row`, async () => {
    const repo = await makeRepo();
    await repo.proxies.insert({ id: 'a', name: 'A', url: 'socks5://host:1080', dialTimeoutSeconds: null });
    await repo.upstreams.save(upstreamFixture('up', [{ id: 'a' }]));

    assertEquals(await repo.proxies.delete('a'), false);
    expect(await repo.proxies.getById('a')).not.toBeNull();
  });

  test(`[${backend}] upstream writes cannot reference a proxy after its deletion wins`, async () => {
    const repo = await makeRepo();
    await repo.proxies.insert({ id: 'a', name: 'A', url: 'socks5://host:1080', dialTimeoutSeconds: null });
    await repo.upstreams.save(upstreamFixture('up', []));
    const generation = (await repo.upstreams.getById('up'))!.updatedAt;

    assertEquals(await repo.proxies.delete('a'), true);
    assertEquals(await repo.upstreams.updateFields('up', 'custom', {
      proxyFallbackList: [{ id: 'a' }],
      updatedAt: '2026-06-01T00:00:01.000Z',
    }, { expectedUpdatedAt: generation }), null);
    assertEquals((await repo.upstreams.getById('up'))?.proxyFallbackList, []);
  });

  test(`[${backend}] proxies repo patch returns null for unknown id`, async () => {
    const repo = await makeRepo();
    assertEquals(await repo.proxies.patch('nope', { name: 'x' }), null);
  });

  test(`[${backend}] concurrent partial patches preserve one another`, async () => {
    const repo = await makeRepo();
    await repo.proxies.insert({ id: 'a', name: 'Old', url: 'socks5://host:1080', dialTimeoutSeconds: null });

    await Promise.all([
      repo.proxies.patch('a', { name: 'New' }),
      repo.proxies.patch('a', { dialTimeoutSeconds: 30 }),
    ]);

    expect(await repo.proxies.getById('a')).toMatchObject({
      name: 'New',
      url: 'socks5://host:1080',
      dialTimeoutSeconds: 30,
    });
  });

  test(`[${backend}] proxies repo save inserts a new row with createdAt and updatedAt set to now`, async () => {
    const repo = await makeRepo();
    await repo.proxies.save({ id: 'a', name: 'A', url: 'socks5://host:1080', dialTimeoutSeconds: 30 });
    const row = await repo.proxies.getById('a');
    assertEquals(row?.name, 'A');
    assertEquals(row?.url, 'socks5://host:1080');
    assertEquals(row?.dialTimeoutSeconds, 30);
    assertEquals(typeof row?.createdAt, 'string');
    assertEquals(row?.createdAt, row?.updatedAt);
  });

  test(`[${backend}] proxies repo save on id collision preserves createdAt while overwriting config`, async () => {
    const repo = await makeRepo();
    await repo.proxies.insert({ id: 'a', name: 'Old', url: 'socks5://host-a:1080', dialTimeoutSeconds: null });
    const before = await repo.proxies.getById('a');
    const originalCreatedAt = before?.createdAt;
    if (!originalCreatedAt) throw new Error('expected createdAt to be populated');

    await repo.proxies.save({ id: 'a', name: 'New', url: 'http://host-b:3128', dialTimeoutSeconds: 60 });

    const after = await repo.proxies.getById('a');
    assertEquals(after?.name, 'New');
    assertEquals(after?.url, 'http://host-b:3128');
    assertEquals(after?.dialTimeoutSeconds, 60);
    assertEquals(after?.createdAt, originalCreatedAt);
  });

  test(`[${backend}] proxies repo rejects lossy UTF-16 ids and preserves a valid surrogate pair`, async () => {
    const repo = await makeRepo();
    for (const id of ['proxy\uD800', 'proxy\uDC00']) {
      await expect(Promise.resolve().then(async () => await repo.proxies.save({
        id,
        name: 'Invalid',
        url: 'socks5://invalid.example.test:1080',
        dialTimeoutSeconds: null,
      }))).rejects.toThrow('unpaired UTF-16 surrogates');
    }

    const id = 'proxy-\uD83D\uDE00';
    await repo.proxies.save({ id, name: 'Valid', url: 'socks5://valid.example.test:1080', dialTimeoutSeconds: null });
    expect(await repo.proxies.getById(id)).toMatchObject({ id, name: 'Valid' });
  });

  test(`[${backend}] proxies repo deleteAll drops every row`, async () => {
    const repo = await makeRepo();
    await repo.proxies.insert({ id: 'a', name: 'A', url: 'socks5://host-a:1080', dialTimeoutSeconds: null });
    await repo.proxies.insert({ id: 'b', name: 'B', url: 'socks5://host-b:1080', dialTimeoutSeconds: null });
    await repo.proxies.deleteAll();
    assertEquals(await repo.proxies.list(), []);
  });

}

// Model a row that is visible to a pre-read but gone by the write boundary.
// A read/modify/write implementation manufactures a success from the SELECT;
// an atomic UPDATE ... RETURNING observes the deletion and returns no row.
class VanishingProxyStatement implements SqlPreparedStatement {
  constructor(
    private readonly query: string,
    private readonly bound: readonly SqlBindValue[] = [],
  ) {}

  bind(...values: SqlBindValue[]): SqlPreparedStatement {
    return new VanishingProxyStatement(this.query, values);
  }

  first<T>(): Promise<T | null> {
    if (this.query.startsWith('SELECT id, name, url')) {
      return Promise.resolve({
        id: String(this.bound[0]),
        name: 'Old',
        url: 'socks5://host:1080',
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
        dial_timeout_seconds: null,
      } as T);
    }
    if (this.query.startsWith('UPDATE proxies')) return Promise.resolve(null);
    throw new Error(`unexpected first query: ${this.query}`);
  }

  all<T>(): Promise<SqlResult<T>> {
    throw new Error(`unexpected all query: ${this.query}`);
  }

  run(): Promise<SqlResult> {
    if (this.query.startsWith('UPDATE proxies')) {
      return Promise.resolve({ results: [], success: true, meta: { changes: 0 } });
    }
    throw new Error(`unexpected run query: ${this.query}`);
  }
}

test('SQL proxy patch returns null when the row disappears at the write boundary', async () => {
  const db: SqlDatabase = {
    prepare: query => new VanishingProxyStatement(query),
    exec: async () => undefined,
  };
  const repo = new SqlRepo(db);

  expect(await repo.proxies.patch('a', { name: 'New' })).toBeNull();
});

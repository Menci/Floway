import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type { Repo } from './types.ts';
import type { ProxyFallbackEntry, UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

// Both backends must agree on the proxies repo contract.
// Memory drives the unit tests by default, but the production deployments
// run on D1 and node:sqlite — running the same scenarios against SqlRepo
// (with sql.js applying every migration) is what catches schema drift,
// SQLite-specific eval-order assumptions, and missing column wiring.
const REPO_BACKENDS: Array<readonly [string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
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
});

for (const [backend, makeRepo] of REPO_BACKENDS) {

  test(`[${backend}] proxies repo inserts and lists ordered by createdAt`, async () => {
    const repo = await makeRepo();
    await repo.proxies.insert({ id: 'a', name: 'A', url: 'socks5://host-a:1080', dialTimeoutSeconds: null });
    // Sleep to guarantee a distinct createdAt so the order assertion is deterministic.
    await new Promise(resolve => setTimeout(resolve, 5));
    await repo.proxies.insert({ id: 'b', name: 'B', url: 'socks5://host-b:1080', dialTimeoutSeconds: null });
    const list = await repo.proxies.list();
    assertEquals(list.map(p => p.id), ['a', 'b']);
  });

  test(`[${backend}] proxies repo findUpstreamsReferencing returns ids of upstreams whose fallback list contains the proxy`, async () => {
    const repo = await makeRepo();
    await repo.proxies.insert({ id: 'p', name: 'P', url: 'socks5://host:1080', dialTimeoutSeconds: null });
    await repo.upstreams.save(upstreamFixture('up_1', [{ id: 'p' }, { id: 'direct' }]));
    await repo.upstreams.save(upstreamFixture('up_2', [{ id: 'direct' }, { id: 'p' }]));
    await repo.upstreams.save(upstreamFixture('up_3', [{ id: 'direct' }]));

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

  test(`[${backend}] proxies repo patch returns null for unknown id`, async () => {
    const repo = await makeRepo();
    assertEquals(await repo.proxies.patch('nope', { name: 'x' }), null);
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

    await new Promise(resolve => setTimeout(resolve, 5));
    await repo.proxies.save({ id: 'a', name: 'New', url: 'http://host-b:3128', dialTimeoutSeconds: 60 });

    const after = await repo.proxies.getById('a');
    assertEquals(after?.name, 'New');
    assertEquals(after?.url, 'http://host-b:3128');
    assertEquals(after?.dialTimeoutSeconds, 60);
    assertEquals(after?.createdAt, originalCreatedAt);
  });

  test(`[${backend}] proxies repo deleteAll drops every row`, async () => {
    const repo = await makeRepo();
    await repo.proxies.insert({ id: 'a', name: 'A', url: 'socks5://host-a:1080', dialTimeoutSeconds: null });
    await repo.proxies.insert({ id: 'b', name: 'B', url: 'socks5://host-b:1080', dialTimeoutSeconds: null });
    await repo.proxies.deleteAll();
    assertEquals(await repo.proxies.list(), []);
  });

}

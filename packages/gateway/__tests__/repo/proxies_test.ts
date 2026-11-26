import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';
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
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  config: { baseUrl: 'https://example.test', apiKey: 'sk', endpoints: { openaiChatCompletions: {} } },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList,
  modelPrefix: null,
  hue: 210,
});

for (const [backend, makeRepo] of REPO_BACKENDS) {
  test(`[${backend}] proxies repo findUpstreamsReferencing returns ids of upstreams whose fallback list contains the proxy`, async () => {
    const repo = await makeRepo();
    await repo.proxies.insert({ id: 'p', name: 'P', url: 'socks5://host:1080', dialTimeoutSeconds: null });
    await saveUpstreamForTest(repo.upstreams, upstreamFixture('up_1', [{ id: 'p' }, { id: 'direct_fetch' }]));
    await saveUpstreamForTest(repo.upstreams, upstreamFixture('up_2', [{ id: 'direct_fetch' }, { id: 'p' }]));
    await saveUpstreamForTest(repo.upstreams, upstreamFixture('up_3', [{ id: 'direct_fetch' }]));

    const ids = (await repo.proxies.findUpstreamsReferencing('p')).toSorted();
    assertEquals(ids, ['up_1', 'up_2']);
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
}

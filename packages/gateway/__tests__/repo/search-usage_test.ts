import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { WebSearchUsageRecord, WebSearchUsageRepo } from '../../src/repo/types.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const sortWebSearchUsageRecords = (records: WebSearchUsageRecord[]) =>
  records.toSorted(
    (a, b) =>
      a.hour.localeCompare(b.hour) || a.backend.localeCompare(b.backend) || a.keyId.localeCompare(b.keyId) || a.action.localeCompare(b.action),
  );

const exerciseWebSearchUsageRepo = async (repo: WebSearchUsageRepo) => {
  await repo.deleteAll();
  await repo.record({ backend: 'tavily', keyId: 'key_a', action: 'search', hour: '2026-04-25T10', requests: 1 });
  await repo.record({ backend: 'tavily', keyId: 'key_a', action: 'search', hour: '2026-04-25T10', requests: 2 });
  await repo.record({ backend: 'microsoft-web-iq', keyId: 'key_a', action: 'search', hour: '2026-04-25T11', requests: 4 });
  await repo.record({ backend: 'tavily', keyId: 'key_b', action: 'search', hour: '2026-04-25T12', requests: 8 });
  await repo.record({ backend: 'tavily', keyId: 'key_a', action: 'search', hour: '2026-04-25T13', requests: 16 });

  assertEquals(
    await repo.query({
      backend: 'tavily',
      start: '2026-04-25T10',
      end: '2026-04-25T13',
    }),
    [
      {
        backend: 'tavily',
        keyId: 'key_a',
        action: 'search',
        hour: '2026-04-25T10',
        requests: 3,
      },
      {
        backend: 'tavily',
        keyId: 'key_b',
        action: 'search',
        hour: '2026-04-25T12',
        requests: 8,
      },
    ],
  );

  assertEquals(
    await repo.query({
      keyId: 'key_a',
      start: '2026-04-25T10',
      end: '2026-04-25T14',
    }),
    [
      {
        backend: 'tavily',
        keyId: 'key_a',
        action: 'search',
        hour: '2026-04-25T10',
        requests: 3,
      },
      {
        backend: 'microsoft-web-iq',
        keyId: 'key_a',
        action: 'search',
        hour: '2026-04-25T11',
        requests: 4,
      },
      {
        backend: 'tavily',
        keyId: 'key_a',
        action: 'search',
        hour: '2026-04-25T13',
        requests: 16,
      },
    ],
  );

  await repo.set({
    backend: 'tavily',
    keyId: 'key_a',
    action: 'search',
    hour: '2026-04-25T10',
    requests: 7,
  });
  assertEquals(
    await repo.query({
      backend: 'tavily',
      keyId: 'key_a',
      start: '2026-04-25T10',
      end: '2026-04-25T11',
    }),
    [
      {
        backend: 'tavily',
        keyId: 'key_a',
        action: 'search',
        hour: '2026-04-25T10',
        requests: 7,
      },
    ],
  );

  await repo.deleteAll();
  assertEquals(await repo.listAll(), []);
};

const exerciseActionDimension = async (repo: WebSearchUsageRepo) => {
  await repo.deleteAll();

  // Distinct rows per action under the same (provider, keyId, hour).
  await repo.record({ backend: 'tavily', keyId: 'key_a', action: 'search', hour: '2026-05-01T10', requests: 5 });
  await repo.record({ backend: 'tavily', keyId: 'key_a', action: 'fetch_page', hour: '2026-05-01T10', requests: 3 });
  await repo.record({ backend: 'tavily', keyId: 'key_a', action: 'search', hour: '2026-05-01T10', requests: 2 }); // sums into the existing search row

  const all = await repo.listAll();
  assertEquals(all.length, 2);
  assertEquals(sortWebSearchUsageRecords(all), [
    {
      backend: 'tavily',
      keyId: 'key_a',
      action: 'fetch_page',
      hour: '2026-05-01T10',
      requests: 3,
    },
    {
      backend: 'tavily',
      keyId: 'key_a',
      action: 'search',
      hour: '2026-05-01T10',
      requests: 7,
    },
  ]);

  // query() filters by action when provided.
  const onlyFetch = await repo.query({ action: 'fetch_page', start: '2026-05-01T10', end: '2026-05-01T11' });
  assertEquals(onlyFetch, [
    {
      backend: 'tavily',
      keyId: 'key_a',
      action: 'fetch_page',
      hour: '2026-05-01T10',
      requests: 3,
    },
  ]);

  const onlySearch = await repo.query({ action: 'search', start: '2026-05-01T10', end: '2026-05-01T11' });
  assertEquals(onlySearch, [
    {
      backend: 'tavily',
      keyId: 'key_a',
      action: 'search',
      hour: '2026-05-01T10',
      requests: 7,
    },
  ]);

  // No action filter → returns both rows.
  const both = await repo.query({ start: '2026-05-01T10', end: '2026-05-01T11' });
  assertEquals(both.length, 2);

  // set() with action distinguishes from existing record under the same hour/provider/keyId.
  await repo.set({
    backend: 'tavily',
    keyId: 'key_a',
    action: 'fetch_page',
    hour: '2026-05-01T10',
    requests: 99,
  });
  const afterSet = sortWebSearchUsageRecords(await repo.listAll());
  assertEquals(afterSet, [
    {
      backend: 'tavily',
      keyId: 'key_a',
      action: 'fetch_page',
      hour: '2026-05-01T10',
      requests: 99,
    },
    {
      backend: 'tavily',
      keyId: 'key_a',
      action: 'search',
      hour: '2026-05-01T10',
      requests: 7,
    },
  ]);

  await repo.deleteAll();
};

const assertRejectsInvalidProvider = async (repo: WebSearchUsageRepo) => {
  await repo.deleteAll();

  await assertRejects(() => repo.record({ backend: 'disabled' as WebSearchUsageRecord['backend'], keyId: 'key_a', action: 'search', hour: '2026-04-25T10', requests: 1 }), TypeError);

  await assertRejects(
    () =>
      repo.set({
        backend: 'disabled' as WebSearchUsageRecord['backend'],
        keyId: 'key_a',
        action: 'search',
        hour: '2026-04-25T10',
        requests: 1,
      }),
    TypeError,
  );
};

const backends: Array<readonly [string, () => Promise<WebSearchUsageRepo>]> = [
  ['memory', async () => new InMemoryRepo().webSearchUsage],
  ['SQL', async () => new SqlRepo(await createSqliteTestDb()).webSearchUsage],
];

for (const [backend, makeRepo] of backends) {
  test(`${backend} search usage repo records, queries, overwrites, and clears`, async () => {
    await exerciseWebSearchUsageRepo(await makeRepo());
  });

  test(`${backend} search usage repo distinguishes search vs fetch_page rows`, async () => {
    await exerciseActionDimension(await makeRepo());
  });

  test(`${backend} search usage repo rejects invalid provider names`, async () => {
    await assertRejectsInvalidProvider(await makeRepo());
  });
}

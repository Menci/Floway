import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { WebSearchUsageRecord, WebSearchUsageRepo } from '../../src/repo/types.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const sortWebSearchUsageRecords = (records: WebSearchUsageRecord[]) =>
  records.toSorted(
    (a, b) =>
      a.hour.localeCompare(b.hour) || a.provider.localeCompare(b.provider) || a.keyId.localeCompare(b.keyId) || a.action.localeCompare(b.action),
  );

const exerciseWebSearchUsageRepo = async (repo: WebSearchUsageRepo) => {
  await repo.deleteAll();
  await repo.record({ provider: 'tavily', keyId: 'key_a', action: 'search', hour: '2026-04-25T10', requests: 1 });
  await repo.record({ provider: 'tavily', keyId: 'key_a', action: 'search', hour: '2026-04-25T10', requests: 2 });
  await repo.record({ provider: 'microsoft-web-iq', keyId: 'key_a', action: 'search', hour: '2026-04-25T11', requests: 4 });
  await repo.record({ provider: 'tavily', keyId: 'key_b', action: 'search', hour: '2026-04-25T12', requests: 8 });
  await repo.record({ provider: 'tavily', keyId: 'key_a', action: 'search', hour: '2026-04-25T13', requests: 16 });

  assertEquals(
    await repo.query({
      provider: 'tavily',
      start: '2026-04-25T10',
      end: '2026-04-25T13',
    }),
    [
      {
        provider: 'tavily',
        keyId: 'key_a',
        action: 'search',
        hour: '2026-04-25T10',
        requests: 3,
      },
      {
        provider: 'tavily',
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
        provider: 'tavily',
        keyId: 'key_a',
        action: 'search',
        hour: '2026-04-25T10',
        requests: 3,
      },
      {
        provider: 'microsoft-web-iq',
        keyId: 'key_a',
        action: 'search',
        hour: '2026-04-25T11',
        requests: 4,
      },
      {
        provider: 'tavily',
        keyId: 'key_a',
        action: 'search',
        hour: '2026-04-25T13',
        requests: 16,
      },
    ],
  );

  await repo.set({
    provider: 'tavily',
    keyId: 'key_a',
    action: 'search',
    hour: '2026-04-25T10',
    requests: 7,
  });
  assertEquals(
    await repo.query({
      provider: 'tavily',
      keyId: 'key_a',
      start: '2026-04-25T10',
      end: '2026-04-25T11',
    }),
    [
      {
        provider: 'tavily',
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
  await repo.record({ provider: 'tavily', keyId: 'key_a', action: 'search', hour: '2026-05-01T10', requests: 5 });
  await repo.record({ provider: 'tavily', keyId: 'key_a', action: 'fetch_page', hour: '2026-05-01T10', requests: 3 });
  await repo.record({ provider: 'tavily', keyId: 'key_a', action: 'search', hour: '2026-05-01T10', requests: 2 }); // sums into the existing search row

  const all = await repo.listAll();
  assertEquals(all.length, 2);
  assertEquals(sortWebSearchUsageRecords(all), [
    {
      provider: 'tavily',
      keyId: 'key_a',
      action: 'fetch_page',
      hour: '2026-05-01T10',
      requests: 3,
    },
    {
      provider: 'tavily',
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
      provider: 'tavily',
      keyId: 'key_a',
      action: 'fetch_page',
      hour: '2026-05-01T10',
      requests: 3,
    },
  ]);

  const onlySearch = await repo.query({ action: 'search', start: '2026-05-01T10', end: '2026-05-01T11' });
  assertEquals(onlySearch, [
    {
      provider: 'tavily',
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
    provider: 'tavily',
    keyId: 'key_a',
    action: 'fetch_page',
    hour: '2026-05-01T10',
    requests: 99,
  });
  const afterSet = sortWebSearchUsageRecords(await repo.listAll());
  assertEquals(afterSet, [
    {
      provider: 'tavily',
      keyId: 'key_a',
      action: 'fetch_page',
      hour: '2026-05-01T10',
      requests: 99,
    },
    {
      provider: 'tavily',
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

  await assertRejects(() => repo.record({ provider: 'disabled' as WebSearchUsageRecord['provider'], keyId: 'key_a', action: 'search', hour: '2026-04-25T10', requests: 1 }), TypeError, 'Invalid web search provider');

  await assertRejects(
    () =>
      repo.set({
        provider: 'disabled' as WebSearchUsageRecord['provider'],
        keyId: 'key_a',
        action: 'search',
        hour: '2026-04-25T10',
        requests: 1,
      }),
    TypeError,
    'Invalid web search provider',
  );
};

test('memory search usage repo records, queries, overwrites, and clears', async () => {
  await exerciseWebSearchUsageRepo(new InMemoryRepo().webSearchUsage);
});

test('memory search usage repo distinguishes search vs fetch_page rows', async () => {
  await exerciseActionDimension(new InMemoryRepo().webSearchUsage);
});

test('memory search usage repo rejects invalid provider names', async () => {
  await assertRejectsInvalidProvider(new InMemoryRepo().webSearchUsage);
});

class FakeSqlPreparedStatement {
  private binds: unknown[] = [];

  constructor(private db: FakeSqlDatabase, private query: string) {}

  bind(...values: unknown[]): FakeSqlPreparedStatement {
    this.binds = values;
    return this;
  }

  first(): Promise<null> {
    throw new Error(`Unsupported first() query in search usage test: ${this.query}`);
  }

  all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.includes('FROM search_usage')) {
      return Promise.resolve({
        results: this.db.select(this.query, this.binds) as T[],
        success: true,
        meta: {},
      });
    }

    throw new Error(`Unsupported all() query in search usage test: ${this.query}`);
  }

  run(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.startsWith('INSERT INTO search_usage')) {
      this.db.upsert(this.query, this.binds);
      return Promise.resolve({ results: [], success: true, meta: {} });
    }
    if (this.query === 'DELETE FROM search_usage') {
      this.db.rows = [];
      return Promise.resolve({ results: [], success: true, meta: {} });
    }

    throw new Error(`Unsupported run() query in search usage test: ${this.query}`);
  }
}

class FakeSqlDatabase implements SqlDatabase {
  exec(): Promise<unknown> { return Promise.resolve(undefined); }

  rows: Array<{
    provider: string;
    key_id: string;
    action: string;
    hour: string;
    requests: number;
  }> = [];

  prepare(query: string): FakeSqlPreparedStatement {
    return new FakeSqlPreparedStatement(this, query);
  }

  upsert(query: string, binds: unknown[]): void {
    const [provider, keyId, action, hour, requests] = binds as [string, string, string, string, number];
    const existing = this.rows.find(r => r.provider === provider && r.key_id === keyId && r.action === action && r.hour === hour);
    if (existing) {
      existing.requests = query.includes('requests + excluded.requests') ? existing.requests + requests : requests;
    } else {
      this.rows.push({ provider, key_id: keyId, action, hour, requests });
    }
  }

  select(query: string, binds: unknown[]) {
    if (!query.includes('WHERE')) {
      return sortWebSearchUsageRecords(
        this.rows.map(r => ({
          provider: r.provider as WebSearchUsageRecord['provider'],
          keyId: r.key_id,
          action: r.action as WebSearchUsageRecord['action'],
          hour: r.hour,
          requests: r.requests,
        })),
      ).map(r => ({
        provider: r.provider,
        key_id: r.keyId,
        action: r.action,
        hour: r.hour,
        requests: r.requests,
      }));
    }

    // Predicate combinations matched by SqlWebSearchUsageRepo.query():
    // - hour bounds always present (start, end)
    // - provider may be prepended (unshifted)
    // - keyId may be appended
    // - action may be appended (after keyId if both)
    let provider: string | undefined;
    let keyId: string | undefined;
    let action: string | undefined;
    const hasProvider = query.includes('provider = ?');
    const hasKeyId = query.includes('key_id = ?');
    const hasAction = query.includes('action = ?');

    const bindsCopy = [...binds] as string[];
    if (hasProvider) provider = bindsCopy.shift();
    const start = bindsCopy.shift()!;
    const end = bindsCopy.shift()!;
    if (hasKeyId) keyId = bindsCopy.shift();
    if (hasAction) action = bindsCopy.shift();

    return this.rows
      .filter(r => !provider || r.provider === provider)
      .filter(r => !keyId || r.key_id === keyId)
      .filter(r => !action || r.action === action)
      .filter(r => r.hour >= start && r.hour < end)
      .sort((a, b) => a.hour.localeCompare(b.hour));
  }
}

test('SQL search usage repo records, queries, overwrites, and clears', async () => {
  await exerciseWebSearchUsageRepo(new SqlRepo(new FakeSqlDatabase()).webSearchUsage);
});

test('SQL search usage repo distinguishes search vs fetch_page rows', async () => {
  await exerciseActionDimension(new SqlRepo(new FakeSqlDatabase()).webSearchUsage);
});

test('SQL search usage repo rejects invalid provider names', async () => {
  await assertRejectsInvalidProvider(new SqlRepo(new FakeSqlDatabase()).webSearchUsage);
});

test('SQL search usage repo rejects invalid stored provider names', async () => {
  const db = new FakeSqlDatabase();
  db.rows.push({
    provider: 'disabled',
    key_id: 'key_a',
    action: 'search',
    hour: '2026-04-25T10',
    requests: 1,
  });

  await assertRejects(() => new SqlRepo(db).webSearchUsage.listAll(), TypeError, 'Invalid web search provider');
});

test('SQL search usage repo rejects invalid stored action values', async () => {
  const db = new FakeSqlDatabase();
  db.rows.push({
    provider: 'tavily',
    key_id: 'key_a',
    action: 'bogus',
    hour: '2026-04-25T10',
    requests: 1,
  });

  await assertRejects(() => new SqlRepo(db).webSearchUsage.listAll(), TypeError, 'Invalid search usage action');
});

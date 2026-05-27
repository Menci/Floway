import { Hono } from 'hono';
import { test } from 'vitest';

import { searchUsage } from './routes.ts';
import { zValidator } from '../../middleware/zod-validator.ts';
import { initRepo } from '../../repo/index.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import type { ApiKey, SearchUsageRecord } from '../../repo/types.ts';
import { assertEquals } from '../../test-assert.ts';
import { searchUsageQuery } from '../schemas.ts';

const KEY_A: ApiKey = {
  id: 'key-aaa',
  name: 'Alice',
  key: 'raw-key-aaa',
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
};

const KEY_B: ApiKey = {
  id: 'key-bbb',
  name: 'Bob',
  key: 'raw-key-bbb',
  createdAt: '2026-02-01T00:00:00.000Z',
  upstreamIds: null,
};

const SEARCH_USAGE_A: SearchUsageRecord = {
  provider: 'tavily',
  keyId: KEY_A.id,
  hour: '2026-03-15T10',
  requests: 2,
};

const SEARCH_USAGE_B: SearchUsageRecord = {
  provider: 'microsoft-grounding',
  keyId: KEY_B.id,
  hour: '2026-03-15T11',
  requests: 4,
};

const setup = async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const app = new Hono();
  app.get('/api/search-usage', zValidator('query', searchUsageQuery), searchUsage);

  await repo.apiKeys.save(KEY_A);
  await repo.apiKeys.save(KEY_B);
  await repo.searchUsage.set(SEARCH_USAGE_A);
  await repo.searchUsage.set(SEARCH_USAGE_B);

  return { app, repo };
};

test('/api/search-usage returns records with key metadata and active provider', async () => {
  const { app, repo } = await setup();
  await repo.searchConfig.save({
    provider: 'microsoft-grounding',
    tavily: { apiKey: 'tvly-test' },
    microsoftGrounding: { apiKey: 'ms-test' },
  });

  const response = await app.request('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&include_key_metadata=1');

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.activeProvider, 'microsoft-grounding');
  assertEquals(Array.isArray(body.keyColorOrder), true);
  assertEquals(body.keys, [
    { id: KEY_A.id, name: KEY_A.name, createdAt: KEY_A.createdAt },
    { id: KEY_B.id, name: KEY_B.name, createdAt: KEY_B.createdAt },
  ]);
  assertEquals(body.records, [
    {
      ...SEARCH_USAGE_A,
      keyName: KEY_A.name,
      keyCreatedAt: KEY_A.createdAt,
    },
    {
      ...SEARCH_USAGE_B,
      keyName: KEY_B.name,
      keyCreatedAt: KEY_B.createdAt,
    },
  ]);
});

test('/api/search-usage filters by provider and rejects invalid provider', async () => {
  const { app } = await setup();

  const filtered = await app.request('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&provider=tavily');
  assertEquals(filtered.status, 200);
  assertEquals(await filtered.json(), [
    {
      ...SEARCH_USAGE_A,
      keyName: KEY_A.name,
      keyCreatedAt: KEY_A.createdAt,
    },
  ]);

  const invalid = await app.request('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&provider=disabled');
  assertEquals(invalid.status, 400);
});

test('/api/search-usage requires start and end', async () => {
  const { app } = await setup();

  const missingStart = await app.request('/api/search-usage?end=2026-03-16T00');
  assertEquals(missingStart.status, 400);
  assertEquals(await missingStart.json(), {
    error: 'start and end query parameters are required (e.g. 2026-03-09T00)',
  });

  const missingEnd = await app.request('/api/search-usage?start=2026-03-15T00');
  assertEquals(missingEnd.status, 400);
  assertEquals(await missingEnd.json(), {
    error: 'start and end query parameters are required (e.g. 2026-03-09T00)',
  });
});

import { beforeEach, test } from 'vitest';

import { fetchPageAndRecordUsage } from '../../../../src/data-plane/tools/web-search/fetch-page.ts';
import type { WebSearchFetchPageResult, WebSearchProvider } from '../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const okResult: WebSearchFetchPageResult = { type: 'ok', pages: [], failures: [] };

const stubProvider = (result: WebSearchFetchPageResult): WebSearchProvider => ({
  search: () => Promise.reject(new Error('search should not be called from fetch-page test')),
  fetchPage: () => Promise.resolve(result),
});

let repo: InMemoryRepo;

beforeEach(() => {
  repo = new InMemoryRepo();
  initRepo(repo);
});

test('fetchPageAndRecordUsage records once per URL (one row, requests=N) on a multi-URL batch', async () => {
  await fetchPageAndRecordUsage({
    provider: stubProvider(okResult),
    providerName: 'tavily',
    keyId: 'k1',
    request: { urls: ['https://a.com', 'https://b.com', 'https://c.com'] },
  });

  const records = await repo.webSearchUsage.listAll();
  assertEquals(records.length, 1);
  assertEquals(records[0].requests, 3);
});

test('fetchPageAndRecordUsage rethrows AND records when provider call throws (try/finally semantics)', async () => {
  const throwing: WebSearchProvider = {
    search: () => Promise.reject(new Error('search should not be called from fetch-page test')),
    fetchPage: () => Promise.reject(new Error('network down')),
  };

  await assertRejects(
    () => fetchPageAndRecordUsage({
      provider: throwing,
      providerName: 'tavily',
      keyId: 'k1',
      request: { urls: ['https://a.com'] },
    }),
    Error,
    'network down',
  );

  const records = await repo.webSearchUsage.listAll();
  assertEquals(records.length, 1);
  assertEquals(records[0].requests, 1);
});

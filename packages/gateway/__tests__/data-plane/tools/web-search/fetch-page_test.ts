import { beforeEach, test } from 'vitest';

import { fetchPageAndRecordUsage } from '../../../../src/data-plane/tools/web-search/fetch-page.ts';
import type { WebSearchFetchPageResult, WebSearchBackend } from '../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const okResult: WebSearchFetchPageResult = { type: 'ok', pages: [], failures: [] };

const stubUpstream = (result: WebSearchFetchPageResult): WebSearchBackend => ({
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
    backend: stubUpstream(okResult),
    backendName: 'tavily',
    keyId: 'k1',
    request: { urls: ['https://a.com', 'https://b.com', 'https://c.com'] },
  });

  const records = await repo.webSearchUsage.listAll();
  assertEquals(records.length, 1);
  assertEquals(records[0].requests, 3);
});

test('fetchPageAndRecordUsage rethrows AND records when provider call throws (try/finally semantics)', async () => {
  const throwing: WebSearchBackend = {
    search: () => Promise.reject(new Error('search should not be called from fetch-page test')),
    fetchPage: () => Promise.reject(new Error('network down')),
  };

  await assertRejects(
    () => fetchPageAndRecordUsage({
      backend: throwing,
      backendName: 'tavily',
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

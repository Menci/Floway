import { test } from 'vitest';

import { runWebSearchAndRecordUsage } from '../../../../src/data-plane/tools/web-search/search.ts';
import type { WebSearchProvider } from '../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { assertEquals } from '@floway-dev/test-utils';

const stubProvider = (search: WebSearchProvider['search']): WebSearchProvider => ({
  search,
  fetchPage: () => Promise.reject(new Error('fetchPage should not be called from search test')),
});

test('runWebSearchAndRecordUsage records successful provider calls', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const result = await runWebSearchAndRecordUsage({
    providerName: 'tavily',
    keyId: 'key_a',
    request: { query: 'React' },
    provider: stubProvider(() => Promise.resolve({ type: 'ok', results: [] })),
  });

  assertEquals(result, { type: 'ok', results: [] });
  const records = await repo.webSearchUsage.listAll();
  assertEquals(records.length, 1);
  assertEquals(records[0].provider, 'tavily');
  assertEquals(records[0].keyId, 'key_a');
  assertEquals(records[0].requests, 1);
});

test('runWebSearchAndRecordUsage returns provider result when recording fails', async () => {
  const repo = new InMemoryRepo();
  repo.webSearchUsage.record = () => Promise.reject(new Error('write failed'));
  initRepo(repo);

  const originalConsoleError = console.error;
  const loggedErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  let result: Awaited<ReturnType<typeof runWebSearchAndRecordUsage>> | undefined;
  try {
    result = await runWebSearchAndRecordUsage({
      providerName: 'tavily',
      keyId: 'key_d',
      request: { query: 'React' },
      provider: stubProvider(() => Promise.resolve({ type: 'ok', results: [] })),
    });
  } finally {
    console.error = originalConsoleError;
  }

  assertEquals(result, { type: 'ok', results: [] });
  assertEquals(loggedErrors.length, 1);
});

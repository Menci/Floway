import { test } from 'vitest';

import { runWebSearchAndRecordUsage } from '../../../../src/data-plane/tools/web-search/search.ts';
import type { WebSearchBackend } from '../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { assertEquals } from '@floway-dev/test-utils';

const stubUpstream = (search: WebSearchBackend['search']): WebSearchBackend => ({
  search,
  fetchPage: () => Promise.reject(new Error('fetchPage should not be called from search test')),
});

test('runWebSearchAndRecordUsage returns provider result when recording fails', async () => {
  const repo = new InMemoryRepo();
  repo.webSearchUsage.record = () => Promise.reject(new Error('write failed'));
  initRepo(repo);

  const originalConsoleError = console.error;
  console.error = () => {};

  let result: Awaited<ReturnType<typeof runWebSearchAndRecordUsage>> | undefined;
  try {
    result = await runWebSearchAndRecordUsage({
      backendName: 'tavily',
      keyId: 'key_d',
      request: { query: 'React' },
      backend: stubUpstream(() => Promise.resolve({ type: 'ok', results: [] })),
    });
  } finally {
    console.error = originalConsoleError;
  }

  assertEquals(result, { type: 'ok', results: [] });
});

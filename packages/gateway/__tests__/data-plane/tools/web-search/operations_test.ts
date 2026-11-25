import { beforeEach, expect, test } from 'vitest';

import { executeOperationToIr, parseWebSearchOperations, startBatchFetch, type WebSearchExecutionSession } from '../../../../src/data-plane/tools/web-search/operations.ts';
import type { WebSearchFetchPageResult, WebSearchProvider } from '../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { assert } from '@floway-dev/test-utils';

beforeEach(() => { initRepo(new InMemoryRepo()); });

const sessionFor = (result: WebSearchFetchPageResult): WebSearchExecutionSession => {
  const provider: WebSearchProvider = {
    search: () => Promise.reject(new Error('search should not be called')),
    fetchPage: () => Promise.resolve(result),
  };
  return {
    getProvider: () => Promise.resolve({ type: 'enabled', provider: 'microsoft-web-iq', impl: provider }),
    filters: {},
    apiKeyId: 'key',
    pageCache: new Map(),
    includeSearchActionSources: false,
  };
};

const openOps = (urls: string[]) => {
  const parsed = parseWebSearchOperations({ open: urls.map(ref_id => ({ ref_id })) });
  assert(parsed.kind === 'ops');
  return { parsed, ops: parsed.ops.filter(op => op.kind === 'open') };
};

const page = (url: string, content = 'body') => ({
  url,
  title: 'title',
  content,
  truncated: false,
  fullContentBytes: content.length,
});

test('open_page pairs one remaining redirected page after exact matches are claimed', async () => {
  const exactUrl = 'https://example.com/page';
  const redirectedUrl = 'https://www.openai.com';
  const { parsed, ops } = openOps([exactUrl, redirectedUrl]);
  const session = sessionFor({
    type: 'ok',
    pages: [page(exactUrl, 'exact'), page('https://openai.com/', 'redirected')],
    failures: [],
  });
  const batch = await startBatchFetch(parsed, session);

  const exact = await executeOperationToIr(ops[0], session, batch);
  const redirected = await executeOperationToIr(ops[1], session, batch);
  expect(exact.results[0]).toMatchObject({ url: exactUrl, snippet: 'exact' });
  expect(redirected.results[0]).toMatchObject({ url: redirectedUrl, snippet: 'redirected' });
});

test('open_page does not guess when multiple redirected pages are ambiguous', async () => {
  const urls = ['https://www.one.test', 'https://www.two.test'];
  const { parsed, ops } = openOps(urls);
  const session = sessionFor({
    type: 'ok',
    pages: [page('https://one.test/'), page('https://two.test/')],
    failures: [],
  });
  const batch = await startBatchFetch(parsed, session);

  for (const op of ops) {
    const ir = await executeOperationToIr(op, session, batch);
    expect(ir.results[0]?.snippet).toContain('No page returned');
  }
});

test('search maps a provider error to a snippet and propagates a mapping defect', async () => {
  const parsed = parseWebSearchOperations({ search_query: [{ q: 'test query' }] });
  assert(parsed.kind === 'ops');
  const session = sessionFor({ type: 'ok', pages: [], failures: [] });
  const result = await executeOperationToIr(parsed.ops[0], {
    ...session,
    search: () => Promise.resolve({ type: 'error', errorCode: 'unavailable', message: 'Search upstream offline' }),
  }, new Map());
  expect(result.results[0]?.snippet).toContain('Search upstream offline');

  const defect = new TypeError('unexpected search result access');
  await expect(executeOperationToIr(parsed.ops[0], {
    ...session,
    search: () => Promise.resolve({ type: 'ok', get results(): never { throw defect; } }),
  }, new Map())).rejects.toBe(defect);
});

test('open_page maps a provider error to a snippet and propagates a mapping defect', async () => {
  const url = 'https://example.com/page';
  const { parsed, ops } = openOps([url]);
  const session = sessionFor({ type: 'error', errorCode: 'unavailable', message: 'Page upstream offline' });
  const result = await executeOperationToIr(ops[0], session, await startBatchFetch(parsed, session));
  expect(result.results[0]?.snippet).toContain('Page upstream offline');

  const defect = new TypeError('unexpected page result access');
  const brokenSession = sessionFor({ type: 'ok', get pages(): never { throw defect; }, failures: [] });
  await expect(startBatchFetch(parsed, brokenSession)).rejects.toBe(defect);
});

import { beforeEach, expect, test } from 'vitest';

import { executeOperationToIr, parseWebSearchOperations, startBatchFetch, type WebSearchExecutionSession } from '../../../../src/data-plane/tools/web-search/operations.ts';
import type { WebSearchFetchPageResult, WebSearchProvider } from '../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

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

test('open_page matches a provider URL normalized with a trailing slash', async () => {
  const requestedUrl = 'https://openai.com';
  const { parsed, ops } = openOps([requestedUrl]);
  const session = sessionFor({ type: 'ok', pages: [page('https://openai.com/')], failures: [] });
  const batch = await startBatchFetch(parsed, session);
  const ir = await executeOperationToIr(ops[0], session, batch);

  assertEquals(ir.action, { type: 'open_page', url: requestedUrl });
  expect(ir.results[0]).toMatchObject({ url: requestedUrl, title: 'title', snippet: 'body' });
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

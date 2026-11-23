import { expect, test } from 'vitest';

import { executeOperationToIr, parseWebSearchOperations, startBatchFetch, type WebSearchExecutionSession } from '../../../../src/data-plane/tools/web-search/operations.ts';
import type { WebSearchProvider } from '../../../../src/data-plane/tools/web-search/types.ts';
import type { WebSearchUsageRecord } from '../../../../src/repo/types.ts';
import { assert } from '@floway-dev/test-utils';

const sessionFor = (fetchPage: WebSearchProvider['fetchPage']) => {
  const records: WebSearchUsageRecord[] = [];
  const provider: WebSearchProvider = {
    search: () => Promise.reject(new Error('search should not be called')),
    fetchPage,
  };
  const session: WebSearchExecutionSession = {
    getProvider: () => Promise.resolve({ type: 'enabled', provider: 'microsoft-web-iq', impl: provider }),
    filters: {},
    apiKeyId: 'key',
    recordUsage: row => { records.push(row); },
    pageCache: new Map(),
    includeSearchActionSources: false,
  };
  return { session, records };
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
  const { session } = sessionFor(async () => ({
    type: 'ok',
    pages: [page(exactUrl, 'exact'), page('https://openai.com/', 'redirected')],
    failures: [],
  }));
  const batch = await startBatchFetch(parsed, session);

  const exact = await executeOperationToIr(ops[0], session, batch);
  const redirected = await executeOperationToIr(ops[1], session, batch);
  expect(exact.results[0]).toMatchObject({ url: exactUrl, snippet: 'exact' });
  expect(redirected.results[0]).toMatchObject({ url: redirectedUrl, snippet: 'redirected' });
});

test('open_page does not guess when multiple redirected pages are ambiguous', async () => {
  const urls = ['https://www.one.test', 'https://www.two.test'];
  const { parsed, ops } = openOps(urls);
  const { session } = sessionFor(async () => ({
    type: 'ok',
    pages: [page('https://one.test/'), page('https://two.test/')],
    failures: [],
  }));
  const batch = await startBatchFetch(parsed, session);

  for (const op of ops) {
    const ir = await executeOperationToIr(op, session, batch);
    expect(ir.results[0]?.snippet).toContain('No page returned');
  }
});

test('a fetch batch reports one billable request for each distinct URL', async () => {
  const urls = ['https://a.com', 'https://b.com', 'https://c.com'];
  const { parsed } = openOps([...urls, urls[0]]);
  const { session, records } = sessionFor(async ({ urls: requested }) => {
    expect(requested).toEqual(urls);
    return { type: 'ok', pages: urls.map(url => page(url)), failures: [] };
  });
  await startBatchFetch(parsed, session);
  expect(records).toEqual([expect.objectContaining({ action: 'fetch_page', requests: 3 })]);
});

test('a failed provider fetch reports its billable attempt and exposes the error to the tool', async () => {
  const { parsed, ops } = openOps(['https://a.com']);
  const { session, records } = sessionFor(async () => { throw new Error('network down'); });
  const batch = await startBatchFetch(parsed, session);
  const result = await executeOperationToIr(ops[0], session, batch);
  expect(result.results[0]?.snippet).toContain('network down');
  expect(records).toEqual([expect.objectContaining({ action: 'fetch_page', requests: 1 })]);
});

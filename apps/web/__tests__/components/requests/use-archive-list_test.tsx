import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { ARCHIVE_PAGE_SIZE } from '../../../src/components/requests/archive';
import { useArchiveList } from '../../../src/components/requests/use-archive-list';
import type { PipelineDumpMetadata } from '@floway-dev/gateway/browser';

const makeRecords = (prefix: string): PipelineDumpMetadata[] => Array.from({ length: ARCHIVE_PAGE_SIZE }, (_, index) => ({
  id: `${prefix}-${index}`, method: 'POST', path: '/v1/embeddings', startedAt: 0, completedAt: 1, durationMs: 1,
  status: 200, model: 'model', ttftMs: null, requestBytes: 0, responseBytes: 0, inputTokens: null, outputTokens: null, error: null, upstream: null,
}));

test('discards pagination from the previous key and preserves new-key paging and filters', async () => {
  const pending = Promise.withResolvers<Response>();
  const first = makeRecords('first');
  const second = makeRecords('second');
  const then = { ...second[0]!, id: 'older' };
  const fetch = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.includes('/first/')) return pending.promise;
    expect(url.searchParams.get('before')).toBe(second.at(-1)?.id);
    expect(url.searchParams.get('failures')).toBe('true');
    expect(url.searchParams.get('q')).toBe('model');
    return Promise.resolve(Response.json({ records: [then] }));
  });
  vi.stubGlobal('fetch', fetch);
  const view = renderHook(({ keyId, records }) => useArchiveList(keyId, records, 'model', true), {
    initialProps: { keyId: 'first', records: first },
  });
  let previous: Promise<void> | undefined;
  act(() => { previous = view.result.current.loadOlder(); });
  expect(fetch).toHaveBeenCalledOnce();
  view.rerender({ keyId: 'second', records: second });
  await act(async () => { await view.result.current.loadOlder(); });
  await act(async () => {
    pending.resolve(Response.json({ error: 'expired key' }, { status: 404 }));
    await previous;
  });
  expect(view.result.current.records.at(-1)).toEqual(then);
  expect(view.result.current.hasOlder).toBe(false);
  expect(view.result.current.error).toBeNull();
});

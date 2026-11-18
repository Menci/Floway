import { test } from 'vitest';

import { createExternalImageFetcher } from '../../../../src/data-plane/chat/shared/external-image-fetcher.ts';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

test('external image fetcher follows relative redirects and memoizes one request chain', async () => {
  const requested: string[] = [];
  initExternalResourceFetcher((url, signal) => {
    assertEquals(signal.aborted, false);
    requested.push(url.href);
    return Promise.resolve(url.pathname === '/start'
      ? new Response(null, { status: 302, headers: { location: '/image.png' } })
      : new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/png' } }));
  });
  const fetchImage = createExternalImageFetcher();

  const [first, second] = await Promise.all([
    fetchImage('https://example.com/start#ignored'),
    fetchImage('https://example.com/start'),
  ]);

  assertEquals(first.type, 'success');
  if (first.type !== 'success') throw new Error('unreachable');
  assert(first === second);
  assertEquals(first.finalUrl.href, 'https://example.com/image.png');
  assertEquals(first.status, 200);
  assertEquals(first.mediaType, 'image/png');
  assertEquals([...first.data], [1, 2, 3]);
  assertEquals(requested, ['https://example.com/start', 'https://example.com/image.png']);
});

test('external image fetcher rejects unsafe URL syntax before egress', async () => {
  let requests = 0;
  initExternalResourceFetcher(() => {
    requests += 1;
    return Promise.resolve(new Response());
  });
  const fetchImage = createExternalImageFetcher();

  assertEquals(await fetchImage('file:///etc/passwd'), { type: 'invalid-url' });
  assertEquals(await fetchImage('https://user:secret@example.com/image.png'), { type: 'invalid-url' });
  assertEquals(await fetchImage('not a URL'), { type: 'invalid-url' });
  assertEquals(requests, 0);
});

test('external image fetcher cancels a streamed body beyond the byte limit', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let cancelled = false;
  initExternalResourceFetcher(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  }))));

  assertEquals(await createExternalImageFetcher()('https://example.com/large.png'), {
    type: 'too-large',
    limitBytes: 50 * 1024 * 1024,
  });
  assertEquals(cancelled, true);
});

test('external image fetcher propagates downstream cancellation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('downstream cancelled'));
  initExternalResourceFetcher(() => Promise.reject(new Error('should not fetch')));

  await assertRejects(
    () => createExternalImageFetcher(controller.signal)('https://example.com/image.png'),
    Error,
    'downstream cancelled',
  );
});

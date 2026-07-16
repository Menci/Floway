import { test } from 'vitest';

import { createExternalImageFetcher, createExternalImageLoader } from './external-image-loader.ts';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

test('external image loader follows relative redirects and memoizes one request chain', async () => {
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

test('external image loader rejects unsafe URL syntax before egress', async () => {
  let requests = 0;
  initExternalResourceFetcher(() => {
    requests += 1;
    return Promise.resolve(new Response());
  });
  const load = createExternalImageLoader();
  const fetchImage = createExternalImageFetcher();

  assertEquals(await fetchImage('file:///etc/passwd'), { type: 'invalid-url' });
  assertEquals(await load('file:///etc/passwd'), null);
  assertEquals(await load('https://user:secret@example.com/image.png'), null);
  assertEquals(await load('not a URL'), null);
  assertEquals(requests, 0);
});

test('external image fetcher reports non-success and oversized responses', async () => {
  initExternalResourceFetcher(url => Promise.resolve(url.pathname === '/missing'
    ? new Response('missing', { status: 404 })
    : new Response(Uint8Array.of(1), { headers: { 'content-length': String(50 * 1024 * 1024 + 1) } })));
  const fetchImage = createExternalImageFetcher();

  assertEquals(await fetchImage('https://example.com/missing'), { type: 'http-error', status: 404 });
  assertEquals(await fetchImage('https://example.com/oversized'), { type: 'too-large', limitBytes: 50 * 1024 * 1024 });
});

test('external image loader bounds redirect chains', async () => {
  let requests = 0;
  initExternalResourceFetcher(_url => {
    requests += 1;
    return Promise.resolve(new Response(null, {
      status: 302,
      headers: { location: `https://example.com/redirect-${requests}` },
    }));
  });

  assertEquals(await createExternalImageFetcher()('https://example.com/start'), {
    type: 'invalid-redirect',
    status: 302,
    reason: 'too-many-redirects',
  });
  assertEquals(requests, 6);
});

test('external image loader cancels a streamed body beyond the byte limit', async () => {
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

test('external image fetcher preserves transport failure detail', async () => {
  const expected = new Error('network unavailable');
  initExternalResourceFetcher(() => Promise.reject(expected));

  const result = await createExternalImageFetcher()('https://example.com/image.png');

  assertEquals(result.type, 'transport-error');
  if (result.type !== 'transport-error') throw new Error('unreachable');
  assertEquals(result.error, expected);
});

test('external image loader propagates downstream cancellation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('downstream cancelled'));
  initExternalResourceFetcher(() => Promise.reject(new Error('should not fetch')));

  await assertRejects(
    () => createExternalImageLoader(controller.signal)('https://example.com/image.png'),
    Error,
    'downstream cancelled',
  );
});

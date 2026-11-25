import { expect, test, vi } from 'vitest';

import { createExternalImageFetcher } from '../../../../src/data-plane/chat/shared/external-image-fetcher.ts';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import { assert, assertEquals } from '@floway-dev/test-utils';

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

test('external image fetcher returns the downstream cancellation reason as a failure value', async () => {
  const controller = new AbortController();
  const reason = new Error('downstream cancelled');
  controller.abort(reason);
  initExternalResourceFetcher(() => Promise.reject(new Error('should not fetch')));

  const result = await createExternalImageFetcher(controller.signal)('https://example.com/image.png');
  expect(result).toEqual({ type: 'transport-error', error: reason });
});

test('external image fetcher returns I/O failures and propagates an unrelated error after abort', async () => {
  const controller = new AbortController();
  const transport = new TypeError('fetch failed');
  initExternalResourceFetcher(() => Promise.reject(transport));
  expect(await createExternalImageFetcher()('https://example.com/image.png'))
    .toEqual({ type: 'transport-error', error: transport });

  const terminated = new TypeError('terminated');
  initExternalResourceFetcher(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.error(terminated); },
  }))));
  expect(await createExternalImageFetcher()('https://example.com/image.png'))
    .toEqual({ type: 'transport-error', error: terminated });

  initExternalResourceFetcher(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    cancel() { return Promise.reject(terminated); },
  }), { status: 404 })));
  expect(await createExternalImageFetcher()('https://example.com/image.png'))
    .toEqual({ type: 'transport-error', error: terminated });

  const defect = new TypeError('unexpected egress failure');
  initExternalResourceFetcher(() => {
    controller.abort();
    return Promise.reject(defect);
  });
  await expect(createExternalImageFetcher(controller.signal)('https://example.com/image.png'))
    .rejects.toBe(defect);
});

test('external image fetcher matches its timeout by reason', async () => {
  const timeout = new AbortController();
  const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timeout.signal);
  try {
    initExternalResourceFetcher((_url, signal) => {
      timeout.abort(new DOMException('download timeout', 'TimeoutError'));
      expect(signal.reason).toBe(timeout.signal.reason);
      return Promise.reject(signal.reason);
    });
    await expect(createExternalImageFetcher()('https://example.com/image.png')).resolves.toEqual({ type: 'timeout' });
  } finally {
    timer.mockRestore();
  }
});

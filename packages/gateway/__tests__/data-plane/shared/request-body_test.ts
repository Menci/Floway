import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { readRequestBody, takeRequestBody } from '../../../src/data-plane/shared/request-body.ts';
import { internalErrorResponse } from '../../../src/middleware/internal-error-response.ts';
import { MAX_BUFFERED_REQUEST_BODY_BYTES } from '../../../src/middleware/request-body-limit.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('takeRequestBody transfers bytes and clears the source owner', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const source = { capturedBytes: bytes, streamError: 'partial upload' };

  const owned = takeRequestBody(source);

  expect(owned.bytes).toBe(bytes);
  assertEquals(owned.streamError, 'partial upload');
  assertEquals(source.capturedBytes.byteLength, 0);
});

const requestBodyApp = (maxBytes: number) => {
  const app = new Hono().onError(internalErrorResponse);
  app.post('/body', async c => {
    const body = await readRequestBody(c, { maxBytes });
    return c.json({ bytes: [...body.capturedBytes], streamError: body.streamError });
  });
  return app;
};

test('readRequestBody accepts exactly maxBytes', async () => {
  const response = await requestBodyApp(4).request('/body', {
    method: 'POST',
    body: Uint8Array.of(1, 2, 3, 4),
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { bytes: [1, 2, 3, 4], streamError: null });
});

test('readRequestBody preallocates an exact declared Content-Length backing buffer', async () => {
  const app = new Hono();
  app.post('/body', async (c) => {
    const body = await readRequestBody(c, { maxBytes: 64 * 1024 });
    return c.json({
      bytes: [...body.capturedBytes],
      backingBytes: body.capturedBytes.buffer.byteLength,
    });
  });
  const response = await app.request('/body', {
    method: 'POST',
    headers: { 'content-length': '4' },
    body: Uint8Array.of(1, 2, 3, 4),
  });

  assertEquals(await response.json(), { bytes: [1, 2, 3, 4], backingBytes: 4 });
});

test('readRequestBody coalesces unknown-length chunks into one exact backing buffer', async () => {
  let pull = 0;
  const request = new Request('http://localhost/body', {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pull += 1;
        if (pull === 1) controller.enqueue(Uint8Array.of(1, 2));
        else if (pull === 2) controller.enqueue(Uint8Array.of(3, 4, 5));
        else controller.close();
      },
    }, { highWaterMark: 0 }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const app = new Hono();
  app.post('/body', async (c) => {
    const body = await readRequestBody(c, { maxBytes: 64 * 1024 });
    return c.json({
      bytes: [...body.capturedBytes],
      backingBytes: body.capturedBytes.buffer.byteLength,
    });
  });

  const response = await app.request(request);

  assertEquals(await response.json(), { bytes: [1, 2, 3, 4, 5], backingBytes: 5 });
});

test('readRequestBody cancels a chunked upload at maxBytes + 1 and returns 413', async () => {
  let pulls = 0;
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(pulls === 1 ? Uint8Array.of(1, 2, 3, 4) : Uint8Array.of(5));
    },
    cancel() {
      canceled = true;
      return new Promise<void>(() => {});
    },
  }, { highWaterMark: 0 });
  const request = new Request('http://localhost/body', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  const response = await requestBodyApp(4).request(request);

  assertEquals(response.status, 413);
  assertEquals(canceled, true);
  assertEquals(pulls, 2);
  assertEquals(await response.json(), {
    error: {
      type: 'request_too_large',
      message: "Request body exceeds Floway's 4-byte buffered request limit.",
      max_bytes: 4,
      method: 'POST',
      path: '/body',
    },
  });
});

test('readRequestBody rejects an oversized declared length without awaiting cancellation', { timeout: 2_000 }, async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
      return new Promise<void>(() => {});
    },
  });
  const request = new Request('http://localhost/body', {
    method: 'POST',
    headers: { 'content-length': '5' },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  const response = await requestBodyApp(4).request(request);

  assertEquals(response.status, 413);
  assertEquals(canceled, true);
  assertEquals((await response.json()).error.max_bytes, 4);
});

test('readRequestBody applies the production body ceiling without allocating it', async () => {
  const app = new Hono().onError(internalErrorResponse);
  app.post('/body', async c => Response.json(await readRequestBody(c)));
  const response = await app.request('/body', {
    method: 'POST',
    headers: { 'content-length': String(MAX_BUFFERED_REQUEST_BODY_BYTES + 1) },
    body: new ReadableStream<Uint8Array>(),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  assertEquals(response.status, 413);
  assertEquals((await response.json()).error.max_bytes, MAX_BUFFERED_REQUEST_BODY_BYTES);
});

test('readRequestBody retains bytes received before a stream failure', async () => {
  let pull = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pull += 1;
      if (pull === 1) controller.enqueue(Uint8Array.of(1, 2));
      else controller.error(new Error('upload\nfailed'));
    },
  }, { highWaterMark: 0 });
  const request = new Request('http://localhost/body', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  const response = await requestBodyApp(4).request(request);

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { bytes: [1, 2], streamError: 'upload failed' });
});

import { Hono } from 'hono';
import { test } from 'vitest';

import { streamSSE } from './sse.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('streamSSE wrapper sets X-Accel-Buffering plus the streamSSE defaults', async () => {
  const app = new Hono();
  app.get('/', c =>
    streamSSE(c, async stream => {
      await stream.writeSSE({ data: 'hi' });
    }));

  const response = await app.request('/');

  // nginx-buffering opt-out — the reason this wrapper exists.
  assertEquals(response.headers.get('x-accel-buffering'), 'no');
  // Hono's built-in headers survive the wrapper (regression guard against a
  // future refactor that stops delegating to honoStreamSSE).
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  assertEquals(response.headers.get('cache-control'), 'no-cache');

  await response.body?.cancel();
});

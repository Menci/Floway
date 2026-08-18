import { Hono } from 'hono';
import { test } from 'vitest';

import { passthroughAttempt, type PassthroughAttemptResult } from '../../../src/data-plane/shared/passthrough-attempt.ts';
import type { AuthVars } from '../../../src/middleware/auth.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { assertEquals, assertExists, stubModelCandidate, stubProvider } from '@floway-dev/test-utils';

test('passthroughAttempt applies the selected provider ingress policy', async () => {
  let observed: Headers | undefined;
  const base = stubModelCandidate();
  const candidate = stubModelCandidate({
    provider: {
      ...base.provider,
      kind: 'custom',
      instance: stubProvider({
        callOpenAIEmbeddings: async (_model, _body, _signal, opts) => {
          observed = opts.headers;
          return { response: new Response('{}'), modelKey: 'test-model' };
        },
      }),
    },
  });
  const app = new Hono<{ Variables: AuthVars }>();
  app.post('/test', async c => {
    await passthroughAttempt({
      c,
      ctx: mockGatewayCtx(),
      candidate,
      operation: 'embeddings',
      call: (provider, model, opts) => provider.instance.callOpenAIEmbeddings(model, { input: 'hi' }, undefined, opts),
    });
    return c.text('ok');
  });
  await app.request('/test', {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'x-client-request-id': 'request-1',
      'x-debug': 'discard',
    },
  });

  assertExists(observed);
  assertEquals([...observed], []);
});

// Drives one attempt against a canned upstream response, through the same Hono
// context the serve layer builds.
const runPassthroughAttempt = async (upstream: Response): Promise<PassthroughAttemptResult> => {
  const base = stubModelCandidate();
  const candidate = stubModelCandidate({
    provider: {
      ...base.provider,
      kind: 'custom',
      instance: stubProvider({
        callOpenAIEmbeddings: async () => ({ response: upstream, modelKey: 'test-model' }),
      }),
    },
  });
  let result: PassthroughAttemptResult | undefined;
  const app = new Hono<{ Variables: AuthVars }>();
  app.post('/test', async c => {
    result = await passthroughAttempt({
      c,
      ctx: mockGatewayCtx(),
      candidate,
      operation: 'embeddings',
      call: (provider, model, opts) => provider.instance.callOpenAIEmbeddings(model, { input: 'hi' }, undefined, opts),
    });
    return c.text('ok');
  });
  await app.request('/test', { method: 'POST' });
  assertExists(result);
  return result;
};

// The fallback loop keeps only the most recent failure, so every superseded
// attempt is dropped. On the direct-connect egress a dropped response strands
// its socket, which is why a failed attempt must not carry a live body.
test('passthroughAttempt materializes a failed upstream response so a discarded attempt holds no transport', async () => {
  let sourceCancelled = false;
  let sourceRead = false;
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        sourceRead = true;
        controller.enqueue(new TextEncoder().encode('{"error":"upstream busy"}'));
        controller.close();
      },
      cancel() { sourceCancelled = true; },
    }),
    { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'application/json', 'retry-after': '12' } },
  );

  const result = await runPassthroughAttempt(upstream);

  assertEquals(result.status, 503);
  // The upstream body was consumed rather than left for someone else to close.
  assertEquals(sourceRead, true);
  assertEquals(sourceCancelled, false);
  assertEquals(upstream.bodyUsed, true);
  // Status, headers and bytes still forward verbatim.
  assertEquals(result.response.status, 503);
  assertEquals(result.response.statusText, 'Service Unavailable');
  assertEquals(result.response.headers.get('retry-after'), '12');
  assertEquals(await result.response.text(), '{"error":"upstream busy"}');
});

test('passthroughAttempt forwards a successful upstream response without reading it', async () => {
  const upstream = new Response('ok', { status: 200 });
  const result = await runPassthroughAttempt(upstream);

  // A 2xx is returned to the caller immediately and is never discarded, so it
  // must keep streaming rather than be buffered here.
  assertEquals(result.response, upstream);
  assertEquals(upstream.bodyUsed, false);
});

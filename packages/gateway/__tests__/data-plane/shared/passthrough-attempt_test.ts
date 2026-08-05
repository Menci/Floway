import { Hono } from 'hono';
import { test } from 'vitest';

import { passthroughAttempt } from '../../../src/data-plane/shared/passthrough-attempt.ts';
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
        callEmbeddings: async (_model, _body, _signal, opts) => {
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
      call: (provider, model, opts) => provider.instance.callEmbeddings(model, { input: 'hi' }, undefined, opts),
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

import { Hono } from 'hono';
import { test } from 'vitest';

import { passthroughAttempt } from '../../../src/data-plane/shared/passthrough-attempt.ts';
import type { RawAttemptResult } from '../../../src/data-plane/shared/raw-attempt-result.ts';
import type { AuthVars } from '../../../src/middleware/auth.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { assertEquals, assertExists, stubModelCandidate, stubProvider } from '@floway-dev/test-utils';

// Drives one attempt against a canned upstream response, through the same Hono
// context the serve layer builds.
const runPassthroughAttempt = async (upstream: Response): Promise<RawAttemptResult> => {
  const base = stubModelCandidate();
  const candidate = stubModelCandidate({
    provider: {
      ...base.provider,
      kind: 'custom',
      instance: stubProvider({
        callOpenAIEmbeddings: async () => ({ http: upstream, modelKey: 'test-model' }),
      }),
    },
  });
  let result: RawAttemptResult | undefined;
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

test('passthroughAttempt forwards a successful upstream response without reading it', async () => {
  const upstream = new Response('ok', { status: 200 });
  const result = await runPassthroughAttempt(upstream);

  // A 2xx is returned to the caller immediately and is never discarded, so it
  // must keep streaming rather than be buffered here.
  assertEquals(result.http, upstream);
  assertEquals(upstream.bodyUsed, false);
});

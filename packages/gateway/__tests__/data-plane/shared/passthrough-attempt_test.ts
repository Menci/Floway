import { Hono } from 'hono';
import { test } from 'vitest';

import { passthroughAttempt } from '../../../src/data-plane/shared/passthrough-attempt.ts';
import type { AuthVars } from '../../../src/middleware/auth.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import type { ProviderCall } from '@floway-dev/provider';
import { assertEquals, assertExists, stubModelCandidate } from '@floway-dev/test-utils';

const observedHeadersForCall = async (providerCall: ProviderCall): Promise<Headers> => {
  const base = stubModelCandidate();
  const candidate = stubModelCandidate({
    provider: { ...base.provider, kind: 'claude-code' },
  });
  let observed: Headers | undefined;
  const app = new Hono<{ Variables: AuthVars }>();
  app.post('/test', async c => {
    await passthroughAttempt({
      c,
      ctx: mockGatewayCtx(),
      candidate,
      operation: 'text_completion',
      providerCall,
      call: async (_provider, _model, opts) => {
        observed = opts.headers;
        return { response: new Response('{}'), modelKey: 'test-model' };
      },
    });
    return c.text('ok');
  });
  await app.request('/test', {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'user-agent': 'claude-cli/2.1.181',
      'x-debug': 'discard',
    },
  });
  assertExists(observed);
  return observed;
};

test('passthroughAttempt applies the call surface selected by passthroughServe', async () => {
  const messages = await observedHeadersForCall('callMessages');
  const responses = await observedHeadersForCall('callResponses');

  assertEquals(Object.fromEntries(messages), { 'user-agent': 'claude-cli/2.1.181' });
  assertEquals([...responses], []);
});

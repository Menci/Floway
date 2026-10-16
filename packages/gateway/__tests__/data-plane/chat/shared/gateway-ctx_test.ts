import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { createNonOpenAIResponsesSourceStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { createChatGatewayCtxFromHono } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { createSidecarCodecFactory, SidecarKind } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import type { ApiKey } from '../../../../src/repo/types.ts';
test('creates one reusable sidecar codec factory from the authenticated key without exposing its secret', async () => {
  const apiKey: ApiKey = {
    id: 'key', userId: 1, name: 'test', key: 'test-key', serverSecret: '11'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, deletedAt: null,
    dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0,
  };
  const app = new Hono<{
    Variables: AuthVars;
  }>().get('/', async c => {
    c.set('apiKey', apiKey);
    const ctx = createChatGatewayCtxFromHono(c, {
      wantsStream: false, requestBody: { bytes: new Uint8Array(), streamError: null },
      backgroundScheduler: promise => { void promise; },
    }, key => createNonOpenAIResponsesSourceStore(key.id));
    const factory = ctx.sidecarCodecFactory;
    expect(Object.hasOwn(ctx, 'serverSecret')).toBe(false);
    const encoded = await factory.getForKind(SidecarKind.TranslateRoundTrip).encode({ value: 1 });
    expect(ctx.sidecarCodecFactory).toBe(factory);
    expect(await ctx.sidecarCodecFactory.getForKind(SidecarKind.TranslateRoundTrip).decode(encoded)).toEqual({ payload: { value: 1 } });
    expect(await createSidecarCodecFactory(apiKey.serverSecret).getForKind(SidecarKind.TranslateRoundTrip).decode(encoded)).toEqual({ payload: { value: 1 } });
    expect(await createSidecarCodecFactory('22'.repeat(32)).getForKind(SidecarKind.TranslateRoundTrip).decode(encoded)).toBeUndefined();
    return c.text('ok');
  });
  expect((await app.request('/')).status).toBe(200);
});

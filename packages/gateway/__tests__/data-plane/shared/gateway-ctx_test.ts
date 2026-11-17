import { Hono } from 'hono';
import { describe, test } from 'vitest';

import { createGatewayCtxFromHono } from '../../../src/data-plane/shared/gateway-ctx.ts';
import type { RequestBody } from '../../../src/data-plane/shared/request-body.ts';
import type { AuthVars } from '../../../src/middleware/auth.ts';
import type { ApiKey, User } from '../../../src/repo/types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const EMPTY_REQUEST_BODY: RequestBody = { bytes: new Uint8Array(), streamError: null };
const NOOP_SCHEDULER: BackgroundScheduler = () => {};

const buildApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 'test-key',
  userId: 1,
  name: 'test',
  key: 'sk-test',
  serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
  ...overrides,
});

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: 1,
  username: 'tester',
  passwordHash: null,
  isAdmin: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  ...overrides,
});

// Mirrors the production guarantee: by the time a data-plane handler runs,
// auth middleware has stamped apiKey + user on the context. Tests that want to
// model an unrestricted key can rely on the defaults; tests that want to
// model a narrowed key override it at the handler.
const makeApp = (): Hono<{ Variables: AuthVars }> => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', buildApiKey());
    c.set('user', buildUser());
    await next();
  });
  return app;
};

describe('createGatewayCtxFromHono', () => {
  test('caller-supplied downstreamAbortController overrides the factory-minted one (websocket path)', async () => {
    const app = makeApp();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    let controller: AbortController | undefined;
    app.get('/test', c => {
      controller = new AbortController();
      ctx = createGatewayCtxFromHono(c, { wantsStream: true, downstreamAbortController: controller, requestBody: EMPTY_REQUEST_BODY, backgroundScheduler: NOOP_SCHEDULER });
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(controller);
    assertEquals(ctx.downstreamAbortController, controller);
    assertEquals(ctx.abortSignal, controller.signal);
    assertEquals(ctx.wantsStream, true);
  });
});

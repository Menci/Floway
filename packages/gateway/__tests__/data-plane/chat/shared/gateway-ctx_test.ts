import { Hono } from 'hono';
import { test } from 'vitest';

import { createNonResponsesSourceStore } from '../../../../../src/data-plane/chat/responses/items/store.ts';
import { createChatGatewayCtxFromHono } from '../../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import type { OwnedRequestBody } from '../../../../../src/data-plane/shared/request-body.ts';
import type { AuthVars } from '../../../../../src/middleware/auth.ts';
import type { ApiKey, User } from '../../../../../src/repo/types.ts';
import { observeExecutionTimers } from '../../shared/execution-timer-audit.ts';
import { assertEquals } from '@floway-dev/test-utils';

const EMPTY_REQUEST_BODY: OwnedRequestBody = { bytes: new Uint8Array(), streamError: null };
const NOOP_SCHEDULER = () => {};

const buildApiKey = (serverSecret: string): ApiKey => ({
  id: 'test-key',
  userId: 1,
  name: 'test',
  key: 'sk-test',
  serverSecret,
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: 0,
});

const user: User = {
  id: 1,
  username: 'tester',
  passwordHash: null,
  isAdmin: false,
  upstreamIds: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

const requestConstruction = async (
  serverSecret: string,
  storeFactory: Parameters<typeof createChatGatewayCtxFromHono>[2],
): Promise<unknown> => {
  const app = new Hono<{ Variables: AuthVars }>();
  let caught: unknown;
  app.get('/test', c => {
    c.set('apiKey', buildApiKey(serverSecret));
    c.set('user', user);
    try {
      createChatGatewayCtxFromHono(c, {
        wantsStream: false,
        requestBody: EMPTY_REQUEST_BODY,
        backgroundScheduler: NOOP_SCHEDULER,
      }, storeFactory);
    } catch (error) {
      caught = error;
    }
    return c.text('ok');
  });
  await app.request('/test');
  return caught;
};

test('rejects a corrupt affinity secret before starting the base lifecycle', async () => {
  const timers = observeExecutionTimers();
  try {
    const error = await requestConstruction('invalid persisted secret', apiKey => createNonResponsesSourceStore(apiKey.id));
    assertEquals(error instanceof TypeError, true);
    timers.assertNoLifecycleStarted();
  } finally {
    timers.cleanup();
  }
});

test('rejects a store construction failure before starting the base lifecycle', async () => {
  const timers = observeExecutionTimers();
  const failure = new Error('store construction failed');
  try {
    const error = await requestConstruction('00'.repeat(32), () => { throw failure; });
    assertEquals(error, failure);
    timers.assertNoLifecycleStarted();
  } finally {
    timers.cleanup();
  }
});

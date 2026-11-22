import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { geminiGenerateContentHttp } from '../../../../src/data-plane/chat/gemini-generate-content/http.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { assertEquals } from '@floway-dev/test-utils';

const app = (): Hono<{ Variables: AuthVars }> => {
  const result = new Hono<{ Variables: AuthVars }>();
  const apiKey: ApiKey = {
    id: 'key_gemini_boundary',
    userId: 1,
    name: 'boundary',
    key: 'raw-boundary',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null,
    randomizeUpstreams: false,
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
  };
  const user: User = {
    id: 1,
    username: 'boundary',
    passwordHash: null,
    isAdmin: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  };
  result.use('*', async (c, next) => {
    c.set('apiKey', apiKey);
    c.set('user', user);
    await next();
  });
  for (const version of ['v1', 'v1beta']) {
    result.post(`/${version}/models/:modelAction{.+}`, geminiGenerateContentHttp);
  }
  return result;
};

test('rejects an unknown Gemini model action with a 404 Google RPC envelope', async () => {
  initRepo(new InMemoryRepo());
  const response = await app().request('/v1beta/models/public-model:unknownAction', { method: 'POST' });
  assertEquals(response.status, 404);
  assertEquals(await response.json(), {
    error: {
      code: 404,
      message: 'Unknown Gemini model action: unknownAction',
      status: 'NOT_FOUND',
    },
  });
});

test.each(['generateContent', 'countTokens'])('malformed %s JSON returns a 500 Google RPC envelope', async action => {
  initRepo(new InMemoryRepo());
  const response = await app().request(`/v1/models/public-model:${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assertEquals(response.status, 500);
  expect(await response.json()).toMatchObject({
    error: { code: 500, status: 'INTERNAL' },
  });
});

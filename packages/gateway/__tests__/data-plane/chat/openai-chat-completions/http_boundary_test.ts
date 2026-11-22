import { Hono } from 'hono';
import { test } from 'vitest';

import { openaiChatCompletionsHttp } from '../../../../src/data-plane/chat/openai-chat-completions/http.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { assertEquals } from '@floway-dev/test-utils';

const app = (): Hono<{ Variables: AuthVars }> => {
  const result = new Hono<{ Variables: AuthVars }>();
  const apiKey: ApiKey = {
    id: 'key_http_boundary',
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
  result.post('/v1/chat/completions', openaiChatCompletionsHttp.generate);
  return result;
};

test.each(['prompt_cache_options', 'user'] as const)('rejects null %s before entering the pipeline', async field => {
  initRepo(new InMemoryRepo());
  const response = await app().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }], [field]: null }),
  });
  assertEquals(response.status, 400);
  assertEquals((await response.json() as { error: unknown }).error, {
    message: `Invalid '${field}': expected ${field === 'user' ? 'a string' : 'an object'} when present.`,
    type: 'invalid_request_error',
    param: field,
    code: null,
  });
});

test('malformed JSON returns the OpenAI internal-error envelope', async () => {
  initRepo(new InMemoryRepo());
  const response = await app().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assertEquals(response.status, 502);
  assertEquals((await response.json() as { error: { type: string } }).error.type, 'internal_error');
});

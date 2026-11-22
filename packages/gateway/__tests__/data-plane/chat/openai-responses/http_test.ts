import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS } from './test-policy.ts';
import { openaiResponsesHttp } from '../../../../src/data-plane/chat/openai-responses/http.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';

const API_KEY_ID = 'key_http_test';
const apiKey: ApiKey = { id: API_KEY_ID, userId: 1, name: 'http_test', key: 'sk-http-test', serverSecret: '00'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, randomizeUpstreams: false, deletedAt: null, dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS };
const user: User = { id: 1, username: 'http_test', passwordHash: null, isAdmin: false, createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null };

const makeApp = (): Hono<{ Variables: AuthVars }> => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => { c.set('apiKey', apiKey); c.set('user', user); await next(); });
  app.post('/v1/responses', openaiResponsesHttp.generate);
  app.post('/v1/responses/compact', openaiResponsesHttp.compact);
  return app;
};

test('generate returns the OpenAI 400 envelope for a payload without input', async () => {
  const repo = new InMemoryRepo(); initRepo(repo); await repo.apiKeys.save(apiKey);
  const response = await makeApp().request('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm' }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error' } });
});

test('generate reports a missing model as a 404 through the pipeline edge', async () => {
  const repo = new InMemoryRepo(); initRepo(repo); await repo.apiKeys.save(apiKey);
  const response = await makeApp().request('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'missing', input: 'hello', stream: false }) });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { message: 'Model missing is not available on any configured upstream.' } });
});

test('compact uses the compact route and rejects malformed JSON with a 502 internal envelope', async () => {
  const repo = new InMemoryRepo(); initRepo(repo); await repo.apiKeys.save(apiKey);
  const response = await makeApp().request('/v1/responses/compact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: { type: 'internal_error' } });
});

import { Hono } from 'hono';
import { afterEach, test, vi } from 'vitest';

import { observeExecutionTimers } from '../../shared/execution-timer-audit.ts';
import { initDumpBroker, initDumpStore } from '../../../../../src/dump/registry.ts';
import type { AuthVars } from '../../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../../src/repo/types.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const enumerateModelCandidates = vi.hoisted(() => vi.fn());
vi.mock('../../../../../src/data-plane/providers/resolution.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../../src/data-plane/providers/resolution.ts')>();
  return { ...original, enumerateModelCandidates };
});

const { chatCompletionsHttp } = await import('../../../../../src/data-plane/chat/chat-completions/http.ts');
const { messagesHttp } = await import('../../../../../src/data-plane/chat/messages/http.ts');
const { responsesHttp } = await import('../../../../../src/data-plane/chat/responses/http.ts');

const API_KEY_ID = 'key_http_finalization_test';

const buildApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: API_KEY_ID,
  userId: 1,
  name: 'http_finalization_test',
  key: 'sk-http-finalization-test',
  serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: 3600,
  responsesRetentionSeconds: 0,
  ...overrides,
});

const user: User = {
  id: 1,
  username: 'http_finalization_test',
  passwordHash: null,
  isAdmin: false,
  upstreamIds: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

const makeApp = (apiKey = buildApiKey()): Hono<{ Variables: AuthVars }> => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', apiKey);
    c.set('user', user);
    await next();
  });
  app.post('/v1/chat/completions', chatCompletionsHttp.generate);
  app.post('/v1/messages', messagesHttp.generate);
  app.post('/v1/messages/count_tokens', messagesHttp.countTokens);
  app.post('/v1/responses', responsesHttp.generate);
  app.post('/v1/responses/compact', responsesHttp.compact);
  return app;
};

interface CatalogFailureCase {
  readonly name: string;
  readonly path: string;
  readonly body: unknown;
}

const catalogFailureCases: readonly CatalogFailureCase[] = [
  {
    name: 'Chat Completions generate',
    path: '/v1/chat/completions',
    body: { model: 'catalog-model', messages: [{ role: 'user', content: 'hello' }] },
  },
  {
    name: 'Messages generate',
    path: '/v1/messages',
    body: { model: 'catalog-model', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
  },
  {
    name: 'Messages count_tokens',
    path: '/v1/messages/count_tokens',
    body: { model: 'catalog-model', messages: [{ role: 'user', content: 'hello' }] },
  },
  {
    name: 'Responses generate',
    path: '/v1/responses',
    body: { model: 'catalog-model', input: 'hello', store: false },
  },
  {
    name: 'Responses compact',
    path: '/v1/responses/compact',
    body: { model: 'catalog-model', input: 'hello', store: false },
  },
];

afterEach(async () => {
  await flushBackground();
  enumerateModelCandidates.mockReset();
});

test.each(catalogFailureCases)('$name finalizes a verbatim catalog failure exactly once', async ({ path, body }) => {
  initRepo(new InMemoryRepo());
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const catalogBody = '{"error":"catalog unavailable"}';
  enumerateModelCandidates.mockRejectedValueOnce(new ProviderModelsUnavailableError({
    status: 503,
    headers: new Headers({ 'content-type': 'application/json', 'x-catalog-error': 'upstream-models' }),
    body: catalogBody,
  }));
  const timers = observeExecutionTimers();
  const requestBody = JSON.stringify(body);
  try {
    const response = await makeApp().request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });

    assertEquals(response.status, 503);
    assertEquals(response.headers.get('x-catalog-error'), 'upstream-models');
    assertEquals(await response.text(), catalogBody);
    await flushBackground();

    timers.assertLifecycleCount(1);
    assertEquals(dumps.stored.length, 1);
    const stored = dumps.stored[0];
    assertEquals(stored.keyId, API_KEY_ID);
    assertEquals(stored.record.meta.status, 503);
    assertEquals(stored.record.meta.model, 'catalog-model');
    assertEquals(stored.record.meta.requestBytes, new TextEncoder().encode(requestBody).byteLength);
    assertEquals(stored.record.meta.error?.kind, 'failed');
  } finally {
    timers.cleanup();
  }
});

test('a corrupt affinity secret leaves only the finalized fallback lifecycle', async () => {
  initRepo(new InMemoryRepo());
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const timers = observeExecutionTimers();
  const requestBody = JSON.stringify({ model: 'catalog-model', messages: [{ role: 'user', content: 'hello' }] });
  try {
    const response = await makeApp(buildApiKey({ serverSecret: 'invalid persisted secret' })).request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });

    assertEquals(response.status, 502);
    await response.text();
    await flushBackground();

    timers.assertLifecycleCount(1);
    assertEquals(enumerateModelCandidates.mock.calls.length, 0);
    assertEquals(dumps.stored.length, 1);
    assertEquals(dumps.stored[0].record.meta.requestBytes, new TextEncoder().encode(requestBody).byteLength);
  } finally {
    timers.cleanup();
  }
});

import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { app as gatewayApp } from '../../../../src/app.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import type { AuthedContext, AuthVars } from '../../../../src/middleware/auth.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { setupAppTest } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

test('the app error fallback finalizes a request dump that was created before the throw', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const run = vi.spyOn(await import('../../../../src/data-plane/pipeline/edge.ts'), 'runGatewayHttpPipeline')
    .mockRejectedValueOnce(new Error('unhandled pipeline failure'));
  let response: Response;
  try {
    response = await gatewayApp.request('/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'lifecycle-model', input: 'hello' }),
    });
  } finally {
    run.mockRestore();
  }
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { message: 'unhandled pipeline failure' } });
  await flushBackground();

  expect(dumps.stored).toHaveLength(1);
  expect(dumps.stored[0]?.meta).toMatchObject({
    status: 500,
    model: 'lifecycle-model',
    error: { kind: 'failed', reason: 'unhandled pipeline failure' },
  });
});

test.each(['responses', 'chat', 'anthropic'] as const)(
  'provider model failures finalize the already-created %s dump with the verbatim upstream response',
  async kind => {
    const { apiKey, repo } = await setupAppTest();
    const retainedApiKey = { ...apiKey, dumpRetentionSeconds: 3600 };
    await repo.apiKeys.save(retainedApiKey);
    const dumps = installDumpStubs(initDumpStore, initDumpBroker);
    const user = await repo.users.getById(apiKey.userId);
    if (user === null) throw new Error('Missing lifecycle test user');
    const app = new Hono<{ Variables: AuthVars }>();
    app.use('*', async (c, next) => {
      c.set('apiKey', retainedApiKey);
      c.set('user', user);
      await next();
    });
    const error = new ProviderModelsUnavailableError({
      status: 429,
      headers: new Headers({ 'retry-after': '7', 'set-cookie': 'private=1' }),
      body: 'models unavailable',
    });
    const run = vi.spyOn(await import('../../../../src/data-plane/pipeline/edge.ts'), 'runGatewayHttpPipeline')
      .mockRejectedValue(error);
    const route = kind === 'responses'
      ? {
          path: '/v1/responses',
          payload: { model: 'lifecycle-model', input: 'hello' },
          handler: async (c: AuthedContext): Promise<Response> =>
            await (await import('../../../../src/data-plane/chat/openai-responses/http.ts')).openaiResponsesHttp.generate(c),
        }
      : kind === 'chat'
        ? {
            path: '/v1/chat/completions',
            payload: { model: 'lifecycle-model', messages: [{ role: 'user', content: 'hello' }] },
            handler: async (c: AuthedContext): Promise<Response> =>
              await (await import('../../../../src/data-plane/chat/openai-chat-completions/http.ts')).openaiChatCompletionsHttp.generate(c),
          }
        : {
            path: '/v1/messages',
            payload: { model: 'lifecycle-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] },
            handler: async (c: AuthedContext): Promise<Response> =>
              await (await import('../../../../src/data-plane/chat/anthropic-messages/http.ts')).anthropicMessagesHttp.generate(c),
          };
    try {
      app.post(route.path, route.handler);
      const response = await app.request(route.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(route.payload),
      });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('7');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.text()).toBe('models unavailable');
    } finally {
      run.mockRestore();
    }
    await flushBackground();

    expect(dumps.stored).toHaveLength(1);
    expect(dumps.stored[0]?.meta).toMatchObject({
      status: 429,
      error: { kind: 'upstream' },
    });
  },
);

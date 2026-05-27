import { test } from 'vitest';

import { clearCopilotTokenCache } from '../../../../../shared/copilot.ts';
import { assertEquals, assertExists } from '../../../../../test-assert.ts';
import { buildCustomUpstreamRecord, copilotModels, jsonResponse, requestApp, setupAppTest, withMockedFetch } from '../../../../../test-helpers.ts';
import { clearModelsStore } from '../../../../providers/models-store.ts';

test('/v1beta/models/:model:countTokens translates Gemini request to Messages count_tokens', async () => {
  const { apiKey } = await setupAppTest();
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-count', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages/count_tokens') {
        upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return jsonResponse({ input_tokens: 17 });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/claude-count:countTokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          generateContentRequest: {
            systemInstruction: { parts: [{ text: 'system' }] },
            contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            generationConfig: { maxOutputTokens: 123 },
          },
        }),
      });

      assertEquals(response.status, 200);
      assertEquals(await response.json(), { totalTokens: 17 });
    },
  );

  assertExists(upstreamBody);
  assertEquals(upstreamBody.model, 'claude-count');
  assertEquals(upstreamBody.system, 'system');
  assertEquals(upstreamBody.max_tokens, 123);
  assertEquals(upstreamBody.messages, [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    },
  ]);
});

test('/v1beta/models/:model:countTokens supports top-level contents', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-count-top', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages/count_tokens') {
        return jsonResponse({ total_tokens: 19 });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/claude-count-top:countTokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        }),
      });

      assertEquals(response.status, 200);
      assertEquals(await response.json(), { totalTokens: 19 });
    },
  );
});

test('/v1beta/models/:model:countTokens internal failures include debug fields', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-count-invalid', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages/count_tokens') {
        return jsonResponse({ unexpected: true });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/claude-count-invalid:countTokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        }),
      });

      assertEquals(response.status, 502);
      const body = await response.json();
      assertEquals(body.error.code, 502);
      assertEquals(body.error.status, 'UNAVAILABLE');
      assertEquals(body.error.type, 'internal_error');
      assertEquals(body.error.name, 'Error');
      assertEquals(body.error.source_api, 'gemini');
      assertExists(body.error.stack);
    },
  );
});

test('/v1beta/models/:model:countTokens rejects custom-upstream-only models', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_custom',
    name: 'Custom Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    config: {
      baseUrl: 'https://custom.example.com',
      bearerToken: 'sk-custom',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'custom-chat-model' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/custom-chat-model:countTokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        }),
      });

      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body.error.code, 400);
      assertEquals(body.error.status, 'INVALID_ARGUMENT');
      assertEquals(body.error.message.includes('does not support countTokens'), true);
    },
  );
});

test('/v1beta/models/:model:countTokens preserves custom upstream /models HTTP errors', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_custom',
    name: 'Custom Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    config: {
      baseUrl: 'https://custom.example.com',
      bearerToken: 'sk-custom',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: { message: 'bad custom key' } }, 401);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/custom-chat-model:countTokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        }),
      });

      assertEquals(response.status, 401);
      const body = await response.json();
      assertEquals(body.error.code, 401);
      assertEquals(body.error.status, 'UNAUTHENTICATED');
      assertEquals(body.error.message.includes('bad custom key'), true);
    },
  );
});

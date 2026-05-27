import { test } from 'vitest';

import { clearCopilotTokenCache } from '../../../../../shared/copilot.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { buildCustomUpstreamRecord, copilotModels, jsonResponse, requestApp, setupAppTest, withMockedFetch } from '../../../../../test-helpers.ts';
import { clearModelsStore } from '../../../../providers/models-store.ts';

function copilotTokenResponse() {
  return jsonResponse({
    token: 'fake-copilot-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_in: 1800,
  });
}

test('/v1/messages/count_tokens proxies to Copilot upstream', async () => {
  const { apiKey } = await setupAppTest();
  let capturedPath = '';

  await withMockedFetch(
    req => {
      const url = new URL(req.url);
      if (url.hostname === 'api.github.com') return copilotTokenResponse();
      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-sonnet-4', supported_endpoints: ['/v1/messages'] }]));
      }
      capturedPath = url.pathname;
      return jsonResponse({ input_tokens: 42 });
    },
    async () => {
      const response = await requestApp('/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 200);
      assertEquals(await response.json(), { input_tokens: 42 });
      assertEquals(capturedPath, '/v1/messages/count_tokens');
    },
  );
});

test('/v1/messages/count_tokens rejects body anthropic_beta', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey.key,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4',
      max_tokens: 64,
      anthropic_beta: ['context-1m-2025-08-07'],
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'anthropic_beta');
});

test('/v1/messages/count_tokens rejects body betas', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey.key,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4',
      max_tokens: 64,
      betas: ['context-1m-2025-08-07'],
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'betas');
});

test('/messages/count_tokens aliases /v1/messages/count_tokens', async () => {
  const { apiKey } = await setupAppTest();
  let capturedPath = '';

  await withMockedFetch(
    req => {
      const url = new URL(req.url);
      if (url.hostname === 'api.github.com') return copilotTokenResponse();
      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-sonnet-4', supported_endpoints: ['/v1/messages'] }]));
      }
      capturedPath = url.pathname;
      return jsonResponse({ input_tokens: 24 });
    },
    async () => {
      const response = await requestApp('/messages/count_tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 200);
      assertEquals(await response.json(), { input_tokens: 24 });
      assertEquals(capturedPath, '/v1/messages/count_tokens');
    },
  );
});

test('/v1/messages/count_tokens proxies to Azure Foundry Anthropic endpoint', async () => {
  const { repo, apiKey, copilotUpstream } = await setupAppTest();
  await repo.upstreams.delete(copilotUpstream.id);
  await repo.upstreams.save({
    id: 'up_azure_messages',
    provider: 'azure',
    name: 'Azure Messages',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    config: {
      endpoint: 'https://example.services.ai.azure.com/anthropic',
      apiKey: 'az-key',
      deployments: [
        {
          deployment: 'claude-prod',
          publicModelId: 'claude-azure',
          supportedEndpoints: ['/v1/messages'],
        },
      ],
    },
  });

  let capturedPath = '';
  let capturedApiKey: string | null = null;
  let capturedBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      capturedPath = url.pathname;
      capturedApiKey = request.headers.get('x-api-key');
      capturedBody = (await request.json()) as Record<string, unknown>;
      return jsonResponse({ input_tokens: 88 });
    },
    async () => {
      const response = await requestApp('/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
          'anthropic-beta': 'context-1m',
        },
        body: JSON.stringify({
          model: 'claude-azure',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 200);
      assertEquals(await response.json(), { input_tokens: 88 });
    },
  );

  assertEquals(capturedPath, '/anthropic/v1/messages/count_tokens');
  assertEquals(capturedApiKey, 'az-key');
  assertEquals(capturedBody?.model, 'claude-prod');
});

test('/v1/messages/count_tokens resolves Claude compatibility models before proxying', async () => {
  const { apiKey } = await setupAppTest();
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async req => {
      const url = new URL(req.url);
      if (url.hostname === 'api.github.com') return copilotTokenResponse();
      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            { id: 'claude-opus-4.7', supported_endpoints: ['/v1/messages'] },
            {
              id: 'claude-opus-4.7-1m-internal',
              supported_endpoints: ['/v1/messages'],
              maxContextWindowTokens: 1_000_000,
              maxPromptTokens: 936_000,
              maxOutputTokens: 64_000,
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages/count_tokens') {
        upstreamBody = JSON.parse(await req.text()) as Record<string, unknown>;
        return jsonResponse({ input_tokens: 64 });
      }
      throw new Error(`Unhandled fetch ${req.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
          'anthropic-beta': 'context-1m-2025-08-07',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 200);
      assertEquals(await response.json(), { input_tokens: 64 });
    },
  );

  assertEquals(upstreamBody?.model, 'claude-opus-4.7-1m-internal');
});

test('/v1/messages/count_tokens rejects custom-upstream-only models', async () => {
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
      const response = await requestApp('/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-chat-model',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body.error.type, 'invalid_request_error');
      assertEquals(body.error.message.includes('does not support the /messages/count_tokens endpoint'), true);
    },
  );
});

test('/v1/messages/count_tokens preserves custom upstream /models HTTP errors', async () => {
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
      const response = await requestApp('/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-chat-model',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 401);
      assertEquals(await response.json(), {
        error: { message: 'bad custom key' },
      });
    },
  );
});

// Path A moved Copilot's anthropic-beta allow-list filter from the provider
// call helper onto a Messages target interceptor. Count-tokens runs the
// dedicated `messagesCountTokens` interceptor list so the same filter applies
// here; the unfiltered beta is also threaded through to variant selection so
// `context-1m-2025-08-07` still resolves to the 1m-internal raw variant even
// though that beta value is dropped before hitting the wire.
test('/v1/messages/count_tokens filters Copilot anthropic-beta to the allow-list on the wire', async () => {
  const { apiKey } = await setupAppTest();
  let upstreamBeta: string | null = null;

  await withMockedFetch(
    req => {
      const url = new URL(req.url);
      if (url.hostname === 'api.github.com') return copilotTokenResponse();
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-sonnet-4', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages/count_tokens') {
        upstreamBeta = req.headers.get('anthropic-beta');
        return jsonResponse({ input_tokens: 7 });
      }
      throw new Error(`Unhandled fetch ${req.url}`);
    },
    async () => {
      const response = await requestApp('/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
          'anthropic-beta': 'foo-not-in-allow-list,interleaved-thinking-2025-05-14,context-management-2025-06-27',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      assertEquals(response.status, 200);
    },
  );

  // foo-not-in-allow-list must be stripped; only the two allow-listed values
  // reach the upstream HTTP request, in the order the client sent them.
  assertEquals(upstreamBeta, 'interleaved-thinking-2025-05-14,context-management-2025-06-27');
});

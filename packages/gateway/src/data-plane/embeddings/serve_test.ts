import { test } from 'vitest';

import { buildCustomUpstreamRecord, copilotModels, flushAsyncWork, requestApp, setupAppTest } from '../../test-helpers.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { jsonResponse, withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

test('/v1/embeddings wraps scalar string input for Copilot upstream', async () => {
  const { apiKey } = await setupAppTest();
  let forwardedBody:
    | {
      model?: unknown;
      input?: unknown;
      encoding_format?: unknown;
    }
    | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'text-embedding-real', supported_endpoints: ['/embeddings'] }]));
      }
      if (url.pathname === '/embeddings') {
        forwardedBody = (await request.json()) as Record<string, unknown>;
        return jsonResponse({
          object: 'list',
          model: 'text-embedding-real',
          data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'text-embedding-real',
          input: 'hello',
          encoding_format: 'float',
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  assertExists(forwardedBody);
  assertEquals(forwardedBody.model, 'text-embedding-real');
  assertEquals(forwardedBody.input, ['hello']);
  assertEquals(forwardedBody.encoding_format, 'float');
});

test('/v1/embeddings records usage under request model when upstream omits model', async () => {
  const { apiKey, repo } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'text-embedding-real', supported_endpoints: ['/embeddings'] }]));
      }
      if (url.pathname === '/embeddings') {
        return jsonResponse({
          data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'text-embedding-real',
          input: 'hello',
          encoding_format: 'float',
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  await flushAsyncWork();

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0].model, 'text-embedding-real');
  assertEquals(usage[0].tokens.input, 1);

  const performanceRows = await repo.performance.listAll();
  const requestTotal = performanceRows.find(row => row.metricScope === 'request_total');
  const upstreamSuccess = performanceRows.find(row => row.metricScope === 'upstream_success');
  assertExists(requestTotal);
  assertExists(upstreamSuccess);
  assertEquals(requestTotal.model, 'text-embedding-real');
  assertEquals(requestTotal.requests, 1);
  assertEquals(requestTotal.errors, 0);
  assertEquals(upstreamSuccess.model, 'text-embedding-real');
  assertEquals(upstreamSuccess.requests, 1);
  assertEquals(upstreamSuccess.errors, 0);
});

test('/v1/embeddings records request and upstream performance', async () => {
  const { apiKey, copilotUpstream, repo } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'text-embedding-real', supported_endpoints: ['/embeddings'] }]));
      }
      if (url.pathname === '/embeddings') {
        return jsonResponse({
          data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'text-embedding-real',
          input: 'hello',
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  await flushAsyncWork();

  const records = await repo.performance.listAll();
  const scopes = records.map(record => record.metricScope).sort();
  assertEquals(scopes, ['request_total', 'upstream_success']);
  for (const record of records) {
    assertEquals(record.keyId, apiKey.id);
    assertEquals(record.model, 'text-embedding-real');
    assertEquals(record.upstream, copilotUpstream.id);
    assertEquals(record.modelKey, 'text-embedding-real');
    assertEquals(record.stream, false);
    assertEquals(record.requests, 1);
    assertEquals(record.errors, 0);
  }
});

test('/v1/embeddings routes to custom upstream when model is only declared there', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_embed',
    name: 'Embedding Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: {
      baseUrl: 'https://embed.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-embed',
      endpoints: {},
    },
  }));

  let forwardedUrl: string | undefined;
  let forwardedBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'embed.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'custom-embed-model' }],
        });
      }
      if (url.hostname === 'embed.example.com' && url.pathname === '/v1/embeddings') {
        forwardedUrl = request.url;
        forwardedBody = (await request.json()) as Record<string, unknown>;
        return jsonResponse({
          object: 'list',
          model: 'custom-embed-model',
          data: [{ object: 'embedding', index: 0, embedding: [0.42] }],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-embed-model',
          input: 'hello world',
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.data[0].embedding, [0.42]);
    },
  );

  assertExists(forwardedUrl);
  assertEquals(new URL(forwardedUrl).hostname, 'embed.example.com');
  assertExists(forwardedBody);
  assertEquals(forwardedBody.model, 'custom-embed-model');
  assertEquals(forwardedBody.input, 'hello world');
});

test('/v1/embeddings rejects model on custom upstream without /embeddings capability', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_chat_only',
    name: 'Chat Only Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: {
      baseUrl: 'https://chat.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-chat',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'chat.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'chat-model' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'chat-model',
          input: 'hello',
        }),
      });

      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body.error.message, 'Model chat-model does not support the /embeddings endpoint.');
    },
  );
});

// A custom upstream whose `/v1/models` fetch rejects is treated as
// temporarily empty: the request resolves to 404 model-missing with the
// failing upstream's display name appended parenthetically, instead of
// the gateway forwarding the upstream's raw HTTP status to the client.
test('/v1/embeddings reports the failed upstream parenthetically when /v1/models rejects', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_embed',
    name: 'Embedding Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: {
      baseUrl: 'https://embed.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-embed',
      endpoints: {},
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'embed.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: { message: 'bad embed key' } }, 403);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-embed-model',
          input: 'hello',
        }),
      });

      assertEquals(response.status, 404);
      assertEquals(await response.json(), {
        error: {
          message: 'Model custom-embed-model is not available on any configured upstream (models from upstream(s) "Embedding Provider" failed to load).',
          type: 'api_error',
        },
      });
    },
  );
});

// Even when a second upstream's catalog loads successfully (and so its
// models are routable), the rejected upstream's name still surfaces in
// the model-missing body so the operator can tell the failure apart
// from a genuine "no upstream has this model" miss.
test('/v1/embeddings reports the failed upstream even when a sibling upstream\'s catalog loads', async () => {
  const { apiKey, repo } = await setupAppTest();
  clearInProcessCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_embed',
    name: 'Embedding Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: {
      baseUrl: 'https://embed.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-embed',
      endpoints: {},
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'embed.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: { message: 'bad embed key' } }, 403);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-embed-model',
          input: 'hello',
        }),
      });

      assertEquals(response.status, 404);
      const body = await response.json();
      assertEquals(body.error.message, 'Model custom-embed-model is not available on any configured upstream (models from upstream(s) "Embedding Provider" failed to load).');
    },
  );
});

test('/v1/embeddings rejects malformed body at the provider-independent boundary', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'text-embedding-real', supported_endpoints: ['/embeddings'] }]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: 'not valid json',
      });

      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body.error.type, 'api_error');
    },
  );
});

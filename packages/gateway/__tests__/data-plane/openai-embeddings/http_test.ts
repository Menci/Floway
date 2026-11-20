import { expect, test } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, copilotModels, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { jsonResponse, withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

test('/v1/embeddings preserves an upstream success status', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://embeddings.test', apiKey: 'sk-test', ingressHeadersRules: [], endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: 'embedding', kind: 'embedding', endpoints: { openaiEmbeddings: {} } }],
    },
  }));
  await withMockedFetch(async () => jsonResponse({
    object: 'list', model: 'embedding', data: [{ object: 'embedding', index: 0, embedding: [0.5] }],
    usage: { prompt_tokens: 1, total_tokens: 1 },
  }, 201), async () => {
    const response = await requestAppWithWarmModels('/v1/embeddings', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify({ model: 'embedding', input: 'hello', encoding_format: 'float' }),
    });
    assertEquals(response.status, 201);
    assertEquals((await response.json() as { data: unknown[] }).data.length, 1);
  });
});

test.each([
  ['limited', 'success', 200, null, 'second'],
  ['disconnected', 'success', 200, null, 'second'],
  ['limited', 'disconnected', 429, '17', 'first'],
  ['limited', 'unavailable', 429, '17', 'first'],
  ['limited', 'limited-later', 429, '17', 'first'],
  ['limited-later', 'limited', 429, '17', 'second'],
] as const)('/v1/embeddings selects the response after %s then %s on one upstream', async (first, second, status, retryAfter, selected) => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://same-upstream.test', apiKey: 'sk-test', ingressHeadersRules: [], endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: ['first', 'second'].map(upstreamModelId => ({ upstreamModelId, kind: 'embedding', endpoints: { openaiEmbeddings: {} } })),
    },
  }));
  await repo.modelAliases.insert({
    id: 'alias_embedding', name: 'embeddings', kind: 'embedding', selection: 'first-available',
    targets: [{ target_model_id: 'first', rules: {} }, { target_model_id: 'second', rules: {} }],
    displayName: null, visibleInModelsList: true, announcedMetadata: null, sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const dispatched: string[] = [];
  await withMockedFetch(async request => {
    const body = await request.json() as { model: string };
    dispatched.push(body.model);
    const outcome = body.model === 'first' ? first : second;
    if (outcome === 'disconnected') throw new TypeError('fixture connection refused');
    if (outcome === 'success') {
      return jsonResponse({ object: 'list', model: body.model, data: [{ object: 'embedding', index: 0, embedding: [0.5] }], usage: { prompt_tokens: 1, total_tokens: 1 } });
    }
    if (outcome === 'unavailable') return jsonResponse({ error: { message: 'unavailable' } }, 503);
    return new Response(JSON.stringify({ error: { message: body.model } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': outcome === 'limited' ? '17' : '60', 'x-request-id': body.model },
    });
  }, async () => {
    const response = await requestAppWithWarmModels('/v1/embeddings', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify({ model: 'embeddings', input: 'hello', encoding_format: 'float' }),
    });
    assertEquals(response.status, status);
    assertEquals(response.headers.get('retry-after'), retryAfter);
    const body = await response.json() as { data?: unknown[]; error?: { message: string } };
    if (status === 200) assertEquals(body.data?.length, 1);
    else {
      assertEquals(response.headers.get('x-request-id'), selected);
      assertEquals(body.error?.message, selected);
    }
  });
  assertEquals(dispatched, ['first', 'second']);
});

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
      const response = await requestAppWithWarmModels('/v1/embeddings', {
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

// A custom upstream whose `/v1/models` fetch rejects is treated as
// temporarily empty: the request resolves to 404 model-missing and the
// upstream's raw HTTP status never reaches the client.
test('/v1/embeddings reports a missing model when /v1/models rejects', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_embed',
    name: 'Embedding Provider',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: {
      baseUrl: 'https://embed.example.com',
      ingressHeadersRules: [],
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
      const response = await requestAppWithWarmModels('/v1/embeddings', {
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
      expect(await response.json()).toMatchObject({ error: { type: 'api_error' } });
    },
  );
});

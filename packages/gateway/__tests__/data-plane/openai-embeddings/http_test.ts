import { expect, test } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, copilotModels, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';
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

const registerEmbeddingUpstream = async (
  repo: Awaited<ReturnType<typeof setupAppTest>>['repo'],
  id: string,
  sortOrder: number,
): Promise<void> => {
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id,
    sortOrder,
    config: {
      baseUrl: `https://${id}.example.com`,
      apiKey: 'upstream-credential',
      endpoints: {},
      ingressHeadersRules: [{ key: 'x-trace', value: null }],
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: 'embedding-model', endpoints: { openaiEmbeddings: {} } }],
    },
  }));
};

const requestEmbedding = (apiKey: string): Promise<Response> => requestAppWithWarmModels('/v1/embeddings', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'x-goog-api-key': 'unused-floway-credential',
    'x-trace': 'trace-value',
  },
  body: JSON.stringify({ model: 'embedding-model', input: 'hello' }),
});

test('/v1/embeddings meters both candidates and records upstream-reported zero', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await registerEmbeddingUpstream(repo, 'first', 1);
  await registerEmbeddingUpstream(repo, 'second', 2);
  const calls: string[] = [];

  await withMockedFetch(async request => {
    const url = new URL(request.url);
    expect(url.pathname).toBe('/v1/embeddings');
    expect(request.headers.get('x-goog-api-key')).toBeNull();
    expect(request.headers.get('x-api-key')).toBeNull();
    expect(request.headers.get('authorization')).toBe('Bearer upstream-credential');
    expect(request.headers.get('x-trace')).toBe('trace-value');
    expect(await request.json()).toEqual({ model: 'embedding-model', input: 'hello' });
    calls.push(url.hostname);
    if (url.hostname === 'first.example.com') return jsonResponse({ error: { message: 'rejected' } }, 400);
    return new Response('{"data":[],"usage":{"prompt_tokens":0}}', { headers: { 'x-upstream-request-id': 'kept' } });
  }, async () => {
    const response = await requestEmbedding(apiKey.key);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-upstream-request-id')).toBe('kept');
    expect(await response.json()).toEqual({ data: [], usage: { prompt_tokens: 0 } });
  });
  await flushBackground();

  expect(calls).toEqual(['first.example.com', 'second.example.com']);
  expect(await repo.usage.listAll()).toMatchObject([{
    upstream: 'second', modelKey: 'embedding-model', requests: 1, metrics: [{ metric: 'input_tokens', quantity: '0' }],
  }]);
  expect((await repo.apiKeys.getById(apiKey.id))?.lastUsedAt).toEqual(expect.any(String));
  expect(await repo.performance.listAll()).toEqual(expect.arrayContaining([
    expect.objectContaining({ upstream: 'first', operation: 'embeddings', requests: 1, errorsNoOutput: 1 }),
    expect.objectContaining({ upstream: 'second', operation: 'embeddings', requests: 1, neutral: 1 }),
  ]));
});

test.each([
  { wire: '{"vendor_code":9007199254740993}', type: 'application/problem+json', expected: '{"vendor_code":9007199254740993}' },
  { wire: 'vendor declined', type: 'text/plain', expected: '{"error":{"message":"vendor declined","type":"api_error"}}' },
])('/v1/embeddings renders $type upstream failures into JSON', async ({ wire, type, expected }) => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await registerEmbeddingUpstream(repo, 'rejecting', 1);
  await withMockedFetch(() => new Response(wire, {
    status: 422,
    headers: { 'content-type': type, 'x-upstream-request-id': 'failure-id' },
  }), async () => {
    const response = await requestEmbedding(apiKey.key);
    expect(response.status).toBe(422);
    expect(response.headers.get('x-upstream-request-id')).toBe('failure-id');
    expect(await response.text()).toBe(expected);
  });
  await flushBackground();

  expect(await repo.usage.listAll()).toEqual([]);
  expect((await repo.apiKeys.getById(apiKey.id))?.lastUsedAt).toBeUndefined();
  expect(await repo.performance.listAll()).toMatchObject([{ upstream: 'rejecting', errorsNoOutput: 1 }]);
});

test('/v1/embeddings renders the terminal dial failure with its diagnostic envelope', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await registerEmbeddingUpstream(repo, 'unreachable', 1);
  await withMockedFetch(() => { throw new TypeError('connection refused'); }, async () => {
    const response = await requestEmbedding(apiKey.key);
    expect(response.status).toBe(502);
    expect(response.statusText).toBe('Bad Gateway');
    expect(await response.json()).toMatchObject({
      error: { type: 'internal_error', name: 'UpstreamTransportError', message: 'connection refused', cause: { name: 'TypeError' } },
    });
  });
  await flushBackground();

  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toMatchObject([{ upstream: 'unreachable', errorsNoOutput: 1 }]);
});

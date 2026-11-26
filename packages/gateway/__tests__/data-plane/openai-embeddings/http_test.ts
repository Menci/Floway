import { expect, test } from 'vitest';

import { MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { modelsRefreshInputs } from '../../../src/repo/models-refresh-inputs.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, copilotModels, requestApp, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';
import { decodeDump } from '@floway-dev/dump/browser';
import { jsonResponse, stubProviderModel, withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

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

const setupEmbeddingUpstreams = async () => {
  const app = await setupAppTest();
  await app.repo.upstreams.deleteAll();
  for (const [index, id] of ['first', 'second'].entries()) {
    await saveUpstreamForTest(app.repo.upstreams, buildCustomUpstreamRecord({
      id,
      name: id,
      sortOrder: index,
      config: {
        baseUrl: `https://${id}.example.com`,
        apiKey: `upstream-${id}`,
        ingressHeadersRules: [{ key: 'x-client-trace', value: null }],
        endpoints: { openaiEmbeddings: {} },
      },
    }));
    const record = (await app.repo.upstreams.getById(id))!;
    expect(await app.repo.upstreams.publishModelsRefresh({
      id,
      configVersion: record.configVersion,
      cacheEpoch: 0,
      refreshInputs: modelsRefreshInputs(record),
      cache: {
        revision: MODEL_CATALOG_REVISION,
        fetchedAt: Date.now(),
        models: [stubProviderModel({ id: 'vectors', upstreamModelId: 'native-vectors', kind: 'embedding', endpoints: { openaiEmbeddings: {} } })],
      },
    })).toBe(true);
  }
  return app;
};

test('Embeddings retries an upstream error and archives the selected response and original request', async () => {
  const { apiKey, repo } = await setupEmbeddingUpstreams();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const body = '{ "model": "vectors", "input": "hello" }';
  const attempts: string[] = [];

  await withMockedFetch(async request => {
    const host = new URL(request.url).hostname;
    attempts.push(host);
    expect(await request.json()).toMatchObject({ model: 'native-vectors', input: 'hello' });
    expect(request.headers.get('x-api-key')).toBeNull();
    expect(request.headers.get('x-goog-api-key')).toBeNull();
    expect(request.headers.get('x-client-trace')).toBe('forwarded');
    expect(request.headers.get('authorization')).toBe(host === 'first.example.com' ? 'Bearer upstream-first' : 'Bearer upstream-second');
    return host === 'first.example.com'
      ? new Response('upstream rejected the request', { status: 400 })
      : Response.json({ object: 'list', data: [], usage: { prompt_tokens: 0 } }, { headers: { 'x-upstream-trace': 'selected' } });
  }, async () => {
    const response = await requestApp(`/v1/embeddings?key=${encodeURIComponent(apiKey.key)}&client=test`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'unused-floway-header',
        'x-goog-api-key': 'another-floway-header',
        'x-client-trace': 'forwarded',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-upstream-trace')).toBe('selected');
    expect(await response.json()).toMatchObject({ usage: { prompt_tokens: 0 } });
    await flushBackground();
  });

  expect(attempts).toEqual(['first.example.com', 'second.example.com']);
  expect(await repo.usage.listAll()).toMatchObject([{ upstream: 'second', modelKey: 'native-vectors', requests: 1 }]);
  expect(await repo.performance.listAll()).toEqual(expect.arrayContaining([
    expect.objectContaining({ upstream: 'first', requests: 1, errorsNoOutput: 1 }),
    expect.objectContaining({ upstream: 'second', requests: 1, neutral: 1 }),
  ]));
  expect(dumps.published).toMatchObject([{ keyId: apiKey.id, meta: { model: 'vectors', upstream: { id: 'second' }, status: 200, inputTokens: 0 } }]);
  const recordId = dumps.published[0]!.meta.id;
  const download = await requestApp(`/api/dump/keys/${apiKey.id}/records/${recordId}/archive`, { headers: { 'x-api-key': apiKey.key } });
  expect(download.status).toBe(200);
  expect(download.headers.get('content-type')).toBe('application/x-ndjson');
  const archive = await decodeDump(download.body!);
  const root = archive.stages.get(archive.rootStageId)!;
  expect(root.entry.facts['request.http']).toMatchObject({ url: expect.stringMatching(/\/v1\/embeddings\?client=test$/), body: new TextEncoder().encode(body) });
  expect(root.outcome).toMatchObject({ facts: { 'response.candidate': { upstreamId: 'second', model: 'vectors' } } });
});

test('Embeddings exposes a panic with its stack and neither retries nor meters it', async () => {
  const { apiKey, repo } = await setupEmbeddingUpstreams();
  const attempts: string[] = [];
  await withMockedFetch(request => {
    attempts.push(new URL(request.url).hostname);
    throw new Error('embedding handler defect');
  }, async () => {
    const response = await requestApp('/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'vectors', input: 'hello' }),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: {
        message: 'embedding handler defect',
        stack: expect.stringContaining('embedding handler defect'),
      },
    });
    await flushBackground();
  });
  expect(attempts).toEqual(['first.example.com']);
  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toEqual([]);
});

test('Embeddings indexes the requested model on a local routing refusal', async () => {
  const { apiKey, repo } = await setupEmbeddingUpstreams();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const response = await requestApp('/v1/embeddings', {
    method: 'POST',
    body: JSON.stringify({ model: 'missing-vectors', input: 'hello' }),
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
  });
  expect(response.status).toBe(404);
  await flushBackground();
  expect(dumps.published).toMatchObject([
    { meta: { model: 'missing-vectors', upstream: null, error: { kind: 'gateway' } } },
  ]);
});

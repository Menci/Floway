import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { openaiEmbeddings } from '../../../src/data-plane/openai-embeddings/http.ts';
import type { AuthVars } from '../../../src/middleware/auth.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest, warmModelsForTest } from '../../test-utils/app.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';
import type { HttpRequestFact } from '@floway-dev/http';
import type { GatewayFacts, ProviderServices } from '@floway-dev/provider';

const captured = vi.hoisted(() => [] as HttpRequestFact[]);

vi.mock(import('@floway-dev/provider-custom'), async importOriginal => {
  const real = await importOriginal();
  const { factSpace } = await import('@floway-dev/pipeline');
  const { compose, defineStage } = factSpace<GatewayFacts, ProviderServices>();
  const entry = ['request.http', 'provider.upstream', 'provider.model', 'request.openaiEmbeddings'] as const;
  const exit = ['response.http', 'response.openaiEmbeddings', 'response.usageModelKey'] as const;
  const ending = defineStage({
    name: 'record-embeddings-entry',
    request: { needs: entry },
    return: { provides: exit },
    async execute(facts) {
      captured.push(facts['request.http']);
      return {
        'response.http': { status: 200, statusText: '', headers: [], body: null },
        'response.openaiEmbeddings': { kind: 'result', result: { data: [] } },
        'response.usageModelKey': 'vectors',
      };
    },
  });
  return {
    ...real,
    customPipelines: { ...real.customPipelines, openaiEmbeddings: compose('record-embeddings', { entry, exit, stages: [], ending }) },
  };
});

test('Embeddings removes Floway credentials before the recording provider receives its request', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://vectors.example.test',
      apiKey: 'provider-key',
      ingressHeadersRules: [],
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: 'vectors', endpoints: { openaiEmbeddings: {} } }],
    },
  }));
  await warmModelsForTest();
  const user = await repo.users.getById(apiKey.userId);
  if (!user) throw new Error('Expected the API key owner');
  const app = new Hono<{ Variables: AuthVars }>()
    .use('*', async (c, next) => {
      c.set('apiKey', apiKey);
      c.set('user', user);
      await next();
    })
    .post('/v1/embeddings', openaiEmbeddings);
  const body = '{"model":"vectors","input":"hello"}';
  const response = await app.request('/v1/embeddings', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey.key}`,
      'x-api-key': apiKey.key,
      'x-goog-api-key': apiKey.key,
      'x-floway-session': 'session-token',
      'x-request-id': 'embeddings-fixture',
      'content-type': 'application/json',
    },
    body,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: [] });
  expect(captured).toMatchObject([{
    headers: [['content-type', 'application/json'], ['x-request-id', 'embeddings-fixture']],
    body: new TextEncoder().encode(body),
  }]);
  await flushBackground();
});

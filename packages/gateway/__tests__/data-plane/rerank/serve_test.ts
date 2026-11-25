import { expect, test } from 'vitest';

import type { Repo } from '../../../src/repo/types.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';
import type { ModelPricing, RerankTarget } from '@floway-dev/protocols/common';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const addRerankUpstream = async (
  repo: Repo,
  id: string,
  host: string,
  sortOrder: number,
  target: RerankTarget,
  pricing?: ModelPricing,
): Promise<void> => {
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id,
    name: 'Rerank Provider',
    sortOrder,
    config: {
      baseUrl: `https://${host}`,
      ingressHeadersRules: [],
      apiKey: 'sk-rerank',
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{
        upstreamModelId: 'raw-reranker',
        publicModelId: 'public-reranker',
        kind: 'rerank',
        endpoints: { rerank: {} },
        rerankTarget: target,
        ...(pricing === undefined ? {} : { pricing }),
      }],
    },
  }));
};

const saveRerankUpstream = async (repo: Repo, target: RerankTarget, pricing?: ModelPricing): Promise<void> => {
  await repo.upstreams.deleteAll();
  await addRerankUpstream(repo, 'up_rerank', 'rerank.example.com', 1, target, pricing);
};

const requestHeaders = (apiKey: string) => ({
  'content-type': 'application/json',
  'x-api-key': apiKey,
});

test('/v1/rerank translates Cohere v1 to v2 and records Cohere search units', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(
    repo,
    { protocol: 'cohere-v2' },
    { entries: [{ rates: { rerank_searches: '0.002' } }] },
  );

  let upstreamRequest: Request | undefined;
  await withMockedFetch(
    async request => {
      upstreamRequest = request;
      return new Response(JSON.stringify({
        id: 'request-1',
        results: [{ index: 1, relevance_score: 0.9 }],
        meta: { billed_units: { search_units: 3 }, tokens: { input_tokens: 20 } },
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-api-warning': 'trial quota', 'x-request-id': 'upstream-request' } });
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-reranker',
          query: 'query',
          documents: [{ title: 'one', text: 'first' }, { title: 'two', text: 'second' }],
          top_n: 1,
          return_documents: true,
        }),
      });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('x-api-warning'), 'trial quota');
      assertEquals(response.headers.get('x-request-id'), 'upstream-request');
      assertEquals(await response.json(), {
        id: 'request-1',
        results: [{ index: 1, relevance_score: 0.9, document: { title: 'two', text: 'second' } }],
        meta: { billed_units: { search_units: 3 }, tokens: { input_tokens: 20 } },
      });
    },
  );

  assertExists(upstreamRequest);
  assertEquals(new URL(upstreamRequest.url).pathname, '/v2/rerank');
  assertEquals(await upstreamRequest.clone().json(), {
    model: 'raw-reranker',
    query: 'query',
    documents: ['first', 'second'],
    top_n: 1,
  });

  await flushBackground();
  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, [
    { metric: 'input_tokens', quantity: '20', unitPrice: null },
    { metric: 'rerank_searches', quantity: '3', unitPrice: '0.002' },
  ]);
  const performance = await repo.performance.listAll();
  assertEquals(performance[0]?.operation, 'rerank');
  assertEquals(performance[0]?.requests, 1);
  assertEquals(performance[0]?.errorsNoOutput, 0);
});

test('/jina/v1/rerank preserves same-dialect extensions and records token usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(
    repo,
    { protocol: 'jina-v1' },
    { entries: [{ rates: { input_tokens: '0.0000005' } }] },
  );

  let upstreamBody: unknown;
  const upstreamResponse = {
    model: 'raw-reranker',
    object: 'list',
    usage: { total_tokens: 18 },
    results: [{ index: 0, relevance_score: 0.8, document: { text: 'one' }, vendor_result: true }],
    vendor_response: true,
  };
  await withMockedFetch(
    async request => {
      upstreamBody = await request.json();
      return jsonResponse(upstreamResponse);
    },
    async () => {
      const response = await requestAppWithWarmModels('/jina/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-reranker',
          query: 'query',
          documents: ['one'],
          vendor_request: { enabled: true },
        }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), upstreamResponse);
    },
  );
  assertEquals(upstreamBody, {
    model: 'raw-reranker',
    query: 'query',
    documents: ['one'],
    vendor_request: { enabled: true },
  });

  await flushBackground();
  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, [{ metric: 'input_tokens', quantity: '18', unitPrice: '0.0000005' }]);
});

test('target-incompatible source controls return 400 without dispatch', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'cohere-v2' });
  let fetchCalls = 0;

  await withMockedFetch(
    () => {
      fetchCalls++;
      return jsonResponse({ results: [] });
    },
    async () => {
      const response = await requestAppWithWarmModels('/jina/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-reranker',
          query: 'query',
          documents: ['one'],
          return_embeddings: true,
        }),
      });
      assertEquals(response.status, 400);
    },
  );
  assertEquals(fetchCalls, 0);
});

test('cross-protocol success still validates result items before rendering', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'jina-v1' });

  await withMockedFetch(
    () => jsonResponse({
      model: 'raw-reranker',
      object: 'list',
      usage: { total_tokens: 7 },
      results: [{ relevance_score: 0.8 }],
    }),
    async () => {
      const response = await requestAppWithWarmModels('/voyage/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'public-reranker', query: 'query', documents: ['one'] }),
      });
      assertEquals(response.status, 502);
      await response.json();
    },
  );

  await flushBackground();
  const usage = await repo.usage.listAll();
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, [{ metric: 'input_tokens', quantity: '7', unitPrice: null }]);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});

test.each([
  {
    name: 'JSON error',
    second: () => jsonResponse({ error: { code: 'vendor_failure' } }, 400),
    status: 400,
    body: { error: { code: 'vendor_failure' } },
  },
  {
    name: 'text error',
    second: () => new Response('reranker unavailable', { status: 503 }),
    status: 503,
    body: { error: { message: 'reranker unavailable', type: 'api_error' } },
  },
  {
    name: 'rerank result',
    second: () => jsonResponse({ model: 'raw-reranker', object: 'list', results: [{ index: 0, relevance_score: 0.8 }] }),
    status: 200,
    body: { model: 'raw-reranker', object: 'list', data: [{ index: 0, relevance_score: 0.8 }] },
  },
])('/voyage/v1/rerank bills a damaged first result and renders the selected $name', async ({ second, status, body }) => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'jina-v1' }, { entries: [{ rates: { input_tokens: '0.0000005' } }] });
  await addRerankUpstream(repo, 'second', 'second.example.com', 2, { protocol: 'jina-v1' });
  const calls: string[] = [];

  await withMockedFetch(async request => {
    const url = new URL(request.url);
    expect(await request.json()).toEqual({ model: 'raw-reranker', query: 'query', documents: ['one'], return_documents: false, truncation: true });
    calls.push(url.hostname);
    return url.hostname === 'rerank.example.com'
      ? jsonResponse({ model: 'raw-reranker', object: 'list', usage: { total_tokens: 7 }, results: [{ relevance_score: 0.8 }] })
      : second();
  }, async () => {
    const response = await requestAppWithWarmModels('/voyage/v1/rerank', {
      method: 'POST',
      headers: requestHeaders(apiKey.key),
      body: JSON.stringify({ model: 'public-reranker', query: 'query', documents: ['one'] }),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });
  await flushBackground();

  expect(calls).toEqual(['rerank.example.com', 'second.example.com']);
  const usage = await repo.usage.listAll();
  expect(usage).toHaveLength(status === 200 ? 2 : 1);
  expect(usage).toEqual(expect.arrayContaining([
    expect.objectContaining({ upstream: 'up_rerank', requests: 1, metrics: [{ metric: 'input_tokens', quantity: '7', unitPrice: '0.0000005' }] }),
  ]));
  expect(await repo.performance.listAll()).toEqual(expect.arrayContaining([
    expect.objectContaining({ upstream: 'up_rerank', operation: 'rerank', requests: 1, errorsNoOutput: 1 }),
    expect.objectContaining({ upstream: 'second', operation: 'rerank', requests: 1, errorsNoOutput: status === 200 ? 0 : 1 }),
  ]));
});

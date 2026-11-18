import { test } from 'vitest';

import type { Repo } from '../../../src/repo/types.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import type { ModelPricing, RerankTarget } from '@floway-dev/protocols/common';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const saveRerankUpstream = async (
  repo: Repo,
  target: RerankTarget,
  pricing?: ModelPricing,
): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_rerank',
    name: 'Rerank Provider',
    config: {
      baseUrl: 'https://rerank.example.com',
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

  await flushAsyncWork();
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

  await flushAsyncWork();
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
      assertEquals((await response.json()).error.message, 'Model public-reranker does not support this rerank request: return_embeddings=true requires a Jina target.');
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

  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, [{ metric: 'input_tokens', quantity: '7', unitPrice: null }]);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});

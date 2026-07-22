import { test } from 'vitest';

import type { Repo } from '../../repo/types.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestApp, setupAppTest } from '../../test-helpers.ts';
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
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_rerank',
    name: 'Rerank Provider',
    config: {
      baseUrl: 'https://rerank.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-rerank',
      endpoints: {},
      modelsFetch: { enabled: false },
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
      const response = await requestApp('/v1/rerank', {
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

test('/v2/rerank accepts null Cohere meta and records request-only usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'cohere-v2' });

  await withMockedFetch(
    () => jsonResponse({ id: 'request-no-usage', results: [], meta: null }),
    async () => {
      const response = await requestApp('/v2/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'public-reranker', query: 'query', documents: ['one'] }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { id: 'request-no-usage', results: [], meta: null });
    },
  );

  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, []);
});

test('/v2/rerank preserves same-protocol successes with malformed usage as request-only', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'cohere-v2' });

  await withMockedFetch(
    () => jsonResponse({ id: 'request-bad-usage', results: [], meta: { tokens: 3 } }),
    async () => {
      const response = await requestApp('/v2/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'public-reranker', query: 'query', documents: ['one'] }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { id: 'request-bad-usage', results: [], meta: { tokens: 3 } });
    },
  );

  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, []);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 0);
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
      const response = await requestApp('/jina/v1/rerank', {
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

test('/jina/v1/rerank accepts a same-dialect success without usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'jina-v1' });
  const upstreamResponse = {
    model: 'raw-reranker',
    object: 'list',
    results: [{ index: 0, relevance_score: 0.8 }],
  };

  await withMockedFetch(
    () => jsonResponse(upstreamResponse),
    async () => {
      const response = await requestApp('/jina/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'public-reranker', query: 'query', documents: ['one'] }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), upstreamResponse);
    },
  );

  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, []);
});

test('/jina/v1/rerank sends image inputs to DashScope native and accepts cross-protocol success without usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'dashscope-native' });
  const query = { image: 'https://example.com/query.png' };
  const document = { image: 'https://example.com/document.png' };
  let upstreamBody: unknown;

  await withMockedFetch(
    async request => {
      upstreamBody = await request.json();
      return jsonResponse({
        request_id: 'request-image',
        output: { results: [{ index: 0, relevance_score: 0.9, document }] },
      });
    },
    async () => {
      const response = await requestApp('/jina/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'public-reranker', query, documents: [document] }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        model: 'public-reranker',
        object: 'list',
        results: [{ index: 0, relevance_score: 0.9, document }],
      });
    },
  );

  assertEquals(upstreamBody, {
    model: 'raw-reranker',
    input: { query, documents: [document] },
    parameters: { return_documents: true },
  });
  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, []);
});

test('/voyage/v1/rerank translates a DashScope native response', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'dashscope-native' });

  let upstreamBody: unknown;
  await withMockedFetch(
    async request => {
      upstreamBody = await request.json();
      assertEquals(new URL(request.url).pathname, '/api/v1/services/rerank/text-rerank/text-rerank');
      return jsonResponse({
        request_id: 'request-1',
        output: { results: [{ index: 1, relevance_score: 0.75, document: { text: 'two' } }] },
        usage: { total_tokens: 16 },
      });
    },
    async () => {
      const response = await requestApp('/voyage/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-reranker',
          query: 'query',
          documents: ['one', 'two'],
          top_k: 1,
          return_documents: true,
        }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        object: 'list',
        model: 'public-reranker',
        usage: { total_tokens: 16 },
        data: [{ index: 1, relevance_score: 0.75, document: 'two' }],
      });
    },
  );
  assertEquals(upstreamBody, {
    model: 'raw-reranker',
    input: { query: 'query', documents: ['one', 'two'] },
    parameters: { top_n: 1, return_documents: true },
  });
});

test('/v2/rerank rejects Cohere v1-only fields before dispatch', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'cohere-v2' });

  let fetchCalls = 0;
  await withMockedFetch(
    () => {
      fetchCalls++;
      return jsonResponse({ results: [] });
    },
    async () => {
      const response = await requestApp('/v2/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-reranker',
          query: 'query',
          documents: ['one'],
          return_documents: true,
        }),
      });
      assertEquals(response.status, 400);
      assertEquals((await response.json()).error.message, 'cohere-v2 does not support return_documents');
    },
  );
  assertEquals(fetchCalls, 0);
});

test('upstream rerank errors are forwarded and still record a request-only usage row', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'cohere-v1' });

  await withMockedFetch(
    () => new Response(JSON.stringify({ message: 'rate limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '7', 'x-request-id': 'request-error' },
    }),
    async () => {
      const response = await requestApp('/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'public-reranker', query: 'query', documents: ['one'] }),
      });
      assertEquals(response.status, 429);
      assertEquals(response.headers.get('retry-after'), '7');
      assertEquals(await response.json(), { message: 'rate limited' });
    },
  );

  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, []);
});

test('a concrete token metric remains unpriced when only rerank searches have a rate', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(
    repo,
    { protocol: 'jina-v1' },
    { entries: [{ rates: { rerank_searches: '0.002' } }] },
  );

  await withMockedFetch(
    () => jsonResponse({
      model: 'raw-reranker',
      object: 'list',
      usage: { total_tokens: 9 },
      results: [{ index: 0, relevance_score: 0.8 }],
    }),
    async () => {
      const response = await requestApp('/jina/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'public-reranker', query: 'query', documents: ['one'] }),
      });
      assertEquals(response.status, 200);
      await response.json();
    },
  );

  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, [{ metric: 'input_tokens', quantity: '9', unitPrice: null }]);
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
      const response = await requestApp('/jina/v1/rerank', {
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

test('Jina image inputs reject pure-text targets before dispatch', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'cohere-v2' });
  let fetchCalls = 0;

  await withMockedFetch(
    () => {
      fetchCalls++;
      return jsonResponse({ results: [] });
    },
    async () => {
      const response = await requestApp('/jina/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-reranker',
          query: { image: 'https://example.com/query.png' },
          documents: [{ image: 'https://example.com/document.png' }],
        }),
      });
      assertEquals(response.status, 400);
      assertEquals((await response.json()).error.message, 'Model public-reranker does not support this rerank request: image query/documents require a Jina or DashScope native target.');
    },
  );
  assertEquals(fetchCalls, 0);
});

test('same-protocol success forwards opaque result items while still recording usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'jina-v1' });

  const upstreamBody = {
    model: 'raw-reranker',
    object: 'list',
    usage: { total_tokens: 7 },
    results: [{ relevance_score: 0.8 }],
  };
  await withMockedFetch(
    () => jsonResponse(upstreamBody),
    async () => {
      const response = await requestApp('/jina/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'public-reranker', query: 'query', documents: ['one'] }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), upstreamBody);
    },
  );

  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, [{ metric: 'input_tokens', quantity: '7', unitPrice: null }]);
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
      const response = await requestApp('/voyage/v1/rerank', {
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

test('same-protocol malformed JSON is forwarded as request-only usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'jina-v1' });

  await withMockedFetch(
    () => new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    async () => {
      const response = await requestApp('/jina/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'public-reranker', query: 'query', documents: ['one'] }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.text(), '{not-json');
    },
  );

  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  assertEquals(usage.metrics, []);
});

test('usage parsed before a cross-protocol render failure is still recorded', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveRerankUpstream(repo, { protocol: 'cohere-v2' });

  await withMockedFetch(
    () => jsonResponse({
      results: [{ index: 4, relevance_score: 0.8 }],
      meta: { billed_units: { search_units: 2 } },
    }),
    async () => {
      const response = await requestApp('/v1/rerank', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-reranker',
          query: 'query',
          documents: ['one'],
          return_documents: true,
        }),
      });
      assertEquals(response.status, 502);
      await response.json();
    },
  );

  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, [{ metric: 'rerank_searches', quantity: '2', unitPrice: null }]);
});

test('there is no unversioned /rerank route', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/rerank', {
    method: 'POST',
    headers: requestHeaders(apiKey.key),
    body: JSON.stringify({ model: 'public-reranker', query: 'query', documents: ['one'] }),
  });
  assertEquals(response.status, 404);
});

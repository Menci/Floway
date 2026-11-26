import { expect, test } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const setupCountTokens = async (target: 'anthropicMessages' | 'geminiGenerateContent') => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_count_tokens',
    name: 'Token counter',
    config: {
      baseUrl: 'https://tokens.example.com',
      apiKey: 'tokens-key',
      ingressHeadersRules: [],
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: 'native-count', publicModelId: 'count', endpoints: { [target]: {} } }],
    },
  }));
  return {
    repo,
    post: async (path: string, body: unknown) => await requestAppWithWarmModels(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
    }),
  };
};

test('Anthropic Messages count_tokens counts one upstream call and zero billable requests', async () => {
  const { repo, post } = await setupCountTokens('anthropicMessages');
  await withMockedFetch(async request => {
    expect(new URL(request.url).pathname).toBe('/v1/messages/count_tokens');
    expect(await request.json()).toMatchObject({
      model: 'native-count',
      messages: [{ role: 'user', content: 'hello' }],
    });
    return jsonResponse({ input_tokens: 7 });
  }, async () => {
    const response = await post('/v1/messages/count_tokens', { model: 'count', messages: [{ role: 'user', content: 'hello' }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 7 });
  });
  await flushAsyncWork();
  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toMatchObject([{ operation: 'count_tokens', requests: 1 }]);
});

test.each(['contents', 'generateContentRequest'] as const)('Gemini countTokens translates %s to the selected Anthropic Messages candidate', async input => {
  const { repo, post } = await setupCountTokens('anthropicMessages');
  const contents = [{ role: 'user', parts: [{ text: 'hello' }] }];
  await withMockedFetch(async request => {
    expect(new URL(request.url).pathname).toBe('/v1/messages/count_tokens');
    expect(await request.json()).toMatchObject({ model: 'native-count' });
    return jsonResponse({ input_tokens: 17 });
  }, async () => {
    const body = input === 'contents' ? { contents } : { generateContentRequest: { contents } };
    const response = await post('/v1beta/models/count:countTokens', body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ totalTokens: 17 });
  });
  await flushAsyncWork();
  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toMatchObject([{ operation: 'count_tokens', requests: 1 }]);
});

test('Gemini countTokens preserves an upstream JSON error and excludes it from billing', async () => {
  const { repo, post } = await setupCountTokens('geminiGenerateContent');
  const body = { error: { code: 429, message: 'model quota', status: 'RESOURCE_EXHAUSTED' } };
  await withMockedFetch(async request => {
    expect(new URL(request.url).pathname).toBe('/v1beta/models/native-count:countTokens');
    return new Response(JSON.stringify(body), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5' } });
  }, async () => {
    const response = await post('/v1beta/models/count:countTokens', { contents: [{ parts: [{ text: 'hello' }] }] });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toEqual(body);
  });
  await flushAsyncWork();
  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toMatchObject([{ operation: 'count_tokens', requests: 1, errorsNoOutput: 1 }]);
});

test.each([
  {
    target: 'anthropicMessages',
    path: '/v1/messages/count_tokens',
    upstreamPath: '/v1/messages/count_tokens',
    body: { model: 'count', messages: [{ role: 'user', content: 'hello' }] },
    status: 204,
  },
  {
    target: 'anthropicMessages',
    path: '/v1beta/models/count:countTokens',
    upstreamPath: '/v1/messages/count_tokens',
    body: { contents: [{ parts: [{ text: 'hello' }], role: 'user' }] },
    status: 204,
  },
  {
    target: 'geminiGenerateContent',
    path: '/v1beta/models/count:countTokens',
    upstreamPath: '/v1beta/models/native-count:countTokens',
    body: { contents: [{ parts: [{ text: 'hello' }] }] },
    status: 205,
  },
] as const)('countTokens preserves bodyless HTTP $status from $target at $path', async ({ target, path, upstreamPath, body, status }) => {
  const { repo, post } = await setupCountTokens(target);
  await withMockedFetch(request => {
    expect(new URL(request.url).pathname).toBe(upstreamPath);
    return new Response(null, { status, headers: { 'x-upstream-trace': 'empty-count' } });
  }, async () => {
    const response = await post(path, body);
    expect(response.status).toBe(status);
    expect(response.headers.get('x-upstream-trace')).toBe('empty-count');
    expect(response.body).toBeNull();
  });
  await flushAsyncWork();
  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toMatchObject([{ operation: 'count_tokens', requests: 1, errorsNoOutput: 0 }]);
});

test.each([
  { label: 'an empty body', body: null },
  { label: 'JSON null', body: 'null' },
])('countTokens rejects a 200 response carrying $label', async ({ body }) => {
  const { repo, post } = await setupCountTokens('anthropicMessages');
  await withMockedFetch(
    () => new Response(body, { headers: { 'content-type': 'application/json', 'x-upstream-trace': 'malformed-count' } }),
    async () => {
      const response = await post('/v1/messages/count_tokens', { model: 'count', messages: [{ role: 'user', content: 'hello' }] });
      expect(response.status).toBe(502);
      expect(response.headers.get('x-upstream-trace')).toBe('malformed-count');
      expect(await response.json()).toMatchObject({ error: { message: expect.any(String) } });
    },
  );
  await flushAsyncWork();
  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toMatchObject([{ operation: 'count_tokens', requests: 1, errorsNoOutput: 1 }]);
});

test('Gemini countTokens translates damaged Anthropic results to a consistent 502 envelope', async () => {
  const { repo, post } = await setupCountTokens('anthropicMessages');
  await withMockedFetch(
    request => {
      expect(new URL(request.url).pathname).toBe('/v1/messages/count_tokens');
      return new Response('{"input_tokens":"invalid"}', { headers: { 'content-type': 'application/json', 'x-upstream-trace': 'malformed-count' } });
    },
    async () => {
      const response = await post('/v1beta/models/count:countTokens', { contents: [{ parts: [{ text: 'hello' }] }] });
      expect(response.status).toBe(502);
      expect(response.headers.get('x-upstream-trace')).toBe('malformed-count');
      expect(await response.json()).toMatchObject({ error: { code: 502, message: expect.stringContaining('input_tokens'), status: expect.any(String) } });
    },
  );
  await flushAsyncWork();
  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toMatchObject([{ operation: 'count_tokens', requests: 1, errorsNoOutput: 1 }]);
});

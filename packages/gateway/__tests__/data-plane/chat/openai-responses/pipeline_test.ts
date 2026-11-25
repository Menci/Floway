import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { openaiResponsesHttp } from '../../../../src/data-plane/chat/openai-responses/http.ts';
import { DEFAULT_WEB_SEARCH_CONFIG } from '../../../../src/data-plane/tools/web-search/config.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import type { UsageRecord, WebSearchUsageRecord } from '../../../../src/repo/types.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest, sseResponse, testAdminUser, warmModelsForTest } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import { withMockedFetch } from '@floway-dev/test-utils';

const model = 'responses-model';
const imageModel = 'image-model';
const usage = { input_tokens: 4, output_tokens: 1, total_tokens: 5 };
const setup = async (simulateCompaction = false) => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    flagOverrides: {
      'openai-responses-compact-shim': simulateCompaction,
      'openai-responses-web-search-shim': true,
      'openai-responses-image-generation-shim': true,
    },
    config: {
      baseUrl: 'https://responses.example.com',
      apiKey: 'responses-upstream-key',
      ingressHeadersRules: [],
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [
        { upstreamModelId: model, kind: 'chat', endpoints: { openaiResponses: {} } },
        { upstreamModelId: imageModel, kind: 'image', endpoints: { openaiImagesGenerations: {} } },
      ],
    },
  }));
  const app = new Hono<{ Variables: AuthVars }>();
  const mount = (path: string, handler: typeof openaiResponsesHttp.generate): void => {
    app.post(path, c => {
      c.set('apiKey', apiKey);
      c.set('user', testAdminUser);
      return handler(c);
    });
  };
  mount('/v1/responses', openaiResponsesHttp.generate);
  mount('/v1/responses/compact', openaiResponsesHttp.compact);
  await warmModelsForTest();
  return {
    repo,
    request: (path: string, payload: object) => app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: 'hello', ...payload }),
    }),
  };
};

const generated = {
  id: 'resp_upstream',
  object: 'response',
  model,
  status: 'completed',
  output: [],
  usage,
  error: null,
  incomplete_details: null,
} satisfies OpenAIResponsesResultEx;

const generatedResponse = () => sseResponse([
  { data: { type: 'response.created', sequence_number: 0, response: { ...generated, status: 'in_progress' } } },
  { data: { type: 'response.completed', sequence_number: 1, response: generated } },
  { data: '[DONE]' },
]);

test('OpenAI Responses generation streams upstream and persists the requested continuation', async () => {
  const { request } = await setup();
  const wire: unknown[] = [];
  await withMockedFetch(async upstream => {
    expect(new URL(upstream.url).pathname).toBe('/v1/responses');
    expect(upstream.headers.get('authorization')).toBe('Bearer responses-upstream-key');
    wire.push(await upstream.json());
    return generatedResponse();
  }, async () => {
    const response = await request('/v1/responses', { stream: false });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-reasoning-included')).toBe('true');
    const first = await response.json() as { id: string; created_at: number };
    expect(first.id).toMatch(/^resp_/);
    expect(first.id).not.toBe(generated.id);
    expect(first.created_at).toBeGreaterThan(0);
    const streamed = await request('/v1/responses', { stream: true, input: 'continue', previous_response_id: first.id });
    expect(streamed.status).toBe(200);
    const body = await streamed.text();
    expect(body).toContain('response.completed');
    expect(body).toContain(first.id);
    expect(body).toContain('data: [DONE]');
    expect(wire).toMatchObject([
      { stream: true, input: [{ type: 'message', role: 'user', content: 'hello' }] },
      { stream: true, input: [{ type: 'message', role: 'user', content: 'hello' }, { type: 'message', role: 'user', content: 'continue' }] },
    ]);
    expect(wire[1]).not.toHaveProperty('previous_response_id');
    await flushBackground();
  });
});

test('OpenAI Responses compact enters the scalar provider operation and completes the resource', async () => {
  const { request } = await setup();
  let upstreamCalls = 0;
  await withMockedFetch(async upstream => {
    upstreamCalls++;
    expect(new URL(upstream.url).pathname).toBe('/v1/responses/compact');
    const payload: unknown = await upstream.json();
    expect(payload).toEqual({ model, input: [{ type: 'message', role: 'user', content: 'hello' }] });
    return Response.json({ id: 'resp_compaction', object: 'response.compaction', output: [], usage }, {
      headers: { 'x-request-id': 'compaction-id' },
    });
  }, async () => {
    const response = await request('/v1/responses/compact', { store: false, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('compaction-id');
    expect(await response.json()).toMatchObject({
      object: 'response.compaction',
      output: [{ type: 'reasoning', encrypted_content: expect.any(String) }],
      usage,
      created_at: expect.any(Number),
    });
    expect(upstreamCalls).toBe(1);
    await flushBackground();
  });
});

test('OpenAI Responses hosted search settles its own request and meters both model turns', async () => {
  const { repo, request } = await setup();
  await repo.webSearchConfig.save({ ...DEFAULT_WEB_SEARCH_CONFIG, provider: 'tavily', tavily: { apiKey: 'search-key' } });
  const usageRows: UsageRecord[] = [];
  const storedUsage = repo.usage.record.bind(repo.usage);
  repo.usage.record = async row => {
    usageRows.push(row);
    await storedUsage(row);
  };
  const searchRows: WebSearchUsageRecord[] = [];
  const storedSearchUsage = repo.webSearchUsage.record.bind(repo.webSearchUsage);
  repo.webSearchUsage.record = async row => {
    searchRows.push(row);
    await storedSearchUsage(row);
  };
  const call = {
    type: 'function_call',
    id: 'fc_search',
    call_id: 'call_search',
    name: 'web_search',
    arguments: '{"search_query":[{"q":"Floway docs"}]}',
  };
  let modelCalls = 0;
  let searchCalls = 0;
  await withMockedFetch(async upstream => {
    if (new URL(upstream.url).hostname === 'api.tavily.com') {
      searchCalls++;
      expect(await upstream.json()).toMatchObject({ query: 'Floway docs' });
      return Response.json({ results: [{ url: 'https://docs.example.com/floway', title: 'Floway docs', content: 'Provider documentation result' }] });
    }

    expect(new URL(upstream.url).pathname).toBe('/v1/responses');
    const body: unknown = await upstream.json();
    if (++modelCalls === 1) {
      expect(body).toMatchObject({ tools: [{ type: 'function', name: 'web_search' }] });
      return sseResponse([
        { data: { type: 'response.created', sequence_number: 0, response: { ...generated, status: 'in_progress' } } },
        { data: { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...call, arguments: '' } } },
        { data: { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: call } },
        { data: { type: 'response.completed', sequence_number: 3, response: { ...generated, output: [call] } } },
      ]);
    }
    expect(body).toMatchObject({
      input: expect.arrayContaining([expect.objectContaining({
        type: 'function_call_output', call_id: 'call_search', output: expect.stringContaining('Provider documentation result'),
      })]),
    });
    return generatedResponse();
  }, async () => {
    const response = await request('/v1/responses', { stream: false, tools: [{ type: 'web_search' }], include: ['web_search_call.results'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'completed',
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
      output: expect.arrayContaining([expect.objectContaining({
        type: 'web_search_call', status: 'completed', results: [expect.objectContaining({ url: 'https://docs.example.com/floway' })],
      })]),
    });
    await flushBackground();
  });
  expect(modelCalls).toBe(2);
  expect(searchCalls).toBe(1);
  expect(usageRows).toMatchObject([{ model, requests: 1 }, { model, requests: 1 }]);
  expect(searchRows).toMatchObject([{ provider: 'tavily', action: 'search', requests: 1 }]);
});

test('OpenAI Responses relays hosted partial images from the separate image operation', async () => {
  const { repo, request } = await setup();
  const usageRows: UsageRecord[] = [];
  const storeUsage = repo.usage.record.bind(repo.usage);
  repo.usage.record = async row => {
    usageRows.push(row);
    await storeUsage(row);
  };
  const call = {
    type: 'function_call',
    id: 'fc_image',
    call_id: 'call_image',
    name: 'image_generation',
    arguments: '{"prompt":"A circle"}',
  };
  const partial = { type: 'image_generation.partial_image', partial_image_index: 0, b64_json: 'cHJldmlldw==' };
  const complete = { type: 'image_generation.completed', b64_json: 'ZmluYWw=', usage };
  let rounds = 0;
  let imageCalls = 0;
  await withMockedFetch(async upstream => {
    const body: unknown = await upstream.json();
    if (new URL(upstream.url).pathname === '/v1/images/generations') {
      imageCalls++;
      expect(body).toMatchObject({ model: imageModel, prompt: 'A circle', stream: true, partial_images: 1 });
      return sseResponse([{ data: partial }, { data: complete }]);
    }

    expect(new URL(upstream.url).pathname).toBe('/v1/responses');
    if (++rounds === 1) {
      expect(body).toMatchObject({ tools: [{ type: 'function', name: 'image_generation' }] });
      return sseResponse([
        { data: { type: 'response.created', sequence_number: 0, response: { ...generated, status: 'in_progress' } } },
        { data: { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...call, arguments: '' } } },
        { data: { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: call } },
        { data: { type: 'response.completed', sequence_number: 3, response: { ...generated, output: [call] } } },
      ]);
    }
    return generatedResponse();
  }, async () => {
    const response = await request('/v1/responses', { stream: true, tools: [{ type: 'image_generation', model: imageModel, partial_images: 1 }] });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('"type":"response.image_generation_call.partial_image"');
    expect(stream).toContain(partial.b64_json);
    expect(stream).toContain(complete.b64_json);
    expect(stream).toContain('response.completed');
    await flushBackground();
  });
  expect(imageCalls).toBe(1);
  expect(rounds).toBe(2);
  expect(usageRows.map(row => row.model).sort()).toEqual([imageModel, model, model]);
});

test('OpenAI Responses tries the next candidate after a non-streaming upstream error', async () => {
  const { repo, request } = await setup();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_first',
    sortOrder: 0,
    config: {
      baseUrl: 'https://first.example.com',
      apiKey: '',
      ingressHeadersRules: [],
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: model, kind: 'chat', endpoints: { openaiResponses: {} } }],
    },
  }));
  await warmModelsForTest();
  const visited: string[] = [];
  await withMockedFetch(upstream => {
    const { hostname } = new URL(upstream.url);
    visited.push(hostname);
    return hostname === 'first.example.com'
      ? Response.json({ error: { message: 'overloaded' } }, { status: 429, headers: { 'retry-after': '5' } })
      : generatedResponse();
  }, async () => {
    const response = await request('/v1/responses', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'completed' });
    await flushBackground();
  });
  expect(visited).toEqual(['first.example.com', 'responses.example.com']);
  const performance = await repo.performance.listAll();
  expect(performance).toContainEqual(expect.objectContaining({ upstream: 'up_first', errorsNoOutput: 1 }));
});

test('OpenAI Responses compaction retries with the system prompt and meters both generation calls', async () => {
  const { repo, request } = await setup(true);
  const sent: { input: { role?: string; content?: unknown }[]; store?: boolean; stream?: boolean }[] = [];
  await withMockedFetch(async upstream => {
    expect(new URL(upstream.url).pathname).toBe('/v1/responses');
    sent.push(await upstream.json() as typeof sent[number]);
    if (sent.length === 1) return generatedResponse();
    const output = [{
      type: 'message', id: 'msg_summary', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Preserve the working context.', annotations: [] }],
    }];
    return sseResponse([
      { data: { type: 'response.completed', sequence_number: 0, response: { ...generated, output } } },
    ]);
  }, async () => {
    const response = await request('/v1/responses/compact', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: 'response.compaction',
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
      output: expect.arrayContaining([expect.objectContaining({ type: 'compaction', encrypted_content: expect.any(String) })]),
    });
    await flushBackground();
  });
  expect(sent).toHaveLength(2);
  expect(sent[0]).toMatchObject({
    store: false, stream: true, input: [
      { role: 'user', content: 'hello' },
      { role: 'user', content: [{ type: 'input_text', text: expect.stringContaining('respond with text only') }] },
    ],
  });
  expect(sent[1]?.input[0]).toMatchObject({ role: 'system', content: [{ text: expect.stringContaining('CONTEXT CHECKPOINT') }] });
  expect(await repo.usage.listAll()).toMatchObject([{ model, requests: 2 }]);
});

test('OpenAI Responses preserves status and retry headers while wrapping upstream text as JSON', async () => {
  const { request } = await setup();
  await withMockedFetch(() => new Response('Capacity unavailable', {
    status: 429,
    headers: { 'content-type': 'text/plain', 'retry-after': '5', 'x-request-id': 'rate-limited-request' },
  }), async () => {
    const response = await request('/v1/responses', {});
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('x-request-id')).toBe('rate-limited-request');
    expect(await response.json()).toEqual({ error: { type: 'invalid_request_error', message: 'Capacity unavailable' } });
    await flushBackground();
  });
});

import { expect, test } from 'vitest';

import { tokenCountsFromUsage } from '../../../../src/repo/usage-metrics.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, parseSSEText, requestAppWithWarmModels, setupAppTest, sseAnthropicMessagesResponse, sseOpenAIResponsesResponse, sseResponse } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import { withMockedFetch } from '@floway-dev/test-utils';

const model = 'chat-model';
const messages = [{ role: 'user', content: 'hello' }];
type Repo = Awaited<ReturnType<typeof setupAppTest>>['repo'];

const saveUpstream = (
  repo: Repo, id: string, endpoints: ModelEndpoints, sortOrder = 100, flagOverrides = {},
) => saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
  id,
  sortOrder,
  flagOverrides,
  config: {
    baseUrl: `https://${id}.example.com`,
    ingressHeadersRules: [],
    apiKey: 'chat-upstream-key',
    endpoints: {},
    modelsFetch: { enabled: false, authStyle: 'bearer' },
    models: [{ upstreamModelId: model, endpoints }],
  },
}));

const request = (key: string, payload: Record<string, unknown> = {}) => requestAppWithWarmModels('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: JSON.stringify({ model, messages, ...payload }),
});

const nativeStream = () => sseResponse([{
  data: {
    id: 'chatcmpl_http',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 6 } },
    extension: { mode: 'verbatim' },
  },
}]);

test.each(['prompt_cache_options', 'user'] as const)('Chat Completions rejects a null %s before routing', async field => {
  const { apiKey } = await setupAppTest();
  const response = await request(apiKey.key, { [field]: null });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      message: `Invalid '${field}': expected ${field === 'user' ? 'a string' : 'an object'} when present.`,
      type: 'invalid_request_error',
      param: field,
      code: null,
    },
  });
});

test('Chat Completions preserves native extensions, normalizes usage before metering and completes at native EOF', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstream(repo, 'native-chat', { openaiChatCompletions: {} });

  const calls: unknown[] = [];
  await withMockedFetch(async upstream => {
    expect(upstream.url).toBe('https://native-chat.example.com/v1/chat/completions');
    expect(upstream.headers.get('authorization')).toBe('Bearer chat-upstream-key');
    calls.push(await upstream.json());
    return nativeStream();
  }, async () => {
    const streamed = await request(apiKey.key, { stream: true, extension: { request: 'verbatim' } });
    expect(streamed.status).toBe(200);
    const frames = parseSSEText(await streamed.text());
    expect(frames.at(-1)?.data).toBe('[DONE]');
    expect(frames.some(frame => frame.data.includes('"extension":{"mode":"verbatim"}'))).toBe(true);
    expect(frames.some(frame => frame.data.includes('"usage"'))).toBe(false);

    const withUsage = await request(apiKey.key, { stream: true, stream_options: { include_usage: true } });
    const usageFrame = parseSSEText(await withUsage.text()).find(frame => frame.data.includes('"usage"'));
    expect(JSON.parse(usageFrame!.data)).toMatchObject({ choices: [], usage: { prompt_tokens: 10 } });

    const collected = await request(apiKey.key);
    expect(collected.status).toBe(200);
    expect(await collected.json()).toMatchObject({
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  });
  await flushBackground();
  expect(calls).toMatchObject([
    { stream: true, stream_options: { include_usage: true }, extension: { request: 'verbatim' } },
    { stream: true, stream_options: { include_usage: true } },
    { stream: true, stream_options: { include_usage: true } },
  ]);
  const [usage] = await repo.usage.listAll();
  expect(usage).toMatchObject({ model, upstream: 'native-chat', requests: 3 });
  expect(tokenCountsFromUsage(usage)).toEqual({ input: 12, input_cache_read: 18, output: 6 });
  expect(await repo.performance.listAll()).toMatchObject([{ operation: 'chat', requests: 3, errorsNoOutput: 0 }]);
});

test('Chat Completions translates into the Anthropic Messages body and collects source protocol output', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstream(repo, 'anthropic-chat', { anthropicMessages: {} });

  await withMockedFetch(async upstream => {
    expect(upstream.url).toBe('https://anthropic-chat.example.com/v1/messages');
    expect(await upstream.json()).toMatchObject({ model, stream: true, messages: [{ role: 'user' }] });
    return sseAnthropicMessagesResponse({
      type: 'message', id: 'msg_1', model, role: 'assistant',
      content: [{ type: 'text', text: 'anthropic answer' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 },
    });
  }, async () => {
    const response = await request(apiKey.key);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: 'chat.completion', choices: [{ message: { content: 'anthropic answer' } }] });
  });
  await flushBackground();
  expect(await repo.usage.listAll()).toMatchObject([{ model, upstream: 'anthropic-chat', requests: 1 }]);
});

test('Chat Completions translates into the Responses body and keeps client stream delivery', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstream(repo, 'responses-chat', { openaiResponses: {} });

  await withMockedFetch(async upstream => {
    expect(upstream.url).toBe('https://responses-chat.example.com/v1/responses');
    expect(await upstream.json()).toMatchObject({ model, stream: true, input: [{ role: 'user' }] });
    return sseOpenAIResponsesResponse({
      id: 'resp_chat', model, object: 'response', status: 'completed', created_at: 1,
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'responses answer', annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      error: null,
      incomplete_details: null,
    });
  }, async () => {
    const response = await request(apiKey.key, { stream: true });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('responses answer');
    expect(body).toContain('data: [DONE]');
  });
  await flushBackground();
  expect(await repo.usage.listAll()).toMatchObject([{ model, upstream: 'responses-chat', requests: 1 }]);
});

test('Chat Completions sends an alias reasoning choice through DeepSeek request normalization', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstream(repo, 'deepseek-chat', { openaiChatCompletions: {} }, 100, { 'vendor-deepseek': true });
  await repo.modelAliases.insert({
    id: 'alias_no_reasoning',
    name: 'no-reasoning',
    kind: 'chat',
    selection: 'first-available',
    displayName: null,
    visibleInModelsList: true,
    targets: [{ target_model_id: model, rules: { reasoning: { effort: 'none' } } }],
    announcedMetadata: null,
    sortOrder: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  await withMockedFetch(async upstream => {
    const wire = await upstream.json();
    expect(wire).toMatchObject({ model, thinking: { type: 'disabled' } });
    expect(wire).not.toHaveProperty('reasoning_effort');
    return nativeStream();
  }, async () => {
    const response = await request(apiKey.key, { model: 'no-reasoning' });
    expect(response.status).toBe(200);
    await response.json();
  });
  await flushBackground();
});

test.each([
  { status: 400, upstream: () => Response.json({ error: { code: 'vendor_failure', detail: 'keep' } }, { status: 400, headers: { 'retry-after': '5' } }), body: { error: { code: 'vendor_failure', detail: 'keep' } } },
  { status: 503, upstream: () => new Response('upstream unavailable', { status: 503, headers: { 'retry-after': '5' } }), body: { error: { message: 'upstream unavailable', type: 'api_error' } } },
])('Chat Completions retries a candidate 400 and preserves the selected $status error and retry hint', async ({ status, upstream, body }) => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstream(repo, 'first-chat', { openaiChatCompletions: {} });
  await saveUpstream(repo, 'second-chat', { openaiChatCompletions: {} }, 200);
  const calls: string[] = [];
  await withMockedFetch(fetch => {
    const { hostname } = new URL(fetch.url);
    calls.push(hostname);
    return hostname === 'first-chat.example.com' ? new Response('first candidate rejects input', { status: 400 }) : upstream();
  }, async () => {
    const response = await request(apiKey.key, { stream: true });
    expect(response.status).toBe(status);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toEqual(body);
  });
  await flushBackground();
  expect(calls).toEqual(['first-chat.example.com', 'second-chat.example.com']);
  expect(await repo.usage.listAll()).toEqual([]);
});

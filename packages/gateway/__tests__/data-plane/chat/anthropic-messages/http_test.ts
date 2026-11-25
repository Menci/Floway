import { expect, test } from 'vitest';

import { tokenCountsFromUsage } from '../../../../src/repo/usage-metrics.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, parseSSEText, requestAppWithWarmModels, setupAppTest, sseAnthropicMessagesResponse, sseOpenAIChatCompletionsResponse, sseOpenAIResponsesResponse, sseResponse } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import { withMockedFetch } from '@floway-dev/test-utils';

const model = 'messages-model';
const messages = [{ role: 'user', content: 'hello' }];

const setup = async (endpoints: ModelEndpoints = { anthropicMessages: {} }) => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'messages-upstream',
    flagOverrides: { 'strip-billing-attribution': true, 'empty-tools-tool-choice-none': true },
    config: {
      baseUrl: 'https://messages.example.com',
      ingressHeadersRules: [],
      apiKey: 'messages-upstream-key',
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: model, endpoints }],
    },
  }));
  return {
    repo,
    request: (path: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
      requestAppWithWarmModels(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key, ...headers },
        body: JSON.stringify({ model, messages, ...(path.includes('count_tokens') ? {} : { max_tokens: 32 }), ...payload }),
      }),
  };
};

const generated = {
  id: 'msg_1', type: 'message', model, role: 'assistant',
  content: [{ type: 'text', text: 'anthropic answer' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 },
};

test('Anthropic Messages streams or collects the native answer while filtering Claude Code billing attribution', async () => {
  const { request, repo } = await setup();
  const payload = {
    system: 'x-anthropic-billing-header: x-tool=claude-code; cch=012abc;\nkeep this instruction',
    tools: [],
    tool_choice: { type: 'any' },
    extension: { mode: 'verbatim' },
  };
  const headers = { 'anthropic-beta': 'claude-code-20250219,retained-beta' };

  await withMockedFetch(async upstream => {
    expect(upstream.url).toBe('https://messages.example.com/v1/messages');
    expect(upstream.headers.get('x-api-key')).toBe('messages-upstream-key');
    expect(upstream.headers.get('anthropic-beta')).toBe('retained-beta');
    expect(await upstream.json()).toMatchObject({
      model, stream: true, system: 'keep this instruction', tool_choice: { type: 'none' }, extension: { mode: 'verbatim' },
    });
    return sseAnthropicMessagesResponse(generated);
  }, async () => {
    const streamed = await request('/v1/messages', { ...payload, stream: true }, headers);
    expect(streamed.status).toBe(200);
    const frames = parseSSEText(await streamed.text());
    expect(frames[0]?.event).toBe('message_start');
    expect(frames.at(-1)?.event).toBe('message_stop');

    const collected = await request('/v1/messages', payload, headers);
    expect(collected.status).toBe(200);
    expect(await collected.json()).toMatchObject({
      ...generated,
      content: expect.arrayContaining(generated.content.map(block => expect.objectContaining(block))),
    });
  });
  await flushBackground();
  const [usage] = await repo.usage.listAll();
  expect(usage).toMatchObject({ model, requests: 2 });
  expect(tokenCountsFromUsage(usage)).toEqual({ input: 6, output: 4 });
});

test('Anthropic Messages rejects body beta fields before routing', async () => {
  const { request } = await setup();
  const response = await request('/v1/messages', { anthropic_beta: ['something'] });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      type: 'invalid_request_error',
      param: 'anthropic_beta',
      message: 'anthropic_beta in the Anthropic Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.',
    },
  });
});

test('Anthropic Messages answers the Claude Code model-validation probe with zero usage and no upstream performance', async () => {
  const { request, repo } = await setup();
  await withMockedFetch(upstream => {
    throw new Error(`The probe reached ${upstream.url}`);
  }, async () => {
    const response = await request('/v1/messages', {
      max_tokens: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }] }],
    }, { 'user-agent': 'claude-cli/2.1.226 (external, cli)' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      model,
      content: [{ type: 'redacted_thinking', data: expect.any(String) }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });
  await flushBackground();
  expect(await repo.usage.listAll()).toMatchObject([{ model, requests: 1, metrics: [] }]);
  expect(await repo.performance.listAll()).toEqual([]);
});

test('Anthropic Messages count_tokens sends the native scalar request and records unbillable chat performance', async () => {
  const { request, repo } = await setup();
  await withMockedFetch(async upstream => {
    expect(upstream.url).toBe('https://messages.example.com/v1/messages/count_tokens');
    expect(upstream.headers.get('anthropic-beta')).toBe('retained-beta');
    expect(await upstream.json()).toMatchObject({ model, messages, system: 'keep', tool_choice: { type: 'none' } });
    return Response.json({ input_tokens: 14, extension: true }, { headers: { 'x-request-id': 'count-id' } });
  }, async () => {
    const response = await request('/v1/messages/count_tokens', {
      system: 'x-anthropic-billing-header: cch=123456;\nkeep',
      tools: [],
      tool_choice: { type: 'any' },
    }, { 'anthropic-beta': 'claude-code-20250219,retained-beta' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('count-id');
    expect(await response.json()).toEqual({ input_tokens: 14, extension: true });
  });
  await flushBackground();
  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toMatchObject([{ model, operation: 'chat', requests: 1 }]);
});

test('Anthropic Messages count_tokens preserves upstream status, JSON and retry headers', async () => {
  const { request } = await setup();
  const body = { error: { type: 'rate_limit_error', message: 'wait' }, extension: true };
  await withMockedFetch(() => Response.json(body, { status: 429, headers: { 'retry-after': '5' } }), async () => {
    const response = await request('/v1/messages/count_tokens');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toEqual(body);
  });
  await flushBackground();
});

test('Anthropic Messages sends a named stream error without reopening candidate selection', async () => {
  const { request, repo } = await setup();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'alternate-messages-upstream',
    sortOrder: 200,
    config: {
      baseUrl: 'https://alternate-messages.example.com',
      apiKey: 'alternate-key',
      ingressHeadersRules: [],
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: model, endpoints: { anthropicMessages: {} } }],
    },
  }));
  const calls: string[] = [];
  await withMockedFetch(upstream => {
    calls.push(new URL(upstream.url).hostname);
    return sseResponse([
      { event: 'message_start', data: { type: 'message_start', message: { ...generated, content: [], stop_reason: null } } },
      { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'upstream stream failed' } } },
    ]);
  }, async () => {
    const response = await request('/v1/messages', { stream: true });
    expect(response.status).toBe(200);
    const frames = parseSSEText(await response.text());
    expect(frames[0]?.event).toBe('message_start');
    expect(frames.at(-1)).toMatchObject({ event: 'error', data: expect.stringContaining('upstream stream failed') });
  });
  await flushBackground();
  expect(calls).toEqual(['messages.example.com']);
});

test('Anthropic Messages translates into the Chat Completions body with native usage attribution', async () => {
  const { request, repo } = await setup({ openaiChatCompletions: {} });
  await withMockedFetch(async upstream => {
    expect(upstream.url).toBe('https://messages.example.com/v1/chat/completions');
    expect(upstream.headers.get('anthropic-beta')).toBeNull();
    expect(await upstream.json()).toMatchObject({ model, messages, stream: true, stream_options: { include_usage: true } });
    return sseOpenAIChatCompletionsResponse({
      id: 'chatcmpl_http', created: 1, model,
      choices: [{ message: { role: 'assistant', content: 'translated answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }, async () => {
    const response = await request('/v1/messages', {}, { 'anthropic-beta': 'retained-beta' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: 'message',
      content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'translated answer' })]),
    });
  });
  await flushBackground();
  expect(await repo.usage.listAll()).toMatchObject([{ model, requests: 1 }]);
});

test('Anthropic Messages prefers the Responses body to Chat Completions', async () => {
  const { request } = await setup({ openaiResponses: {}, openaiChatCompletions: {} });
  await withMockedFetch(async upstream => {
    expect(upstream.url).toBe('https://messages.example.com/v1/responses');
    expect(await upstream.json()).toMatchObject({ model, stream: true, input: [{ role: 'user' }] });
    return sseOpenAIResponsesResponse({
      id: 'resp_messages', model, object: 'response', status: 'completed', created_at: 1,
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'responses answer', annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      error: null,
      incomplete_details: null,
    });
  }, async () => {
    const response = await request('/v1/messages', { stream: true });
    expect(response.status).toBe(200);
    const frames = parseSSEText(await response.text());
    expect(frames.some(frame => frame.data.includes('responses answer'))).toBe(true);
    expect(frames.at(-1)?.event).toBe('message_stop');
  });
  await flushBackground();
});

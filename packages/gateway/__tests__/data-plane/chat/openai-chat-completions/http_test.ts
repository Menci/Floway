import { expect, test, vi } from 'vitest';

import { openaiChatCompletionsHttpEntry } from '../../../../src/data-plane/chat/openai-chat-completions/pipeline/ingress.ts';
import { servePipelineHttp } from '../../../../src/data-plane/shared/pipeline-http.ts';
import { DumpAccumulator } from '../../../../src/dump/accumulator.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import type { ApiKey } from '../../../../src/repo/types.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { customCandidate, operationHost, requestFor } from '../../non-chat/count-tokens/fixtures.ts';
import { mountedChatPanic } from '../pipeline/http-panic-fixtures.ts';
import { HttpTransportError, type Fetcher } from '@floway-dev/http';

const path = '/v1/chat/completions';
const candidate = (id = 'chat') => customCandidate(id, { openaiChatCompletions: {} });

test.each([false, true])('Chat Completions retains the nested transport diagnostic for stream=%s', async stream => {
  const cause = new TypeError('nested transport cause');
  const failure = new HttpTransportError(new Error('broken socket', { cause }));
  const head = sse(textChunk);
  const first = new Uint8Array(await head.arrayBuffer());
  let emitted = false;
  const host = operationHost([candidate()], async () => new Response(new ReadableStream<Uint8Array>({
    pull(reader) {
      if (emitted) reader.error(failure);
      else {
        emitted = true;
        reader.enqueue(first);
      }
    },
  }, { highWaterMark: 0 }), { headers: head.headers }));
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, { ...request, stream }), host.options);
  expect(response.status).toBe(stream ? 200 : 502);
  const body = await response.text();
  expect(body).toContain('"name":"TypeError"');
  expect(body).toContain('"message":"nested transport cause"');
  expect(body).toContain('provider_specific_fields');
  expect(body).not.toContain('event: error');
  expect(body).not.toContain('[DONE]');
  await host.settle();
});
const request = { model: 'public-model', messages: [{ role: 'user', content: 'hello' }] };

const sse = (...events: unknown[]) => new Response(events
  .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream' },
});

const chunk = (delta: object, finish_reason: 'stop' | null = null) => ({
  id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'wire-model',
  choices: [{ index: 0, delta, finish_reason }],
});
const textChunk = chunk({ role: 'assistant', content: 'hello' }, 'stop');
const usageChunk = { ...textChunk, choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };
const success = () => sse(textChunk, usageChunk);

test('renders a pre-head Chat Completions panic as the original 502 debug envelope', async () => {
  const { status, text, failure, cause } = await mountedChatPanic(path, { ...request, model: 'test-model' }, { openaiChatCompletions: {} });
  expect(status).toBe(502);
  expect(JSON.parse(text)).toMatchObject({
    error: { type: 'internal_error', message: failure.message, provider_specific_fields: { stack: failure.stack, cause: { message: cause.message } } },
  });
});

test('emits one unnamed Chat Completions error data frame for a post-head panic', async () => {
  const first = sse(chunk({ role: 'assistant', content: 'first content' }));
  const { status, text, failure, cause } = await mountedChatPanic(
    path, { ...request, model: 'test-model', stream: true }, { openaiChatCompletions: {} }, new Uint8Array(await first.arrayBuffer()),
  );
  expect(status).toBe(200);
  expect(text).toContain('first content');
  const errorBlock = text.trimEnd().split('\n\n').at(-1);
  expect(errorBlock).toMatch(/^data: \{"error":/);
  expect(JSON.parse(errorBlock!.slice('data: '.length))).toMatchObject({
    error: { type: 'internal_error', message: failure.message, provider_specific_fields: { stack: failure.stack, cause: { message: cause.message } } },
  });
  expect(text).not.toContain('[DONE]');
});

test.each(['prompt_cache_options', 'user'] as const)('rejects a null Chat Completions %s before routing', async field => {
  const host = operationHost([], async () => { throw new Error('Rejected input reached the transport'); });
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, { ...request, [field]: null }), host.options);
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    error: {
      message: `Invalid '${field}': expected ${field === 'user' ? 'a string' : 'an object'} when present.`,
      type: 'invalid_request_error', param: field, code: null,
    },
  });
  expect(host.catalogCandidates).not.toHaveBeenCalled();
});

test('replays opaque reasoning on its preferred Chat Completions candidate', async () => {
  const first = candidate('first');
  const second = candidate('second');
  let turn = 0;
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(new URL(url).hostname).toBe('first.example');
    turn++;
    if (turn === 1) return sse(chunk({ content: 'turn 1', reasoning_opaque: 'opaque-a' }, 'stop'));
    expect(JSON.parse(String(init.body))).toMatchObject({ messages: [{ role: 'user' }, { reasoning_opaque: 'opaque-a' }, { role: 'user' }] });
    return sse(chunk({ content: 'turn 2' }, 'stop'));
  });
  const host = operationHost([first, second], fetcher);
  const firstResponse = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, request), host.options);
  expect(firstResponse.status).toBe(200);
  const firstBody = await firstResponse.json() as { choices: { message: { content: string; reasoning_opaque: string } }[] };
  const assistant = firstBody.choices[0]!.message;
  expect(assistant.reasoning_opaque).toEqual(expect.any(String));
  expect(assistant.reasoning_opaque).not.toBe('opaque-a');
  host.catalogCandidates.mockResolvedValueOnce({ candidates: [second, first], sawModel: true });
  const replay = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, {
    ...request, messages: [...request.messages, assistant, { role: 'user', content: 'continue' }],
  }), host.options);
  expect(replay.status).toBe(200);
  await expect(replay.json()).resolves.toMatchObject({ choices: [{ message: { content: 'turn 2' } }] });
  await host.settle();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each([false, true])('preserves the client usage-chunk preference (%s) and upstream stream options', async includeUsage => {
  const host = operationHost([candidate()], async (_url, init) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ stream: true, stream_options: { include_usage: true, continuous_usage_stats: true } });
    return success();
  });
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, {
    ...request, stream: true, stream_options: { include_usage: includeUsage, continuous_usage_stats: true },
  }), host.options);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text.includes('"choices":[]')).toBe(includeUsage);
  await host.settle();
});

test('stores the selected Chat Completions TTFT for a streamed response', async () => {
  const dumpStubs = installDumpStubs(initDumpStore, initDumpBroker);
  const host = operationHost([candidate()], async () => success());
  const apiKey: ApiKey = {
    id: 'key-test', userId: 1, name: 'Chat Completions dump', key: 'secret',
    serverSecret: '0'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, randomizeUpstreams: false, deletedAt: null, dumpRetentionSeconds: 3600, openaiResponsesRetentionSeconds: 0,
  };
  const input = requestFor(path, { ...request, stream: true });
  const dump = new DumpAccumulator(apiKey, {
    method: 'POST', path, headers: [], bodyByteLength: input.http.body.byteLength, streamError: null,
  }, input.http.body, Date.now(), host.options.waitUntil, true);
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, input, {
    ...host.options, services: { ...host.options.services, dump }, dump,
  });
  expect(response.status).toBe(200);
  await response.text();
  await host.settle();
  expect(dumpStubs.stored).toHaveLength(1);
  expect(dumpStubs.stored[0]!.record.meta).toMatchObject({ model: 'public-model', ttftMs: expect.any(Number) });
  expect(dumpStubs.stored[0]!.record.meta.ttftMs).toBeGreaterThanOrEqual(0);
});

test('rejects a model without a reachable generation endpoint', async () => {
  const fetcher = vi.fn<Fetcher>(async () => { throw new Error('Unsupported request reached transport'); });
  const host = operationHost([customCandidate('gemini', { geminiGenerateContent: {} })], fetcher);
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, request), host.options);
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: { message: expect.stringContaining('/chat/completions') } });
  expect(fetcher).not.toHaveBeenCalled();
});

test('keeps native image parts across failover and applies rules to the selected wire request', async () => {
  const imageURL = 'https://images.example/image.png';
  const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: imageURL } }] }];
  const first = candidate('first');
  const second = candidate('second');
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    const body = JSON.parse(String(init.body)) as unknown;
    expect(body).toMatchObject({ model: 'wire-model', messages });
    if (new URL(url).hostname === 'first.example') return Response.json({ error: { message: 'try another' } }, { status: 503 });
    expect(body).toMatchObject({ reasoning_effort: 'low', verbosity: 'low' });
    return success();
  });
  const host = operationHost([first, { ...second, rules: { reasoning: { effort: 'low' }, verbosity: 'low' } }], fetcher);
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, { model: 'alias', messages }), host.options);
  expect(response.status).toBe(200);
  expect(host.catalogCandidates).toHaveBeenCalledExactlyOnceWith({ kind: 'chat', model: 'alias' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await host.settle();
});

test('applies native roles, forced reasoning and prompt cache rules before dispatch', async () => {
  const base = candidate();
  const host = operationHost([{
    ...base, model: {
      ...base.model, enabledFlags: [
        'rewrite-system-to-developer', 'rewrite-developer-to-system', 'rewrite-mid-conv-system-to-user',
        'strip-prompt-cache-key', 'disable-reasoning-on-forced-tool-choice',
      ],
    },
  }], async (_url, init) => {
    const body = JSON.parse(String(init.body)) as unknown;
    expect(body).toMatchObject({
      messages: [
        { role: 'system', content: 'base' }, { role: 'user', content: 'hello' },
        { role: 'user', content: 'inline' },
      ],
      reasoning_effort: 'none',
    });
    expect(body).not.toHaveProperty('prompt_cache_key');
    return success();
  });
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, {
    ...request, messages: [{ role: 'system', content: 'base' }, ...request.messages, { role: 'system', content: 'inline' }],
    prompt_cache_key: 'cache-key', tool_choice: 'required', reasoning_effort: 'high',
  }), host.options);
  expect(response.status).toBe(200);
  await host.settle();
});

test.each([
  { flag: 'rewrite-system-to-developer', roles: ['developer', 'developer'] },
  { flag: 'rewrite-developer-to-system', roles: ['system', 'system'] },
] as const)('applies the independent Chat Completions role rewrite $flag', async ({ flag, roles }) => {
  const base = candidate();
  const host = operationHost([{ ...base, model: { ...base.model, enabledFlags: [flag] } }], async (_url, init) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ messages: roles.map(role => expect.objectContaining({ role })) });
    return success();
  });
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, {
    ...request, messages: [{ role: 'system', content: 'one' }, { role: 'developer', content: 'two' }],
  }), host.options);
  expect(response.status).toBe(200);
  await host.settle();
});

test('applies the provider-owned Qwen Chat Completions reasoning projection', async () => {
  const base = candidate();
  const host = operationHost([{ ...base, model: { ...base.model, enabledFlags: ['vendor-qwen'] } }], async (_url, init) => {
    const body = JSON.parse(String(init.body)) as unknown;
    expect(body).toMatchObject({ enable_thinking: false });
    expect(body).not.toHaveProperty('reasoning_effort');
    return success();
  });
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, {
    ...request, reasoning_effort: 'none',
  }), host.options);
  expect(response.status).toBe(200);
  await host.settle();
});

test.each([
  { tools: [], choice: 'none' },
  { tools: undefined, choice: 'auto' },
  { tools: [{ type: 'function', function: { name: 'look' } }], choice: 'auto' },
])('normalizes tool_choice for explicitly empty Chat Completions tools ($choice)', async ({ tools, choice }) => {
  const base = candidate();
  const host = operationHost([{
    ...base, model: { ...base.model, enabledFlags: ['empty-tools-tool-choice-none'] },
  }], async (_url, init) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ tool_choice: choice });
    return success();
  });
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, {
    ...request, tools, tool_choice: 'auto',
  }), host.options);
  expect(response.status).toBe(200);
  await host.settle();
});

test('translates Chat Completions to Anthropic without forwarding the source beta header', async () => {
  const target = customCandidate('messages', { anthropicMessages: {} });
  const host = operationHost([target], async (url, init) => {
    expect(new URL(url).pathname).toBe('/v1/messages');
    expect(new Headers(init.headers).get('anthropic-beta')).toBeNull();
    return sse({
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'wire-model', content: [], usage: { input_tokens: 4, output_tokens: 0 } },
    }, { type: 'message_stop' });
  });
  const input = requestFor(path, request);
  input.http.headers.push(['anthropic-beta', 'source-protocol-beta']);
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, input, host.options);
  expect(response.status).toBe(200);
  await host.settle();
});

test('rewrites both base and inline instructions on a translated Responses wire', async () => {
  const target = customCandidate('responses', { openaiResponses: {} });
  const host = operationHost([{
    ...target, model: { ...target.model, enabledFlags: ['rewrite-system-to-developer'] },
  }], async (url, init) => {
    expect(new URL(url).pathname).toBe('/v1/responses');
    const body = JSON.parse(String(init.body)) as unknown;
    expect(body).not.toHaveProperty('instructions');
    expect(body).toMatchObject({
      input: [
        { type: 'message', role: 'developer', content: 'base instructions' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'developer', content: 'inline instructions' },
      ],
    });
    return sse({
      type: 'response.completed',
      response: { id: 'resp_1', object: 'response', status: 'completed', model: 'wire-model', output: [], error: null },
    });
  });
  const response = await servePipelineHttp(openaiChatCompletionsHttpEntry, requestFor(path, {
    ...request, messages: [
      { role: 'system', content: 'base instructions' },
      ...request.messages,
      { role: 'system', content: 'inline instructions' },
    ],
  }), host.options);
  expect(response.status).toBe(200);
  await host.settle();
});

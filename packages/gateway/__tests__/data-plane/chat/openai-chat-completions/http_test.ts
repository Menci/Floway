import { Hono } from 'hono';
import { beforeEach, expect, test, vi } from 'vitest';

import { mountChatRoutes } from '../../../../src/data-plane/chat/routes.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { getRepo, initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey } from '../../../../src/repo/types.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { generateReply as messagesReply } from '../anthropic-messages/fixture.ts';
import { chatUpstream, type ChatTestUpstream, fetcherFrom, interruptedUpload, providersFrom } from '../shared/fixture.ts';
import { createDumpDecoder, projectWireExchanges } from '@floway-dev/dump';
import type { Fetcher, FetchInit } from '@floway-dev/http';
import { Bytes } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';

const queue: (readonly ChatTestUpstream[])[] = [];
vi.mock('../../../../src/data-plane/pipeline/services.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/pipeline/services.ts')>();
  const createGatewayServices: typeof original.createGatewayServices = (...args) => {
    const upstreams = queue.shift() ?? [];
    return { ...original.createGatewayServices(...args), providers: providersFrom(upstreams), fetcher: fetcherFrom(upstreams) };
  };
  return { ...original, createGatewayServices };
});

beforeEach(() => {
  queue.length = 0;
  initRepo(new InMemoryRepo());
});

const apiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 'key-chat-completions-test', userId: 1, name: 'Chat Completions test', key: 'sk-test', serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
  dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0, ...overrides,
});

const makeApp = (overrides: Partial<ApiKey> = {}) => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', apiKey(overrides));
    c.set('user', { id: 1, username: 'test', passwordHash: null, isAdmin: false, createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null });
    await next();
  });
  mountChatRoutes(app);
  return app;
};

const send = (payload: unknown, options?: Partial<ApiKey>, headers: Record<string, string> = {}) => makeApp(options).request('/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
});

type Event = OpenAIChatCompletionsStreamEvent;

const upstream = (fetcher: Fetcher, upstreamId = 'test-upstream') =>
  chatUpstream({ upstreamId, endpoints: { openaiChatCompletions: {} }, fetcher });

const requestJson = <Payload>(init: FetchInit): Payload => {
  if (!(init.body instanceof Uint8Array)) throw new TypeError('Expected buffered provider request bytes');
  return JSON.parse(new TextDecoder().decode(init.body)) as Payload;
};

const user = { role: 'user', content: 'hello' };
const frame = (choices: Event['choices'], model = 'test-model'): Event => ({
  id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 0, model, choices,
});
const sseData = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;
const sseReply = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream', ...headers } });
const chatReply = (events: readonly Event[], headers?: Record<string, string>) =>
  sseReply(`${events.map(sseData).join('')}data: [DONE]\n\n`, headers);
const normalReply = (headers?: Record<string, string>) => chatReply([
  frame([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]),
  frame([{ index: 0, delta: { content: 'hi' }, finish_reason: null }]),
  frame([{ index: 0, delta: {}, finish_reason: 'stop' }]),
  { ...frame([]), usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
], headers);

test('an interrupted Chat Completions upload answers with the original upload failure', async () => {
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  const response = await makeApp({ dumpRetentionSeconds: 3600 }).request(interruptedUpload('/v1/chat/completions'));
  expect(response.status).toBe(502);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toEqual({
    error: {
      type: 'internal_error', message: 'client upload interrupted',
      provider_specific_fields: { name: 'Error', stack: expect.stringMatching(/^Error: client upload interrupted/) },
    },
  });
  await flushBackground();
  expect(dump.stored[0].meta).toMatchObject({
    status: 502, requestBytes: 0, error: { kind: 'failed', reason: 'client upload interrupted' },
  });
  const decoder = createDumpDecoder();
  decoder.push(dump.stored[0].artifact);
  const trace = decoder.finish();
  const stages = [...trace.stages.values()];
  expect(stages.find(stage => stage.name === 'parsePayload')?.responseFacts).toMatchObject({
    'response.http': { status: 502, body: expect.any(Bytes) },
  });
  expect(projectWireExchanges(trace).upstreamExchanges).toEqual([]);
  expect(stages.map(stage => stage.name)).not.toContain('resolveCandidates');
});

test('POST /v1/chat/completions rejects invalid JSON before choosing an upstream', async () => {
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  const response = await makeApp({ dumpRetentionSeconds: 3600 }).request('/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"unfinished":',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { message: 'Chat Completions request body must be valid JSON.', type: 'invalid_request_error', param: null, code: null },
  });
  await flushBackground();
  const decoder = createDumpDecoder();
  decoder.push(dump.stored[0].artifact);
  const trace = decoder.finish();
  expect([...trace.stages.values()].map(stage => stage.name)).not.toContain('resolveCandidates');
  expect(projectWireExchanges(trace).upstreamExchanges).toEqual([]);
});

test.each(['prompt_cache_options', 'user'] as const)('POST /v1/chat/completions rejects a null %s', async field => {
  const response = await send({ model: 'test-model', messages: [user], [field]: null });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      message: `Invalid '${field}': expected ${field === 'user' ? 'a string' : 'an object'} when present.`,
      type: 'invalid_request_error', param: field, code: null,
    },
  });
});

test('client-carried opaque state restores the exact preferred candidate on the next turn', async () => {
  const observed: OpenAIChatCompletionsPayloadEx[] = [];
  const callA = vi.fn<Fetcher>(async (_url, init) => {
    observed.push(requestJson<OpenAIChatCompletionsPayloadEx>(init));
    const turn = observed.length;
    return chatReply([
      frame([{ index: 0, delta: { content: `turn ${turn}`, ...(turn === 1 ? { reasoning_opaque: 'opaque-a' } : {}) }, finish_reason: null }]),
      frame([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    ]);
  });
  const callB = vi.fn<Fetcher>(() => { throw new Error('Affinity should have reordered candidate A before B'); });
  const first = upstream(callA, 'up-a');
  const second = upstream(callB, 'up-b');
  queue.push([first, second], [second, first]);

  const initial = await send({ model: 'test-model', messages: [user] });
  expect(initial.status).toBe(200);
  const body = await initial.json() as { choices: { message: { content: string; reasoning_opaque: string } }[] };
  const assistant = body.choices[0].message;
  expect(assistant.reasoning_opaque).toEqual(expect.any(String));
  expect(assistant.reasoning_opaque).not.toBe('opaque-a');

  const continued = await send({ model: 'test-model', messages: [user, assistant, { role: 'user', content: 'continue' }] });
  expect(continued.status).toBe(200);
  expect(callA).toHaveBeenCalledTimes(2);
  expect(callB).not.toHaveBeenCalled();
  expect(observed[1].messages[1]).toMatchObject({ reasoning_opaque: 'opaque-a' });
});

test.each([false, true])('POST /v1/chat/completions emits the usage-only chunk only when stream_options.include_usage is set (%s)', async includeUsage => {
  const call = vi.fn<Fetcher>(async () => normalReply());
  queue.push([upstream(call)]);
  const response = await send({
    model: 'test-model', stream: true, messages: [user],
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
  });
  expect(response.status).toBe(200);
  expect((await response.text()).includes('"choices":[]')).toBe(includeUsage);
  expect(requestJson<OpenAIChatCompletionsPayloadEx>(call.mock.calls[0][1]).stream_options).toMatchObject({ include_usage: true });
});

test('POST /v1/chat/completions stamps TTFT on a streamed record', async () => {
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  queue.push([upstream(async () => normalReply())]);
  const response = await send({ model: 'test-model', stream: true, messages: [user] }, { dumpRetentionSeconds: 3600 });
  expect(response.status).toBe(200);
  await response.text();
  await flushBackground();
  expect(dump.stored).toHaveLength(1);
  expect(dump.stored[0].meta).toMatchObject({ model: 'test-model', inputTokens: 4, outputTokens: 2 });
  expect(dump.stored[0].meta.ttftMs).toBeGreaterThanOrEqual(0);
});

test('filters candidates that do not expose a compatible Chat Completions endpoint', async () => {
  queue.push([chatUpstream({ endpoints: { openaiEmbeddings: {} } })]);
  const response = await send({ model: 'test-model', messages: [user] });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { type: 'invalid_request_error', message: 'Model test-model does not support the /chat/completions endpoint.' },
  });
});

test('retries an upstream API error and uses the next candidate', async () => {
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  const failed = vi.fn<Fetcher>(async () => new Response('temporarily unavailable', { status: 429, headers: { 'retry-after': '5' } }));
  const succeeded = vi.fn<Fetcher>(async () => normalReply({ 'request-id': 'req-success' }));
  queue.push([upstream(failed, 'first'), upstream(succeeded, 'second')]);
  const response = await send({ model: 'test-model', messages: [user] }, { dumpRetentionSeconds: 3600 });
  expect(response.status).toBe(200);
  expect(response.headers.get('request-id')).toBe('req-success');
  expect((await response.text())).toContain('"content":"hi"');
  expect(failed).toHaveBeenCalledOnce();
  expect(succeeded).toHaveBeenCalledOnce();
  await flushBackground();
  expect(await getRepo().usage.listAll()).toMatchObject([{
    upstream: 'second', requests: 1,
    metrics: [{ metric: 'input_tokens', quantity: '4' }, { metric: 'output_tokens', quantity: '2' }],
  }]);
  expect((await getRepo().performance.listAll()).sort((a, b) => a.upstream.localeCompare(b.upstream))).toMatchObject([
    { upstream: 'first', requests: 1, errorsNoOutput: 1 },
    { upstream: 'second', requests: 1, errorsNoOutput: 0, ttftSamplesOk: 1 },
  ]);
  expect(dump.stored[0].meta).toMatchObject({ status: 200, model: 'test-model', inputTokens: 4, outputTokens: 2 });
});

test('overlays alias rules on the terminal request and uses the target provider model', async () => {
  const call = vi.fn<Fetcher>(async () => normalReply());
  queue.push([chatUpstream({
    modelId: 'target-model', endpoints: { openaiChatCompletions: {} },
    rules: { reasoning: { effort: 'high' }, verbosity: 'low' },
    fetcher: call,
  })]);
  const response = await send({ model: 'alias-model', messages: [user], reasoning_effort: 'low' });
  expect(response.status).toBe(200);
  await response.text();
  expect(requestJson<OpenAIChatCompletionsPayloadEx>(call.mock.calls[0][1])).toMatchObject({
    model: 'target-model', reasoning_effort: 'high', verbosity: 'low',
  });
});

test.each([1, 2])('EOF with one finished choice and %i requested choices', async n => {
  queue.push([upstream(async () => sseReply(sseData(frame([{ index: 0, delta: { content: 'usable' }, finish_reason: 'stop' }]))))]);
  const response = await send({ model: 'test-model', messages: [user], stream: true, n });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('usable');
  expect(body.includes('OpenAI Chat Completions stream ended before all choices finished.')).toBe(n === 2);
});

test.each([false, true])('a broken Chat Completions source retains nested diagnostics (stream=%s)', async stream => {
  const cause = new TypeError('nested');
  cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause });
  failure.stack = 'Error: broken\n  at render';
  queue.push([upstream(async () => {
    let sent = false;
    return sseReply(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(failure);
          return;
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode(sseData(frame([{ index: 0, delta: { content: 'partial' }, finish_reason: null }]))));
      },
    }));
  })]);
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  const response = await send({ model: 'test-model', messages: [user], stream }, { dumpRetentionSeconds: 3600 });
  expect(response.status).toBe(stream ? 200 : 502);
  const wire = await response.text();
  const line = stream ? wire.split('\n').find(line => line.startsWith('data: {"error":')) : wire;
  expect(line).toBeDefined();
  expect(JSON.parse(stream ? line!.slice(6) : wire)).toEqual({
    error: {
      type: 'internal_error', message: 'broken',
      provider_specific_fields: { name: 'Error', stack: failure.stack, cause: { name: 'TypeError', message: 'nested', stack: cause.stack } },
    },
  });
  expect(wire).not.toContain('event: error');
  expect(wire).not.toContain('data: [DONE]');
  await flushBackground();
  if (stream) {
    const decoder = createDumpDecoder();
    decoder.push(dump.stored[0].artifact);
    const { downstreamResponse } = projectWireExchanges(decoder.finish());
    const written = downstreamResponse?.stream?.frames.flatMap(frame => frame.value instanceof Bytes ? [frame.value] : []);
    expect(written).toBeDefined();
    expect(Bytes.concat(written!).utf8()).toBe(wire);
  }
});

test('translation re-enters Messages with explicit empty betas and keeps native Chat Completions stages off that wire', async () => {
  const call = vi.fn<Fetcher>(async (_url, init) => {
    expect(new Headers(init.headers).get('anthropic-beta')).toBeNull();
    expect(requestJson(init)).toMatchObject({ stream: true });
    return messagesReply();
  });
  queue.push([chatUpstream({
    endpoints: { anthropicMessages: {} }, flags: ['usage-exclusive-cached-tokens'],
    fetcher: call,
  })]);
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  const response = await send({ model: 'test-model', messages: [user], max_tokens: 32, stream: false }, { dumpRetentionSeconds: 3600 }, {
    'anthropic-beta': 'must-not-cross-source-protocols',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'answer' } }] });
  expect(call).toHaveBeenCalledOnce();
  await flushBackground();
  const decoder = createDumpDecoder();
  decoder.push(dump.stored[0].artifact);
  const trace = decoder.finish();
  const stages = [...trace.stages.values()];
  expect(stages.map(stage => stage.name)).toContain('prepareGenerate');
  expect(stages.map(stage => stage.name)).not.toContain('normalizeExclusiveCachedTokens');
  const [exchange] = projectWireExchanges(trace).upstreamExchanges;
  expect(trace.stages.get(exchange.stageId)?.facts['request.anthropicBeta']).toEqual([]);
  expect([...trace.streams.values()].find(stream => stream.label === 'http.events')?.frames[0].value)
    .toMatchObject({ type: 'event', event: { type: 'message_start' } });
});

test.each([
  [JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'wait' }, request_id: 'req-wait' }),
    { error: { message: 'wait', type: 'rate_limit_error', provider_specific_fields: { request_id: 'req-wait' } } }],
  ['native plain-text error', { error: { type: 'upstream_error', message: 'native plain-text error' } }],
])('translation preserves upstream status and records the original error body %s', async (raw, expected) => {
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  queue.push([chatUpstream({
    endpoints: { anthropicMessages: {} },
    fetcher: async () => new Response(raw, { status: 429, headers: { 'retry-after': '7' } }),
  })]);
  const response = await send({ model: 'test-model', messages: [user], max_tokens: 32 }, { dumpRetentionSeconds: 3600 });
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('7');
  expect(await response.json()).toEqual(expected);
  await flushBackground();
  const decoder = createDumpDecoder();
  decoder.push(dump.stored[0].artifact);
  const trace = decoder.finish();
  const { upstreamExchanges } = projectWireExchanges(trace);
  expect(upstreamExchanges).toHaveLength(1);
  const [{ stageId, response: http }] = upstreamExchanges;
  expect(trace.stages.get(stageId)).toMatchObject({ name: 'http', pipeline: 'custom.anthropicMessages', childStageIds: [] });
  expect(http).toMatchObject({ status: 429, exchange: 'upstream' });
  expect(http.stream?.frames.map(frame => frame.value)).toEqual([Bytes.fromUtf8(raw)]);
});

test('translation to Responses preserves both system messages for the target role normalizer', async () => {
  const call = vi.fn<Fetcher>(async (url, init) => {
    expect(new URL(url).pathname).toBe('/v1/responses');
    const payload = requestJson<OpenAIResponsesRequestPayloadEx>(init);
    expect(payload).not.toHaveProperty('instructions');
    expect(payload.input).toEqual([
      { type: 'message', role: 'developer', content: 'base instructions' },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'developer', content: 'inline instructions' },
    ]);
    return sseReply(`event: response.completed\n${sseData({
      type: 'response.completed', sequence_number: 0,
      response: { id: 'resp_test', object: 'response', model: 'test-model', status: 'completed', output: [], error: null, incomplete_details: null },
    })}`);
  });
  queue.push([chatUpstream({
    endpoints: { openaiResponses: {} }, flags: ['rewrite-system-to-developer'],
    fetcher: call,
  })]);
  const result = await send({
    model: 'test-model', stream: true,
    messages: [{ role: 'system', content: 'base instructions' }, user, { role: 'system', content: 'inline instructions' }],
  });
  expect(result.status).toBe(200);
  expect(await result.text()).toContain('data: [DONE]');
  expect(call).toHaveBeenCalledOnce();
});

import { Hono } from 'hono';
import { beforeEach, expect, test, vi } from 'vitest';

import { mountChatRoutes } from '../../../../src/data-plane/chat/routes.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey } from '../../../../src/repo/types.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { defaultFrames as anthropicFrames } from '../anthropic-messages/fixture.ts';
import { chatUpstream, type ChatTestUpstream, eventReply, httpReply, providersFrom, stubStreamProvider, stubUpstreamPipeline } from '../shared/fixture.ts';
import { createDumpDecoder, projectWireExchanges } from '@floway-dev/dump';
import { Bytes, type StageEnv } from '@floway-dev/pipeline';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProviderAnthropicInput, ProviderInput, ProviderResponsesInput, ProviderResponsesOutput, ProviderStreamOutput } from '@floway-dev/provider';

const queue: (readonly ChatTestUpstream[])[] = [];
vi.mock('../../../../src/data-plane/pipeline/services.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/pipeline/services.ts')>();
  const createGatewayServices: typeof original.createGatewayServices = (...args) => ({
    ...original.createGatewayServices(...args), providers: providersFrom(queue.shift() ?? []),
  });
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
type Input = ProviderInput<Omit<OpenAIChatCompletionsPayloadEx, 'model'>>;
type Reply = (facts: Input, env: StageEnv) => ProviderStreamOutput<Event> | Promise<ProviderStreamOutput<Event>>;

const upstream = (respond: Reply, upstreamId = 'test-upstream') => chatUpstream({
  upstreamId, endpoints: { openaiChatCompletions: {} },
  pipelines: { openaiChatCompletions: stubStreamProvider('stub Chat Completions', respond) },
});

const user = { role: 'user', content: 'hello' };
const frame = (choices: Event['choices'], model = 'test-model'): Event => ({
  id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 0, model, choices,
});
const frames = async function* (events: readonly Event[]) {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};
const normalFrames = () => frames([
  frame([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]),
  frame([{ index: 0, delta: { content: 'hi' }, finish_reason: null }]),
  frame([{ index: 0, delta: {}, finish_reason: 'stop' }]),
  { ...frame([]), usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
]);

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
  const observed: Input['request.payload'][] = [];
  const callA = vi.fn<Reply>((facts, env) => {
    observed.push(facts['request.payload']);
    const turn = observed.length;
    return eventReply(env, frames([
      frame([{ index: 0, delta: { content: `turn ${turn}`, ...(turn === 1 ? { reasoning_opaque: 'opaque-a' } : {}) }, finish_reason: null }]),
      frame([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    ]));
  });
  const callB = vi.fn<Reply>(() => { throw new Error('Affinity should have reordered candidate A before B'); });
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
  const call = vi.fn<Reply>((_facts, env) => eventReply(env, normalFrames()));
  queue.push([upstream(call)]);
  const response = await send({
    model: 'test-model', stream: true, messages: [user],
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
  });
  expect(response.status).toBe(200);
  expect((await response.text()).includes('"choices":[]')).toBe(includeUsage);
  expect(call.mock.calls[0][0]['request.payload'].stream_options).toMatchObject({ include_usage: true });
});

test('POST /v1/chat/completions stamps TTFT on a streamed record', async () => {
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  queue.push([upstream((_facts, env) => eventReply(env, normalFrames()))]);
  const response = await send({ model: 'test-model', stream: true, messages: [user] }, { dumpRetentionSeconds: 3600 });
  expect(response.status).toBe(200);
  await response.text();
  await flushBackground();
  expect(dump.stored).toHaveLength(1);
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
  const failed = vi.fn<Reply>(async (_facts, env) => ({
    ...await httpReply(env, new Response('temporarily unavailable', { status: 429, headers: { 'retry-after': '5' } })),
    'response.events': undefined,
  }));
  const succeeded = vi.fn<Reply>((_facts, env) => eventReply(env, normalFrames(), [['request-id', 'req-success']]));
  queue.push([upstream(failed, 'first'), upstream(succeeded, 'second')]);
  const response = await send({ model: 'test-model', messages: [user] });
  expect(response.status).toBe(200);
  expect(response.headers.get('request-id')).toBe('req-success');
  expect((await response.text())).toContain('"content":"hi"');
  expect(failed).toHaveBeenCalledOnce();
  expect(succeeded).toHaveBeenCalledOnce();
});

test('overlays alias rules on the terminal request and uses the target provider model', async () => {
  const call = vi.fn<Reply>((_facts, env) => eventReply(env, normalFrames()));
  queue.push([chatUpstream({
    modelId: 'target-model', endpoints: { openaiChatCompletions: {} },
    rules: { reasoning: { effort: 'high' }, verbosity: 'low' },
    pipelines: { openaiChatCompletions: stubStreamProvider('stub Chat Completions', call) },
  })]);
  const response = await send({ model: 'alias-model', messages: [user], reasoning_effort: 'low' });
  expect(response.status).toBe(200);
  await response.text();
  expect(call.mock.calls[0][0]['provider.model'].id).toBe('target-model');
  expect(call.mock.calls[0][0]['request.payload']).toMatchObject({ reasoning_effort: 'high', verbosity: 'low' });
  expect(call.mock.calls[0][0]['request.payload']).not.toHaveProperty('model');
});

test.each([1, 2])('EOF with one finished choice and %i requested choices', async n => {
  queue.push([upstream((_facts, env) => eventReply(env, (async function* () {
    yield eventFrame(frame([{ index: 0, delta: { content: 'usable' }, finish_reason: 'stop' }]));
  })()))]);
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
  queue.push([upstream((_facts, env) => eventReply(env, (async function* () {
    yield eventFrame(frame([{ index: 0, delta: { content: 'partial' }, finish_reason: null }]));
    throw failure;
  })()))]);
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
  const call = vi.fn((facts: ProviderAnthropicInput, env: StageEnv) => {
    expect(facts['request.anthropicBeta']).toEqual([]);
    expect(facts['request.headers']).toEqual([]);
    expect(facts['request.payload'].stream).toBe(true);
    return eventReply(env, anthropicFrames());
  });
  queue.push([chatUpstream({
    endpoints: { anthropicMessages: {} }, flags: ['usage-exclusive-cached-tokens'],
    pipelines: { anthropicMessages: stubStreamProvider('stub Messages', call) },
  })]);
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  const response = await send({ model: 'test-model', messages: [user], max_tokens: 32, stream: true }, { dumpRetentionSeconds: 3600 }, {
    'anthropic-beta': 'must-not-cross-source-protocols',
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('data: [DONE]');
  expect(call).toHaveBeenCalledOnce();
  await flushBackground();
  const decoder = createDumpDecoder();
  decoder.push(dump.stored[0].artifact);
  const trace = decoder.finish();
  const stages = [...trace.stages.values()].map(stage => stage.name);
  expect(stages).toContain('prepareGenerate');
  expect(stages).not.toContain('normalizeExclusiveCachedTokens');
});

test('translation to Responses preserves both system messages for the target role normalizer', async () => {
  const upstream = vi.fn((facts: ProviderResponsesInput, env: StageEnv): ProviderResponsesOutput => {
    expect(facts['request.action']).toBe('generate');
    expect(facts['request.payload']).not.toHaveProperty('instructions');
    expect(facts['request.payload'].input).toEqual([
      { type: 'message', role: 'developer', content: 'base instructions' },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'developer', content: 'inline instructions' },
    ]);
    return {
      ...eventReply<OpenAIResponsesStreamEventEx>(env, (async function* () {
        yield eventFrame({
          type: 'response.completed', sequence_number: 0,
          response: { id: 'resp_test', object: 'response', model: 'test-model', status: 'completed', output: [], error: null, incomplete_details: null },
        });
        yield doneFrame();
      })()),
      'response.result': undefined,
    };
  });
  queue.push([chatUpstream({
    endpoints: { openaiResponses: {} }, flags: ['rewrite-system-to-developer'],
    pipelines: {
      openaiResponses: stubUpstreamPipeline('stub Responses', ['response.http', 'response.modelKey', 'response.events', 'response.result'], upstream),
    },
  })]);
  const result = await send({
    model: 'test-model', stream: true,
    messages: [{ role: 'system', content: 'base instructions' }, user, { role: 'system', content: 'inline instructions' }],
  });
  expect(result.status).toBe(200);
  expect(await result.text()).toContain('data: [DONE]');
  expect(upstream).toHaveBeenCalledOnce();
});

import { expect, expectTypeOf, it } from 'vitest';

import { protocolErrorDebugFields, type InternalDebugError } from '../src/error.ts';
import { httpTerminal, type UpstreamHttpResponseFacts, type UpstreamHttpServices } from '../src/http-terminal.ts';
import type { UpstreamModel, UpstreamRecord } from '../src/model.ts';
import { httpDialError, parseJsonBody, parseUpstreamResult, parseUpstreamStream } from '../src/parse-response.ts';
import { toUpstreamModelSnapshot, toUpstreamSnapshot, type UpstreamOperation, type UpstreamPipeline, type UpstreamRequest, type UpstreamRequestFacts, type UpstreamResponseFacts } from '../src/pipeline-facts.ts';
import { HttpTransportError, type Fetcher } from '@floway-dev/http';
import { asEntry, factSpace, run } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import { decodeOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';

type TestResponseFacts = UpstreamResponseFacts & UpstreamHttpResponseFacts;
interface TestServices extends UpstreamHttpServices {
  observeParserPanic(panic: unknown): void;
}
const { defineStage, compose } = factSpace<UpstreamRequestFacts, TestResponseFacts, TestServices>();

const formatError = (status: number | null, message: string, diagnostic?: InternalDebugError) => ({
  error: { status, message, ...protocolErrorDebugFields(diagnostic) },
});
const TEST_CHUNK_BYTES = 1024 * 1024;
const TEST_RESULT_BODY_LIMIT = 2 * TEST_CHUNK_BYTES;
const TEST_ERROR_BODY_LIMIT = TEST_CHUNK_BYTES;

const recordParserPanic = <T>(promise: Promise<T>, services: TestServices): Promise<T> => promise.catch((panic: unknown) => {
  services.observeParserPanic(panic);
  throw panic;
});

const embeddingsDial = defineStage({
  name: 'test.openaiEmbeddings.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiEmbeddings'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiEmbeddings'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { 'http.error': failure, ...answer } = await scope.next({
      ...facts,
      http: { ...facts.http, body: JSON.stringify(facts.openaiEmbeddings) },
    });
    if (failure !== undefined) return { ...answer, openaiEmbeddings: httpDialError(failure, formatError) };
    if (answer.http === null) throw new Error('Expected HTTP response headers or a dial error');
    const parsing = parseUpstreamResult(answer.http, scope, bytes => {
      const result = parseJsonBody(bytes);
      if (!result.ok) return result;
      return isJsonObject(result.value)
        ? { ok: true, value: result.value }
        : { ok: false, error: new Error('Expected a JSON object') };
    }, formatError, { maxResultBodyBytes: TEST_RESULT_BODY_LIMIT, maxErrorBodyBytes: TEST_ERROR_BODY_LIMIT });
    const parsed = await recordParserPanic(parsing, scope.services);
    return { ...answer, http: parsed.http, openaiEmbeddings: parsed.outcome };
  },
});

const embeddings = compose('test.openaiEmbeddings', {
  entry: ['http', 'upstream', 'model', 'openaiEmbeddings'],
  exit: ['http', 'openaiEmbeddings'],
  stages: [embeddingsDial],
  ending: httpTerminal,
});

const chatCompletionsDial = defineStage({
  name: 'test.openaiChatCompletions.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiChatCompletions'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiChatCompletions'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { 'http.error': failure, ...answer } = await scope.next({
      ...facts,
      http: { ...facts.http, body: JSON.stringify(facts.openaiChatCompletions) },
    });
    if (failure !== undefined) return { ...answer, openaiChatCompletions: httpDialError(failure, formatError) };
    if (answer.http === null) throw new Error('Expected HTTP response headers or a dial error');
    const parsing = parseUpstreamStream(answer.http, scope, decodeOpenAIChatCompletionsStream, formatError, TEST_ERROR_BODY_LIMIT);
    const parsed = await recordParserPanic(parsing, scope.services);
    return { ...answer, http: parsed.http, openaiChatCompletions: parsed.outcome };
  },
});

const chatCompletions = compose('test.openaiChatCompletions', {
  entry: ['http', 'upstream', 'model', 'openaiChatCompletions'],
  exit: ['http', 'openaiChatCompletions'],
  stages: [chatCompletionsDial],
  ending: httpTerminal,
});

const record: UpstreamRecord = {
  id: 'test-upstream',
  kind: 'custom',
  name: 'Test Upstream',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
  config: { endpoint: 'https://service.test' },
  state: { accessToken: 'rotating' },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 0,
};

const model: UpstreamModel = {
  id: 'test-model',
  upstreamModelId: 'native-model',
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  kind: 'chat',
  limits: {},
  endpoints: { openaiChatCompletions: {}, openaiEmbeddings: {} },
  enabledFlags: new Set(['openai-responses-store-false']),
  flagOverrides: { 'openai-responses-store-false': true },
};

const requestBase = {
  upstream: toUpstreamSnapshot(record),
  model: toUpstreamModelSnapshot(model),
  http: { method: 'POST', url: 'https://service.test', headers: [], body: new Uint8Array([0]) },
};

const embeddingsRequest: UpstreamRequest<'openaiEmbeddings'> = {
  ...requestBase,
  openaiEmbeddings: { model: 'test-model', input: 'Text' },
};

const chatCompletionsRequest: UpstreamRequest<'openaiChatCompletions'> = {
  ...requestBase,
  openaiChatCompletions: { model: 'test-model', messages: [] },
};

const runWith = <Op extends UpstreamOperation>(pipeline: UpstreamPipeline<Op, TestServices>, facts: UpstreamRequest<Op>, fetcher: Fetcher, signal = new AbortController().signal) => {
  const background: Promise<unknown>[] = [];
  const parserPanics: unknown[] = [];
  const execution = run(asEntry(pipeline), facts, {
    services: {
      fetcher(id) {
        expect(id).toBe(record.id);
        return fetcher;
      },
      observeParserPanic: panic => { parserPanics.push(panic); },
    },
    signal,
    waitUntil: work => { background.push(work); },
  });
  return { execution, background, parserPanics };
};

it('projects configuration and model data into exact operation boundaries', async () => {
  expectTypeOf(embeddings).toExtend<UpstreamPipeline<'openaiEmbeddings', TestServices>>();
  expectTypeOf<UpstreamPipeline<'openaiEmbeddings', TestServices>>().toExtend<typeof embeddings>();
  expectTypeOf(chatCompletions).toExtend<UpstreamPipeline<'openaiChatCompletions', TestServices>>();
  expectTypeOf<UpstreamPipeline<'openaiChatCompletions', TestServices>>().toExtend<typeof chatCompletions>();
  const { execution } = runWith(embeddings, embeddingsRequest, async (_url, init) => {
    expect(init.body).toBe('{"model":"test-model","input":"Text"}');
    return Response.json({ data: [] });
  });
  const answer = await execution.result;
  expect(answer.openaiEmbeddings).toEqual({ kind: 'result', result: { data: [] } });
  expect(requestBase.upstream).toEqual({ id: record.id, kind: record.kind, name: record.name, config: record.config });
  expect(requestBase.model).not.toHaveProperty('flagOverrides');
  expect(requestBase.model.enabledFlags).toEqual(['openai-responses-store-false']);
  expect(Object.isFrozen(requestBase.model.enabledFlags)).toBe(true);
  expect(Object.isFrozen(requestBase.upstream.config)).toBe(true);
  expect(() => compose('test.leaky-http', {
    entry: ['http', 'upstream'], exit: ['http'], stages: [], ending: httpTerminal,
  })).toThrow('test.leaky-http exit disagrees with the stages on "http.error"');
});

it('consumes pre-header transport and cancellation errors as ordinary outcomes', async () => {
  const nested = new Error('socket closed');
  const cause = new TypeError('dial failed', { cause: nested });
  const failure = new HttpTransportError(cause);
  const outage = runWith(embeddings, embeddingsRequest, async () => { throw failure; });
  await expect(outage.execution.result).resolves.toEqual({
    http: null,
    openaiEmbeddings: {
      kind: 'error', source: 'upstream', error: {
        error: {
          status: null,
          message: 'dial failed',
          provider_specific_fields: {
            name: 'HttpTransportError',
            stack: failure.stack,
            cause: {
              name: 'TypeError', message: 'dial failed', stack: cause.stack,
              cause: { name: 'Error', message: 'socket closed', stack: nested.stack },
            },
          },
        },
      },
    },
  });

  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  const cancelled = runWith(embeddings, embeddingsRequest, async () => { throw new Error('unexpected dial'); }, controller.signal);
  await expect(cancelled.execution.result).resolves.toEqual({
    http: null,
    openaiEmbeddings: { kind: 'error', source: 'local', error: { error: { status: 499, message: 'Upstream request cancelled' } } },
  });
});

it('preserves HTTP error headers and the transport cause when the error body cannot be read', async () => {
  const cause = new Error('peer reset');
  const failure = new HttpTransportError(cause);
  const body = new ReadableStream<Uint8Array>({ start: controller => { controller.error(failure); } });
  const headerLines = [['retry-after', '30']] as const;
  const { execution, background } = runWith(embeddings, embeddingsRequest, async () => Object.assign(new Response(body, {
    status: 503, statusText: 'Unavailable',
  }), { headerLines }));
  await expect(execution.result).resolves.toEqual({
    http: { status: 503, statusText: 'Unavailable', headers: headerLines, body: null, startedAt: expect.any(Number) },
    openaiEmbeddings: {
      kind: 'error', source: 'upstream', error: {
        error: {
          status: 503,
          message: 'peer reset',
          provider_specific_fields: {
            name: 'HttpTransportError', stack: failure.stack, cause: { name: 'Error', message: 'peer reset', stack: cause.stack },
          },
        },
      },
    },
  });
  await Promise.all(background);
});

it('preserves upstream error status, header repetitions, JSON values and plain error messages', async () => {
  const headerLines = [['x-upstream', 'a'], ['x-upstream', 'b']] as const;
  const json = runWith(embeddings, embeddingsRequest, async () => Object.assign(new Response('{"id":9007199254740993}', {
    status: 429,
    statusText: 'Rate Limited',
  }), { headerLines }));
  const answer = await json.execution.result;
  expect(answer.http).toEqual({ status: 429, statusText: 'Rate Limited', headers: headerLines, body: null, startedAt: expect.any(Number) });
  expect(answer.openaiEmbeddings.kind).toBe('error');
  if (answer.openaiEmbeddings.kind !== 'error') throw new Error('Expected an OpenAI embeddings error');
  expect(JSON.stringify(answer.openaiEmbeddings.error)).toBe('{"id":9007199254740993}');

  const plain = runWith(embeddings, embeddingsRequest, async () => new Response('provider rejected the input', { status: 400 }));
  await expect(plain.execution.result).resolves.toMatchObject({
    http: { status: 400, body: null },
    openaiEmbeddings: { kind: 'error', source: 'upstream', error: { error: { status: 400, message: 'provider rejected the input' } } },
  });
});

it('treats a damaged successful scalar as an expected upstream error and preserves the HTTP head', async () => {
  const { execution } = runWith(embeddings, embeddingsRequest, async () => new Response('null', { status: 200 }));
  await expect(execution.result).resolves.toMatchObject({
    http: { status: 200, body: null },
    openaiEmbeddings: { kind: 'error', source: 'upstream', error: { error: { status: 502, message: 'Expected a JSON object' } } },
  });
});

it.each([
  { path: 'a successful scalar', status: 200, streaming: false, limit: TEST_RESULT_BODY_LIMIT },
  { path: 'an HTTP error for a scalar', status: 429, streaming: false, limit: TEST_ERROR_BODY_LIMIT },
  { path: 'an HTTP error for a stream', status: 429, streaming: true, limit: TEST_ERROR_BODY_LIMIT },
])('panics on byte overflow while the source for $path is still open', async ({ status, streaming, limit }) => {
  const chunk = new Uint8Array(TEST_CHUNK_BYTES);
  const overflowAt = limit + chunk.byteLength;
  const totalBytes = 64 * chunk.byteLength;
  const waitingForCleanup = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  let emittedBytes = 0;
  let foregroundBytes = 0;
  let done = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (emittedBytes === overflowAt) {
        waitingForCleanup.resolve();
        await releaseCleanup.promise;
      }
      if (emittedBytes === totalBytes) {
        done = true;
        controller.close();
        return;
      }
      if (background.length === 0) foregroundBytes += chunk.byteLength;
      emittedBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const fetcher: Fetcher = async () => new Response(body, { status });
  const { execution, background, parserPanics } = streaming
    ? runWith(chatCompletions, chatCompletionsRequest, fetcher)
    : runWith(embeddings, embeddingsRequest, fetcher);
  const settled = execution.result.catch((panic: unknown) => panic);
  try {
    await waitingForCleanup.promise;
    expect(background).toHaveLength(1);
    const panic = await settled;
    expect(panic).toBeInstanceOf(RangeError);
    expect(panic).toHaveProperty('message', `Upstream response body exceeds ${limit} bytes`);
    expect(parserPanics).toHaveLength(1);
    expect(panic).toBe(parserPanics[0]);
    expect(foregroundBytes).toBe(overflowAt);
    expect(emittedBytes).toBe(overflowAt);
    expect(done).toBe(false);
  } finally {
    releaseCleanup.resolve();
    await Promise.all(background);
  }
  expect(emittedBytes).toBe(totalBytes);
  expect(done).toBe(true);
});

it('passes an unexpected HTTP fetch rejection through the terminal by identity', async () => {
  const panic = new TypeError('unexpected fetch bug');
  const { execution } = runWith(embeddings, embeddingsRequest, async () => { throw panic; });
  await expect(execution.result).rejects.toBe(panic);
});

const eventStreamResponse = (body: BodyInit) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

it('publishes the decoded protocol stream and completes at ordinary EOF', async () => {
  const { execution } = runWith(chatCompletions, chatCompletionsRequest, async () => eventStreamResponse('data: {"choices":[]}\n\n'));
  const answer = await execution.result;
  expect(answer.http).toMatchObject({ status: 200, body: null });
  if (answer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected an OpenAI Chat Completions stream');
  const cursor = execution.read(answer.openaiChatCompletions.stream);
  expect(await cursor.next()).toEqual({ done: false, value: { ok: true, value: { choices: [] } } });
  expect(await cursor.next()).toEqual({ done: true, value: undefined });
});

it('retains the original post-header transport failure in the protocol stream', async () => {
  const cause = new HttpTransportError(new Error('read failed'));
  const body = new ReadableStream<Uint8Array>({ start: controller => { controller.error(cause); } });
  const { execution, background } = runWith(chatCompletions, chatCompletionsRequest, async () => eventStreamResponse(body));
  const answer = await execution.result;
  expect(answer.http).toMatchObject({ status: 200, body: null });
  if (answer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected an OpenAI Chat Completions stream');
  const cursor = execution.read(answer.openaiChatCompletions.stream);
  const failed = await cursor.next();
  expect(failed).toMatchObject({ done: false, value: { ok: false, error: { kind: 'transport' } } });
  if (failed.done || failed.value.ok) throw new Error('Expected a transport error');
  expect(failed.value.error.cause).toBe(cause);
  expect(await cursor.next()).toEqual({ done: true, value: undefined });
  await Promise.all(background);
});

it('completes after a protocol Err while its unread HTTP body drains in the background', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(new TextEncoder().encode('data: {broken}\n\n'));
    },
  });
  const { execution, background } = runWith(chatCompletions, chatCompletionsRequest, async () => eventStreamResponse(body));
  const answer = await execution.result;
  if (answer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected an OpenAI Chat Completions stream');
  const cursor = execution.read(answer.openaiChatCompletions.stream);
  expect(await cursor.next()).toMatchObject({ done: false, value: { ok: false, error: { kind: 'protocol' } } });
  expect(await cursor.next()).toEqual({ done: true, value: undefined });
  expect(background).toHaveLength(1);
  controller.close();
  await Promise.all(background);
});

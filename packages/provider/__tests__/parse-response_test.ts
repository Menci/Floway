import { expect, test, vi } from 'vitest';

import {
  httpTerminal,
  httpUrl,
  parseHttpOutcomeStage,
  parseResponsesStage,
  parseSseStage,
  readHttpBody,
  rewriteHttpRequestStage,
  toProviderModelFacts,
  type HttpResponseBodyChunk,
  type HttpOutcome,
  type ProviderBaseOutput,
  type ProviderOpenAIResponsesOutput,
  type ProviderResponsesInput,
  type ProviderServices,
} from '../src/index.ts';
import { UpstreamTransportError, type Fetcher } from '@floway-dev/http';
import { Bytes, compose, defineEnding, run, snapshotError } from '@floway-dev/pipeline';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { stubProviderModel } from '@floway-dev/test-utils';

type ResponsesSpace = ProviderResponsesInput & ProviderOpenAIResponsesOutput;

const composeResponses = compose<ResponsesSpace, ProviderServices>();
const buildResponsesPipeline = (
  name: string, parser: ReturnType<typeof parseResponsesStage>,
) => composeResponses(name, {
  entry: ['provider.upstream', 'provider.model', 'request.http', 'request.payload', 'request.action'],
  exit: ['response.http', 'response.modelKey', 'response.openaiResponses'],
  stages: [
    parser,
    rewriteHttpRequestStage<ProviderResponsesInput>('request', ['request.payload', 'provider.model', 'request.action'], facts => {
      const { upstreamModelId } = facts['provider.model'];
      return {
        request: {
          method: 'POST',
          url: httpUrl('https://upstream.test/responses'),
          body: { kind: 'json', value: { ...facts['request.payload'], model: upstreamModelId, stream: facts['request.action'] === 'generate' } },
        },
        modelKey: upstreamModelId,
      };
    }),
  ],
  ending: httpTerminal,
});

const pipeline = buildResponsesPipeline('test.responses', parseResponsesStage());
const streamPipeline = buildResponsesPipeline('test.sse', parseSseStage('parseSse', 'response.openaiResponses', parseOpenAIResponsesStream));

const input: ProviderResponsesInput = {
  'provider.upstream': { id: 'test-upstream', kind: 'custom', name: 'Test Upstream', config: {} },
  'provider.model': toProviderModelFacts(stubProviderModel({ upstreamModelId: 'actual-model' })),
  'request.http': {
    method: 'POST',
    url: httpUrl('https://gateway.test/v1/responses'),
    headers: [['x-request-id', 'request-1']],
    body: null,
  },
  'request.payload': { input: [] },
  'request.action': 'generate',
};

const options = (fetcher: Fetcher) => ({ services: { fetcher: () => fetcher }, finalizationTimeoutMs: 200 });

const invoke = (fetcher: Fetcher, action: ProviderResponsesInput['request.action'] = 'generate', target = pipeline) =>
  run(target, { ...input, 'request.action': action }, options(fetcher));

test.each([pipeline, streamPipeline])('parses a successful SSE response in $name', async target => {
  const handle = invoke(async (url, init) => {
    expect(url).toBe('https://upstream.test/responses');
    expect(new Headers(init.headers).get('x-request-id')).toBe('request-1');
    expect(init.body).toEqual(new TextEncoder().encode('{"input":[],"model":"actual-model","stream":true}'));
    return new Response('data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: [DONE]\n\n', {
      status: 202,
      headers: { 'content-type': 'Text/Event-Stream; charset=utf-8' },
    });
  }, 'generate', target);
  const facts = await handle.result;
  expect(facts['response.modelKey']).toBe('actual-model');
  expect(facts['response.http']).toMatchObject({ status: 202, body: null, headers: [['content-type', 'Text/Event-Stream; charset=utf-8']] });
  const outcome = facts['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('Expected parsed events');
  expect(await Array.fromAsync(outcome.events)).toEqual([
    { type: 'event', event: { type: 'response.output_text.delta', delta: 'hi', sequence_number: 0 } },
    { type: 'done' },
  ]);
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('releasing parsed events interrupts a blocked body read', async () => {
  const pulling = Promise.withResolvers<void>();
  const readerCancelled = vi.fn();
  const fetched = Promise.withResolvers<AbortSignal>();
  const handle = invoke(async (_url, init) => {
    if (!init.signal) throw new Error('Expected fetch signal');
    fetched.resolve(init.signal);
    return new Response(new ReadableStream<Uint8Array>({
      pull: () => { pulling.resolve(); },
      cancel: readerCancelled,
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const { 'response.openaiResponses': outcome } = await handle.result;
  if (outcome.kind !== 'stream') throw new Error('Expected parsed events');
  const read = outcome.events[Symbol.asyncIterator]().next();
  await pulling.promise;
  await outcome.events.close();
  await expect(read).resolves.toMatchObject({ done: true });
  expect(readerCancelled).toHaveBeenCalledOnce();
  expect((await fetched.promise).aborted).toBe(true);
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test.each([
  ['{"error":{"code":"throttled"}}', { error: { code: 'throttled' } }],
  ['rate limited', { error: { type: 'upstream_error', message: 'rate limited' } }],
  ['', { error: { type: 'upstream_error', message: 'Upstream returned HTTP 429' } }],
  ['null', null],
])('returns a 429 with %j as an upstream error value', async (body, error) => {
  const handle = invoke(async () => new Response(body, { status: 429 }));
  await expect(handle.result).resolves.toMatchObject({
    'response.http': { status: 429, body: null },
    'response.modelKey': 'actual-model',
    'response.openaiResponses': { kind: 'error', source: 'upstream', error },
  });
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test.each([
  [new Response('{"error":"azure stub"}', { headers: { 'content-type': 'application/json' } }), 'azure stub'],
  [new Response(null, { status: 204, headers: { 'content-type': 'text/event-stream' } }), '<empty>'],
  [new Response('x'.repeat(4096)), `${'x'.repeat(1024)}...[truncated]`],
])('returns an upstream error for a 2xx response without an SSE body', async (response, snippet) => {
  const handle = invoke(async () => response);
  await expect(handle.result).resolves.toMatchObject({
    'response.http': { status: 502, statusText: '', body: null },
    'response.openaiResponses': {
      kind: 'error', source: 'upstream', error: { error: { type: 'upstream_invalid_stream', message: expect.stringContaining(snippet) } },
    },
  });
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('returns compact JSON as a scalar result and clears the HTTP body', async () => {
  const result = { id: 'compact-1', object: 'response.compaction', output: [] };
  const handle = invoke(async () => Response.json(result), 'compact');
  await expect(handle.result).resolves.toMatchObject({
    'response.http': { status: 200, body: null },
    'response.openaiResponses': { kind: 'result', result },
  });
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('returns an upstream error for invalid compact JSON', async () => {
  const handle = invoke(async () => new Response('invalid JSON'), 'compact');
  await expect(handle.result).resolves.toMatchObject({
    'response.http': { status: 502, statusText: '', body: null },
    'response.openaiResponses': {
      kind: 'error', source: 'upstream', error: { error: { type: 'upstream_invalid_json', message: expect.stringContaining('invalid JSON') } },
    },
  });
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('retains the upstream transport snapshot alongside the error value', async () => {
  const handle = invoke(async () => { throw new UpstreamTransportError(new Error('connection reset')); });
  await expect(handle.result).resolves.toMatchObject({
    'response.http': { status: 502, transportError: { message: 'connection reset' }, body: null },
    'response.openaiResponses': {
      kind: 'error', source: 'upstream', error: { error: { type: 'upstream_transport_error', message: 'connection reset' } },
    },
  });
  await expect(handle.done).resolves.toEqual({ ok: true });
});

const failingBody = (prefix: string, error: unknown): ReadableStream<Uint8Array> => {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) controller.error(error);
      else {
        sent = true;
        controller.enqueue(new TextEncoder().encode(prefix));
      }
    },
  }, { highWaterMark: 0 });
};

test.each([
  { status: 429, action: 'generate', prefix: '{"error":{"code":"throttled"' },
  { status: 200, action: 'compact', prefix: '{"id":"compact-1","object":"response.compaction"' },
] as const)('discards partial JSON on an upstream body transport failure while parsing $status $action', async ({ status, action, prefix }) => {
  const failure = new TypeError('response connection reset');
  const handle = invoke(async () => new Response(failingBody(prefix, failure), { status }), action);
  await expect(handle.result).resolves.toMatchObject({
    'response.http': { status: 502, body: null, transportError: { message: 'response connection reset' } },
    'response.openaiResponses': {
      kind: 'error', source: 'upstream', error: { error: { type: 'upstream_transport_error', message: 'response connection reset' } },
    },
  });
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('marks the wrong-media-type snippet unreadable when its response body fails', async () => {
  const failure = new UpstreamTransportError(new Error('response connection reset'));
  const handle = invoke(async () => new Response(failingBody('<html>', failure), { headers: { 'content-type': 'text/html' } }));
  await expect(handle.result).resolves.toMatchObject({
    'response.http': { status: 502, body: null },
    'response.openaiResponses': {
      kind: 'error', source: 'upstream', error: { error: { type: 'upstream_invalid_stream', message: expect.stringContaining('<unreadable>') } },
    },
  });
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test.each([pipeline, streamPipeline])('yields one terminal transport failure after complete SSE events in $name', async target => {
  const prefix = 'data: {"type":"response.output_text.delta","delta":"complete"}\n\ndata: {"type":"response.output_text.delta","delta":"unframed"}';
  const failure = new TypeError('response connection reset');
  const body = failingBody(prefix, failure);
  const dispatched = Promise.withResolvers<AbortSignal>();
  const handle = invoke(async (_url, init) => {
    if (init.signal == null) throw new Error('Expected fetch signal');
    dispatched.resolve(init.signal);
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }, 'generate', target);
  const facts = await handle.result;
  const outcome = facts['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('Expected parsed events');
  expect(await Array.fromAsync(outcome.events)).toEqual([
    { type: 'event', event: { type: 'response.output_text.delta', delta: 'complete', sequence_number: 0 } },
    { type: 'transport-error', error: expect.objectContaining({ name: 'TypeError', message: 'response connection reset' }) },
  ]);
  expect((await dispatched.promise).reason).toBe(failure);
  expect(body.locked).toBe(false);
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('rejects a response body that emits another chunk after a transport failure', async () => {
  const broken = composeResponses('test.invalidBody', {
    entry: ['request.action'],
    exit: ['response.http', 'response.openaiResponses'],
    stages: [parseResponsesStage()],
    ending: defineEnding<{}, Pick<ProviderBaseOutput, 'response.http'>>({
      name: 'invalidBody',
      request: { needs: [] },
      return: { provides: ['response.http'] },
      async execute(_facts, scope) {
        return {
          'response.http': {
            status: 503,
            statusText: '',
            headers: [],
            body: scope.createStream<HttpResponseBodyChunk>({
              label: 'invalidBody',
              async *iterate() {
                yield { type: 'transport-error', error: snapshotError(new Error('expected body failure')) };
                yield Bytes.fromUtf8('unexpected data');
              },
            }),
            timing: { startedAt: 0, headersAt: 0 },
          },
        };
      },
    }),
  });
  const handle = run(broken, input, options(async () => { throw new Error('Unexpected fetch'); }));
  await expect(handle.result).rejects.toThrow('yielded a chunk after a transport failure');
  await expect(handle.done).resolves.toMatchObject({ ok: false });
});

type Extra = { readonly backend: string };
type HttpSpace = ProviderResponsesInput & Pick<ProviderBaseOutput, 'response.http'> & {
  readonly 'response.alphaSearch': HttpOutcome<Extra>;
};

const extra = vi.fn((facts: ProviderResponsesInput): Extra => ({ backend: facts['provider.upstream'].name }));
const httpPipeline = compose<HttpSpace, ProviderServices>()('test.httpOutcome', {
  entry: ['provider.upstream', 'request.http'],
  exit: ['response.http', 'response.alphaSearch'],
  stages: [parseHttpOutcomeStage('parseHttpOutcome', 'response.alphaSearch', {
    needs: ['provider.upstream'],
    extra,
    formatNonJsonError: (status, text) => ({ status, text }),
  })],
  ending: httpTerminal,
});

test('leaves a successful HTTP outcome body streaming and attaches success metadata', async () => {
  const pulled = vi.fn();
  const handle = run(httpPipeline, input, options(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled();
      controller.enqueue(new TextEncoder().encode('success'));
      controller.close();
    },
  }, { highWaterMark: 0 }), { status: 201 })));
  const facts = await handle.result;
  expect(facts['response.alphaSearch']).toEqual({ kind: 'ok', backend: 'Test Upstream' });
  expect(pulled).not.toHaveBeenCalled();
  const body = await readHttpBody(facts['response.http'].body);
  if (!body.ok) throw new Error('Expected response body bytes');
  expect(body.bytes.utf8()).toBe('success');
  expect(pulled).toHaveBeenCalledOnce();
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test.each([
  ['Unauthorized', { status: 401, text: 'Unauthorized' }],
  ['{"error":"Unauthorized"}', { error: 'Unauthorized' }],
])('returns %j as an HTTP error value without computing success metadata', async (body, error) => {
  extra.mockClear();
  const handle = run(httpPipeline, input, options(async () => new Response(body, { status: 401 })));
  await expect(handle.result).resolves.toMatchObject({
    'response.http': { status: 401, body: null },
    'response.alphaSearch': { kind: 'error', source: 'upstream', error },
  });
  expect(extra).not.toHaveBeenCalled();
  await expect(handle.done).resolves.toEqual({ ok: true });
});

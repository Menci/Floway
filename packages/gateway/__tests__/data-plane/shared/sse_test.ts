import { afterEach, expect, test, vi } from 'vitest';

import { createEncode, type DeliveryFacts, type DeliveryIntent } from '../../../src/data-plane/chat/shared/encode.ts';
import type { ChatFrameFacts } from '../../../src/data-plane/chat/shared/route-body.ts';
import type { HttpOutput } from '../../../src/data-plane/pipeline/edge-http.ts';
import type { AttemptResponse } from '../../../src/data-plane/pipeline/failover.ts';
import { emptyUsageFacts, usageResponseKeys } from '../../../src/data-plane/pipeline/observe-usage.ts';
import type { RenderFacts } from '../../../src/data-plane/pipeline/render.ts';
import { createGatewayServices, type GatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import { serializeSseFrame, type SseProtocol } from '../../../src/data-plane/shared/sse.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, compose, defineEnding, isManagedStream, link, run } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';

type Frame = ProtocolFrame<string>;
type ProviderAnswer = AttemptResponse & ChatFrameFacts<'openaiChatCompletions', string>;
type Encoded = HttpOutput & RenderFacts;
const intervalMs = 10;

const services = createGatewayServices({
  apiKey: {
    id: 'key-sse-test', userId: 1, name: 'SSE test', key: 'sk-sse-test', serverSecret: '00'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
    dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0,
  },
  runtimeLocation: 'test',
  scheduler: () => {},
});

const okHead: HttpResponseFacts = { status: 200, statusText: '', body: null, headers: [], timing: { startedAt: 0, headersAt: 0 } };
const normalProtocol: SseProtocol<Frame> = {
  encode: frame => frame.type === 'done'
    ? { wire: null, end: { type: 'completed' } }
    : { wire: serializeSseFrame(sseFrame(frame.event)) },
  eof: () => ({ type: 'completed' }),
  failure: error => [serializeSseFrame(sseFrame((error as Error).message, 'error'))],
};

const runEncode = (
  iterate?: (signal: AbortSignal) => AsyncIterable<Frame>,
  protocol = normalProtocol,
  http = okHead,
) => {
  const pipeline = compose<DeliveryFacts, Encoded, GatewayServices>('test SSE encoding', {
    stages: [createEncode<'openaiChatCompletions', DeliveryIntent, string>('openaiChatCompletions', {
      encodeJson: async () => ({ ok: true }), openSse: () => protocol,
      keepAlive: { intervalMs, frame: sseCommentFrame('keepalive') },
    })],
    ending: defineEnding<DeliveryFacts, ProviderAnswer>({
      name: 'stubProvider',
      request: { needs: [] },
      return: { provides: ['response.http', 'response.source', 'response.openaiChatCompletions', ...usageResponseKeys] },
      execute: async (_facts, _into, env) => ({
        'response.http': http,
        'response.source': 'upstream',
        'response.openaiChatCompletions': iterate === undefined ? undefined : env.createStream({ label: 'provider frames', iterate }),
        ...emptyUsageFacts(env),
      }),
    }),
  });
  link([pipeline]);
  return run(pipeline, { 'request.delivery': { stream: true } }, { services, finalizationTimeoutMs: 1_000 });
};

const encoded = async (handle: ReturnType<typeof runEncode>) => {
  const response = await handle.result;
  const body = response['response.http'].body;
  if (!isManagedStream(body)) throw new Error('Expected HTTP byte stream');
  return { body, render: response['response.render'].promise };
};

afterEach(() => { vi.useRealTimers(); });

test('emits comment keepalive frames around one idle upstream read', async () => {
  vi.useFakeTimers();
  const started = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const handle = runEncode(async function* () {
    started.resolve();
    await ready.promise;
    yield eventFrame('ready');
  });
  const { body, render } = await encoded(handle);
  const iterator = body[Symbol.asyncIterator]();
  const first = iterator.next();
  await started.promise;
  await vi.advanceTimersByTimeAsync(intervalMs);
  expect((await first).value?.utf8()).toBe(': keepalive\n\n');
  const second = iterator.next();
  await vi.advanceTimersByTimeAsync(intervalMs);
  expect((await second).value?.utf8()).toBe(': keepalive\n\n');
  ready.resolve();
  expect((await iterator.next()).value?.utf8()).toBe('data: ready\n\n');
  expect((await iterator.next()).done).toBe(true);
  expect(await render).toEqual({ kind: 'completed' });
  expect(await handle.done).toEqual({ ok: true });
});

test('releasing the body aborts a pending upstream read without emitting its racing error', async () => {
  const started = Promise.withResolvers<void>();
  const aborted = vi.fn();
  const failure = vi.fn(normalProtocol.failure);
  const handle = runEncode(async function* (signal) {
    await new Promise<void>(resolve => {
      signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true });
      started.resolve();
    });
    throw new Error('upstream read aborted');
  }, { ...normalProtocol, failure });
  const { body, render } = await encoded(handle);
  const next = body[Symbol.asyncIterator]().next();
  const settled = next.catch(() => undefined);
  await started.promise;
  await body.close();
  await settled;
  expect(await render).toEqual({ kind: 'cancelled' });
  expect(aborted).toHaveBeenCalledOnce();
  expect(failure).not.toHaveBeenCalled();
  await handle.done;
});

test('writes raw output without SSE framing', async () => {
  const handle = runEncode(async function* () { yield eventFrame('unframed'); }, {
    ...normalProtocol, encode: () => ({ wire: serializeSseFrame({ type: 'sse-raw', data: 'unframed' }) }),
  });
  const { body, render } = await encoded(handle);
  expect(Bytes.concat(await Array.fromAsync(body)).utf8()).toBe('unframed');
  expect(await render).toEqual({ kind: 'completed' });
  expect(await handle.done).toEqual({ ok: true });
});

test('serializes every line of a named SSE event as data', () => {
  expect(serializeSseFrame(sseFrame('one\r\ntwo\nthree', 'named'))).toBe('event: named\ndata: one\ndata: two\ndata: three\n\n');
});

test.each(['read', 'encode', 'eof'] as const)('renders and settles a %s failure after initial output', async failureAt => {
  const failure = new Error(`failed ${failureAt}`);
  const handle = runEncode(async function* () {
    yield eventFrame('initial');
    if (failureAt === 'read') throw failure;
    if (failureAt === 'encode') yield eventFrame('broken');
  }, {
    ...normalProtocol,
    encode: frame => {
      if (frame.type === 'event' && frame.event === 'broken') throw failure;
      return normalProtocol.encode(frame);
    },
    eof: () => {
      if (failureAt === 'eof') throw failure;
      return normalProtocol.eof();
    },
  });
  const { body, render } = await encoded(handle);
  expect(Bytes.concat(await Array.fromAsync(body)).utf8()).toBe(`data: initial\n\nevent: error\ndata: failed ${failureAt}\n\n`);
  expect(await render).toMatchObject({ kind: 'failed', reason: 'source-error', error: { message: failure.message } });
  await handle.done;
});

test('releases the iterator at a protocol terminal without reading past it', async () => {
  const extra = vi.fn();
  const released = vi.fn();
  const handle = runEncode(async function* () {
    try {
      yield eventFrame('last');
      extra();
    } finally { released(); }
  }, {
    ...normalProtocol, encode: () => ({ wire: 'last', end: { type: 'completed' } }),
  });
  const { body, render } = await encoded(handle);
  expect(Bytes.concat(await Array.fromAsync(body)).utf8()).toBe('last');
  expect(await render).toEqual({ kind: 'completed' });
  expect(await handle.done).toEqual({ ok: true });
  expect(extra).not.toHaveBeenCalled();
  expect(released).toHaveBeenCalledOnce();
});

test.each([204, 205, 304, 429])('scalar response preserves status and null vs empty bytes (%i)', async status => {
  const body = status === 429 ? Bytes.empty : null;
  const handle = runEncode(undefined, normalProtocol, {
    ...okHead, status, body,
    headers: [['retry-after', '12'], ['request-id', 'req-scalar'], ['set-cookie', 'private'], ['content-length', '0']],
  });
  expect((await handle.result)['response.http']).toMatchObject({
    status, body, headers: [['retry-after', '12'], ['request-id', 'req-scalar']],
  });
  expect(await handle.done).toEqual({ ok: true });
});

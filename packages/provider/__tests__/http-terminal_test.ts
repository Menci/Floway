import { assert, expect, it, vi } from 'vitest';

import { httpTerminal, type ProviderTransportFacts } from '../src/http-terminal.ts';
import type { GatewayFacts, ProviderServices, ProviderUpstream } from '../src/pipelines.ts';
import { isHttpBodyStream, type HttpRequestFact, type HttpStreamError } from '@floway-dev/http';
import { factSpace, move, run, Secret } from '@floway-dev/pipeline';

const { compose, defineStage } = factSpace<GatewayFacts & ProviderTransportFacts, ProviderServices>();
const pipeline = compose('http.test', {
  entry: ['request.http', 'provider.upstream'],
  exit: ['response.transport'],
  stages: [],
  ending: httpTerminal,
});

const upstream = move<ProviderUpstream>({ id: 'id', name: 'Test', kind: 'custom', config: {} });
const request = move<HttpRequestFact>({ method: 'POST', url: 'https://example.test/endpoint', headers: [], body: null });

it('sends the final URL, serialized body and field lines and reads the whole response', async () => {
  const send = vi.fn<ReturnType<ProviderServices['fetcher']>>(async () => ({
    ok: true,
    value: new Response('body', { status: 201, statusText: 'Created', headers: { 'x-upstream': 'yes' } }),
  }));
  const fetcher = vi.fn(() => send);
  const outgoing = move<HttpRequestFact>({
    ...request,
    headers: [['Authorization', Secret.from('Bearer x')], ['x-api-key', 'operator value'], ['X-Repeat', 'one'], ['x-repeat', 'two']],
    body: { value: 'héllo' },
  });
  const exchange = run(pipeline, { 'request.http': outgoing, 'provider.upstream': upstream }, { services: { fetcher } });
  const transport = (await exchange.result)['response.transport'];

  expect(fetcher).toHaveBeenCalledExactlyOnceWith(upstream.id);
  expect(send).toHaveBeenCalledExactlyOnceWith(request.url, {
    method: 'POST',
    body: '{"value":"héllo"}',
    headers: [['Authorization', 'Bearer x'], ['x-api-key', 'operator value'], ['X-Repeat', 'one'], ['x-repeat', 'two']],
    signal: expect.any(AbortSignal),
  });
  assert(transport.ok);
  expect(transport.value).toMatchObject({ status: 201, statusText: 'Created' });
  expect(transport.value.headers).toContainEqual(['x-upstream', 'yes']);
  const body = transport.value.body;
  assert(isHttpBodyStream(body));
  const cursor = body[Symbol.asyncIterator]();
  expect(await cursor.next()).toEqual({ done: false, value: { ok: true, value: new TextEncoder().encode('body') } });
  expect((await cursor.next()).done).toBe(true);
  await exchange.done;
});

it('returns a pre-headers failure through the transport result with its cause intact', async () => {
  const error: HttpStreamError = { kind: 'transport', cause: new Error('socket refused') };
  const exchange = run(pipeline, { 'request.http': request, 'provider.upstream': upstream }, {
    services: { fetcher: () => async () => ({ ok: false, error }) },
  });

  const result = (await exchange.result)['response.transport'];
  assert(!result.ok);
  expect(result.error).toBe(error);
  await exchange.done;
});

it('yields the read rejection once and then releases the response reader', async () => {
  const cause = new Error('read failed');
  const readable = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(cause); } });
  const exchange = run(pipeline, { 'request.http': request, 'provider.upstream': upstream }, {
    services: { fetcher: () => async () => ({ ok: true, value: new Response(readable) }) },
  });

  const result = (await exchange.result)['response.transport'];
  assert(result.ok && isHttpBodyStream(result.value.body));
  const cursor = result.value.body[Symbol.asyncIterator]();
  const failed = await cursor.next();
  assert(!failed.done && !failed.value.ok);
  expect(failed.value.error).toEqual({ kind: 'transport', cause });
  expect(failed.value.error.cause).toBe(cause);
  expect((await cursor.next()).done).toBe(true);
  expect(readable.locked).toBe(false);
  await exchange.done;
});

it('interrupts a pending read and yields abort separately from EOF and read failure', async () => {
  const pulled = Promise.withResolvers<void>();
  const cancel = vi.fn();
  const readable = new ReadableStream<Uint8Array>({ pull() { pulled.resolve(); }, cancel }, { highWaterMark: 0 });
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  const exchange = run(pipeline, { 'request.http': request, 'provider.upstream': upstream }, {
    signal: controller.signal,
    services: { fetcher: () => async () => ({ ok: true, value: new Response(readable) }) },
  });

  const result = (await exchange.result)['response.transport'];
  assert(result.ok && isHttpBodyStream(result.value.body));
  const cursor = result.value.body[Symbol.asyncIterator]();
  const reading = cursor.next();
  await pulled.promise;
  controller.abort(reason);

  expect(await reading).toEqual({ done: false, value: { ok: false, error: { kind: 'abort', cause: reason } } });
  expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
  expect((await cursor.next()).done).toBe(true);
  expect(readable.locked).toBe(false);
  await exchange.done;
});

it('drains a failed upload to native done before returning without dispatch', async () => {
  const error: HttpStreamError = { kind: 'abort', cause: new Error('upload interrupted') };
  const drained = vi.fn();
  const send = vi.fn<ReturnType<ProviderServices['fetcher']>>();
  const upload = defineStage({
    name: 'upload',
    through: {
      request: { needs: ['request.http'], provides: ['request.http'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const body = scope.createStream<Uint8Array, HttpStreamError>(async function* () {
        yield { ok: false, error };
        drained();
      });
      return await scope.next({ ...facts, 'request.http': move({ ...facts['request.http'], body }) });
    },
  });
  const streaming = compose('http.upload', {
    entry: ['request.http', 'provider.upstream'], exit: ['response.transport'], stages: [upload], ending: httpTerminal,
  });
  const exchange = run(streaming, { 'request.http': request, 'provider.upstream': upstream }, { services: { fetcher: () => send } });

  expect((await exchange.result)['response.transport']).toEqual({ ok: false, error });
  expect(drained).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
  await exchange.done;
});

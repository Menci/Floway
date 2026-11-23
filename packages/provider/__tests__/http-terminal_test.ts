import { expect, test, vi } from 'vitest';

import { encodeHttpRequest, type ProviderHttpRequest } from '../src/http-request.ts';
import { httpTerminal, httpUrl, readHttpBody, type ProviderServices } from '../src/index.ts';
import { encodeMultipartFormData, type MultipartField } from '../src/request-body.ts';
import type { Fetcher, HttpRequestFacts, HttpResponseFacts } from '@floway-dev/http';
import { Bytes, compose, isSecret, run, type RootEnv, type RunEvent } from '@floway-dev/pipeline';
import { jsonInteger } from '@floway-dev/protocols/common';

type Input = { readonly 'request.http': HttpRequestFacts };
type Output = { readonly 'response.http': HttpResponseFacts };

const terminal = compose<Input, Output, ProviderServices>('test.transport', {
  stages: [],
  ending: httpTerminal('test-upstream'),
});

const request = {
  method: 'POST',
  url: httpUrl('https://upstream.test/submit'),
  headers: [],
  body: null,
} satisfies HttpRequestFacts;

const invoke = (
  fetcher: Fetcher,
  http: HttpRequestFacts | ((env: RootEnv) => HttpRequestFacts) = request,
  options: { signal?: AbortSignal; events?: (event: RunEvent) => void; clock?: () => number } = {},
) => run(terminal, root => ({ 'request.http': typeof http === 'function' ? http(root) : http }), {
  services: {
    fetcher: upstreamId => {
      expect(upstreamId).toBe('test-upstream');
      return fetcher;
    },
  },
  finalizationTimeoutMs: 200,
  ...options,
});

test('preserves the status, status text, repeated headers, body bytes, and timing', async () => {
  let time = 10;
  const headers = new Headers([['x-trace-id', 'trace-1'], ['set-cookie', 'first=1'], ['set-cookie', 'second=2']]);
  const handle = invoke(async () => {
    time += 12;
    return new Response(new Uint8Array([0x00, 0xFE, 0x0A]), { status: 418, statusText: 'Brew', headers });
  }, request, { clock: () => time });
  const { 'response.http': response } = await handle.result;
  expect(response).toMatchObject({ status: 418, statusText: 'Brew', timing: { startedAt: 10, headersAt: 22 } });
  expect(response.headers).toContainEqual(['x-trace-id', 'trace-1']);
  const cookies = response.headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value);
  expect(cookies.every(isSecret)).toBe(true);
  expect(cookies.map(value => typeof value === 'string' ? value : value.reveal())).toEqual(['first=1', 'second=2']);
  expect((await readHttpBody(response.body)).toUint8Array()).toEqual(new Uint8Array([0x00, 0xFE, 0x0A]));
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('reveals sensitive headers and query entries on the wire and records the secret handles in leaf facts', async () => {
  const events: RunEvent[] = [];
  const input = {
    ...request,
    url: httpUrl('https://upstream.test/submit?token=web+token&tag=one&tag=two', ['token']),
    headers: [['authorization', 'Bearer header-token'], ['x-trace-id', 'trace-1']],
    body: Bytes.fromUtf8('bytes'),
  } satisfies ProviderHttpRequest;
  const wireRequest = encodeHttpRequest(input);
  const handle = invoke(async (url, init) => {
    expect(url).toBe('https://upstream.test/submit?token=web%20token&tag=one&tag=two');
    expect(init.headers).toEqual(input.headers);
    expect(init.body).toEqual(new TextEncoder().encode('bytes'));
    return new Response(null, { status: 204 });
  }, wireRequest, { events: event => events.push(event) });
  const { 'response.http': response } = await handle.result;
  expect(response.body).toBeNull();
  await expect(handle.done).resolves.toEqual({ ok: true });
  const leaf = events.find(event => event.k === 'enter');
  expect(leaf?.name).toBe('http');
  expect(leaf?.facts['request.http']).toBe(wireRequest);
  expect(isSecret(wireRequest.headers[0][1])).toBe(true);
  expect(isSecret(wireRequest.url.query?.[0][1])).toBe(true);
  expect(JSON.stringify(leaf)).not.toContain('header-token');
  expect(JSON.stringify(leaf)).not.toContain('web token');
});

test.each([false, true])('releasing a response cancels its reader and aborts fetch (pending pull: %s)', async pendingPull => {
  const pull = Promise.withResolvers<void>();
  const cancel = vi.fn();
  const fetchSignal = Promise.withResolvers<AbortSignal>();
  const webBody = new ReadableStream<Uint8Array>({
    pull: () => { pull.resolve(); },
    cancel,
  }, { highWaterMark: 0 });
  const handle = invoke(async (_url, init) => {
    if (!init.signal) throw new Error('Expected fetch signal');
    fetchSignal.resolve(init.signal);
    return new Response(webBody);
  });
  const { 'response.http': { body } } = await handle.result;
  if (body === null || body instanceof Bytes) throw new Error('Expected a managed body');
  const read = pendingPull ? body[Symbol.asyncIterator]().next() : undefined;
  if (read) await pull.promise;
  const signal = await fetchSignal.promise;
  expect(signal.aborted).toBe(false);
  await body.close();
  expect(cancel).toHaveBeenCalledOnce();
  expect(signal.aborted).toBe(true);
  expect(webBody.locked).toBe(false);
  if (read) await expect(read).resolves.toMatchObject({ done: true });
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('abort before headers propagates the original fetch failure', async () => {
  const owner = new AbortController();
  const error = new Error('client disconnected');
  const dispatched = Promise.withResolvers<AbortSignal>();
  const handle = invoke(async (_url, init) => {
    if (!init.signal) throw new Error('Expected fetch signal');
    const { signal } = init;
    return await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      dispatched.resolve(signal);
    });
  }, request, { signal: owner.signal });
  const signal = await dispatched.promise;
  owner.abort(error);
  expect(signal.reason).toBe(error);
  await expect(handle.result).rejects.toBe(error);
  await expect(handle.done).resolves.toMatchObject({ ok: false });
});

test('abort after headers reaches the physical reader and fetch with the domain reason', async () => {
  const owner = new AbortController();
  const error = new Error('client disconnected');
  const cancel = vi.fn();
  const fetchSignal = Promise.withResolvers<AbortSignal>();
  const handle = invoke(async (_url, init) => {
    if (!init.signal) throw new Error('Expected fetch signal');
    fetchSignal.resolve(init.signal);
    return new Response(new ReadableStream<Uint8Array>({ cancel }));
  }, request, { signal: owner.signal });
  await handle.result;
  owner.abort(error);
  await handle.done;
  expect(cancel).toHaveBeenCalledExactlyOnceWith(error);
  expect((await fetchSignal.promise).reason).toBe(error);
});

test('streams a managed upload into the fetcher in order', async () => {
  const observed = vi.fn();
  const handle = invoke(async (_url, init) => {
    if (!(init.body instanceof ReadableStream)) throw new Error('Expected a streamed upload');
    expect(observed).not.toHaveBeenCalled();
    expect(await new Response(init.body).text()).toBe('one\ntwo');
    return new Response(null, { status: 204 });
  }, root => ({
    ...request,
    body: root.createStream({
      label: 'upload',
      async *iterate() {
        yield Bytes.fromUtf8('one\n');
        observed();
        yield Bytes.fromUtf8('two');
      },
    }),
  }));
  await expect(handle.result).resolves.toMatchObject({ 'response.http': { status: 204, body: null } });
  expect(observed).toHaveBeenCalledOnce();
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('releases a managed upload if fetch rejects before pulling it', async () => {
  const failure = new Error('connection refused');
  const uploadEnded = vi.fn();
  const handle = invoke(async () => { throw failure; }, root => ({
    ...request,
    body: root.createStream({
      label: 'upload',
      iterate() { throw new Error('Unexpected upload read'); },
      onClose: uploadEnded,
    }),
  }));
  await expect(handle.result).rejects.toBe(failure);
  await expect(handle.done).resolves.toMatchObject({ ok: false });
  expect(uploadEnded).toHaveBeenCalledExactlyOnceWith({ how: 'released' });
});

test('writes raw JSON integer tokens and exact exponent formatting on the wire', async () => {
  const encoded = encodeHttpRequest({ ...request, body: { kind: 'json', value: { raw: jsonInteger(9007199254740993n), exponent: 1e21 } } });
  const handle = invoke(async (_url, init) => {
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.body).toEqual(new TextEncoder().encode('{"raw":9007199254740993,"exponent":1e+21}'));
    return new Response(null, { status: 204 });
  }, encoded);
  await expect(handle.result).resolves.toMatchObject({ 'response.http': { status: 204 } });
  await expect(handle.done).resolves.toEqual({ ok: true });
});

test('matches native multipart bytes and sends a content type with the encoded boundary', async () => {
  const file = new File([new Uint8Array([0, 0xFF, 0x0A])], 'file"\n.png');
  const form = new FormData();
  form.append('name\nline', 'a\rb\nc');
  form.append('image[]', file);
  form.append('image[]', file);
  form.append('model', 'provider-model');
  const native = new Request('https://upstream.test/submit', { method: 'POST', body: form });
  const nativeBoundary = native.headers.get('content-type')?.split('boundary=')[1];
  if (!nativeBoundary) throw new Error('Expected native multipart boundary');
  const uploaded = { kind: 'file', name: 'image[]', bytes: Bytes.adopt(new Uint8Array(await file.arrayBuffer())), filename: file.name, contentType: file.type } as const;
  const parts: MultipartField[] = [
    { kind: 'text', name: 'name\nline', value: 'a\rb\nc' },
    uploaded,
    uploaded,
    { kind: 'text', name: 'model', value: 'provider-model' },
  ];
  expect(encodeMultipartFormData(parts, nativeBoundary).toUint8Array()).toEqual(new Uint8Array(await native.arrayBuffer()));
  const encoded = encodeHttpRequest({ ...request, headers: [['Content-Type', 'stale']], body: { kind: 'multipart', parts } });
  const handle = invoke(async (_url, init) => {
    const contentType = new Headers(init.headers).get('content-type');
    const boundary = contentType?.split('boundary=')[1];
    if (!boundary) throw new Error('Expected encoded multipart boundary');
    expect(contentType).toBe(`multipart/form-data; boundary=${boundary}`);
    expect(init.body).toEqual(encodeMultipartFormData(parts, boundary).toUint8Array());
    return new Response(null, { status: 204 });
  }, encoded);
  await expect(handle.result).resolves.toMatchObject({ 'response.http': { status: 204 } });
  await expect(handle.done).resolves.toEqual({ ok: true });
});

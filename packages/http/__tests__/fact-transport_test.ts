import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { makeFakeDuplex } from './test-utils.ts';
import {
  appendHeader, deleteHeader, fetchOnStream, fetchWithTransportErrors, filterHeaders, getHeader, getHeaders, hasHeader, HttpTransportError,
  responseHeaderEntries, restoreRematerializedHttpAbort, sendHttpRequest, setHeader, type Fetcher, type HttpContentDecoders,
  type HttpHeaders, type HttpStreamError, type SerializedHttpRequest,
} from '../src/index.ts';
import { secret } from '@floway-dev/pipeline';

const request: SerializedHttpRequest = { url: 'https://test.invalid/resource', method: 'GET', headers: [], body: null };
const utf8 = new TextEncoder();
const text = new TextDecoder();

const readSource = async (result: ReturnType<typeof sendHttpRequest>) => {
  const answer = await result;
  if (!answer.ok || answer.value.body === null) throw new Error('Expected HTTP response headers and a body');
  return { ...answer.value, body: answer.value.body };
};

describe('HTTP header lines', () => {
  it('updates case-insensitively while preserving order, multiplicity, and the secret marker', () => {
    const marked = secret('token').map(value => `Bearer ${value}`);
    const untouched: HttpHeaders[number] = ['Accept', ''];
    const lines: HttpHeaders = [['X-Route', 'one'], untouched, ['x-route', marked]];
    const added = appendHeader(lines, 'X-ROUTE', 'three');
    expect(getHeader(added, 'x-route')).toBe('one');
    expect(getHeaders(added, 'X-Route')).toEqual(['one', marked, 'three']);
    expect(getHeaders(added, 'X-Route')[1]).toBe(marked);
    expect(hasHeader(added, 'accept')).toBe(true);
    expect(hasHeader(added, 'absent')).toBe(false);

    const replaced = setHeader(added, 'X-ROUTE', 'single');
    expect(replaced).toEqual([['X-Route', 'single'], untouched]);
    expect(replaced[1]).toBe(untouched);
    expect(deleteHeader(added, 'x-Route')).toEqual([untouched]);
    expect(filterHeaders(added, name => name === 'accept')[0]).toBe(untouched);
    expect(setHeader(lines, 'X-Added', 'new')).toEqual([...lines, ['X-Added', 'new']]);
    expect(lines).toHaveLength(3);
    expect(JSON.stringify(marked)).toBe('"[secret]"');
  });

  it('keeps native Set-Cookie lines separate without splitting values on commas', () => {
    const cookies = ['a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT', 'b=2'];
    const headers = new Headers(cookies.map(value => ['Set-Cookie', value]));
    expect(getHeaders(responseHeaderEntries(new Response(null, { headers })), 'set-cookie')).toEqual(cookies);
  });
});

describe('HTTP fact transport', () => {
  it('sends final bytes and credentials and retains ordered raw upstream fields and error status', async () => {
    const fake = makeFakeDuplex();
    const authorization = secret('token').map(token => `Bearer ${token}`);
    const bytes = utf8.encode('{"input":"x"}');
    const lines: HttpHeaders = [['Authorization', authorization], ['X-Route', 'one'], ['x-route', 'two']];
    for (const line of lines) Object.freeze(line);
    Object.freeze(lines);
    const fact = Object.freeze({ ...request, method: 'POST', headers: lines, body: bytes });
    const fetcher: Fetcher = (url, init) => {
      expect(init.body).toBe(bytes);
      return fetchOnStream(fake, {
        path: new URL(url).pathname,
        method: init.method!,
        headers: init.headers as [string, string][],
        body: bytes,
      });
    };
    const pending = sendHttpRequest(fetcher, fact, new AbortController().signal);
    await fake.firstWrite();
    fake.respond('HTTP/1.1 429 Rate Limited\r\nX-Quota: first\r\nSet-Cookie: a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT\r\nx-quota: second\r\nSet-Cookie: b=2\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nbusy\r\n0\r\n\r\n');
    const source = await readSource(pending);
    expect(source).toMatchObject({ status: 429, statusText: 'Rate Limited' });
    expect(source.headers).toEqual([
      ['X-Quota', 'first'],
      ['Set-Cookie', 'a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT'],
      ['x-quota', 'second'],
      ['Set-Cookie', 'b=2'],
    ]);
    expect(await source.body.next()).toEqual({ done: false, value: { ok: true, value: utf8.encode('busy') } });
    expect(await source.body.next()).toEqual({ done: true, value: undefined });
    expect(text.decode(fake.written())).toBe('POST /resource HTTP/1.1\r\nAuthorization: Bearer token\r\nX-Route: one\r\nx-route: two\r\nConnection: close\r\nContent-Length: 13\r\n\r\n{"input":"x"}');
    expect(fact.headers[0]?.[1]).toBe(authorization);
    expect(JSON.stringify(fact)).not.toContain('Bearer token');
  });

  it('does not send an already cancelled request', async () => {
    const send = vi.fn<Fetcher>();
    const reason = new Error('disconnected');
    const answer = await sendHttpRequest(send, request, AbortSignal.abort(reason));
    expect(answer).toEqual({ ok: false, error: { kind: 'abort', cause: reason } });
    expect(send).not.toHaveBeenCalled();
  });

  it('classifies a cancellation that rejects pending fetch and releases the binding', async () => {
    const caller = new AbortController();
    const removeAbort = vi.spyOn(caller.signal, 'removeEventListener');
    const called = Promise.withResolvers<AbortSignal>();
    const fetcher: Fetcher = (_, init) => new Promise((_resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener('abort', () => reject(new Error('interrupted fetch', { cause: signal.reason })), { once: true });
      called.resolve(signal);
    });
    const pending = sendHttpRequest(fetcher, request, caller.signal);
    const signal = await called.promise;
    caller.abort('client closed');
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'abort', cause: { cause: { cause: 'client closed' } } } });
    expect(signal.aborted).toBe(true);
    expect(removeAbort).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));
  });

  it('preserves a tagged transport rejection that settled ahead of abort', async () => {
    const caller = new AbortController();
    const pending = Promise.withResolvers<Response>();
    const result = sendHttpRequest(() => pending.promise, request, caller.signal);
    const original = new Error('socket reset');
    const network = new HttpTransportError(original);
    pending.reject(network);
    caller.abort(original);
    const answer = await result;
    expect(answer).toEqual({ ok: false, error: { kind: 'transport', cause: network } });
    expect(network.cause).toBe(original);
  });

  it('propagates a programmer rejection triggered after abort', async () => {
    const caller = new AbortController();
    const bug = new TypeError('unexpected return from fetch adapter');
    const called = Promise.withResolvers<void>();
    const result = sendHttpRequest((_, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(bug), { once: true });
      called.resolve();
    }), request, caller.signal);
    await called.promise;
    caller.abort();
    await expect(result).rejects.toBe(bug);
  });

  it('delivers an abort as the last item of a pending body read and releases its lock', async () => {
    const caller = new AbortController();
    const removeAbort = vi.spyOn(caller.signal, 'removeEventListener');
    const pulsed = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    let response: Response;
    const source = await readSource(sendHttpRequest(async (_, init) => {
      const signal = init.signal!;
      response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => {
            controller.error(signal.reason);
            failed.resolve();
          }, { once: true });
        },
        pull() { pulsed.resolve(); },
      }, { highWaterMark: 0 }));
      return response;
    }, request, caller.signal));
    const pending = source.body.next();
    await pulsed.promise;
    expect(response!.body?.locked).toBe(true);
    const reason = new Error('client closed');
    caller.abort(reason);
    await failed.promise;
    expect(await pending).toMatchObject({ done: false, value: { ok: false, error: { kind: 'abort', cause: { cause: reason } } } });
    expect(response!.body?.locked).toBe(false);
    expect(removeAbort).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));
    expect(await source.body.next()).toEqual({ done: true, value: undefined });
  });

  it('propagates a body programmer rejection triggered after abort', async () => {
    const caller = new AbortController();
    const pulsed = Promise.withResolvers<void>();
    const failing = Promise.withResolvers<void>();
    const network = new TypeError('native read failure');
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulsed.resolve();
        await failing.promise;
        controller.error(network);
      },
    }, { highWaterMark: 0 });
    const response = new Response(stream);
    const source = await readSource(sendHttpRequest(async () => response, request, caller.signal));
    const pending = source.body.next();
    await pulsed.promise;
    caller.abort(network);
    failing.resolve();
    await expect(pending).rejects.toBe(network);
    expect(response.body?.locked).toBe(false);
  });

  it.each(['fetch', 'body', 'unrelated'] as const)('uses the exact abort marker for a native %s rejection', async phase => {
    const caller = new AbortController();
    const invoked = Promise.withResolvers<AbortSignal>();
    const reading = Promise.withResolvers<void>();
    let restoredFrom: Error;
    const native = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const { signal } = init!;
      const rematerialize = () => {
        const { message } = signal!.reason as Error;
        restoredFrom = new Error(phase === 'unrelated' ? `${message} with another cause` : message);
        return restoredFrom;
      };
      if (phase === 'fetch') {
        return new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(rematerialize()), { once: true });
          invoked.resolve(signal!);
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) { signal!.addEventListener('abort', () => controller.error(rematerialize()), { once: true }); },
        pull() { reading.resolve(); },
      }, { highWaterMark: 0 });
      invoked.resolve(signal!);
      return Promise.resolve(new Response(body));
    });
    try {
      const fetcher: Fetcher = (url, init) => fetchWithTransportErrors(url, { signal: init.signal! }, {
        isFetchTransportFailure: () => false,
        restoreAbort: restoreRematerializedHttpAbort,
      });
      const pending = sendHttpRequest(fetcher, request, caller.signal);
      const bound = await invoked.promise;
      const original = new Error('client disconnected');
      if (phase === 'fetch') {
        caller.abort(original);
        const answer = await pending;
        expect(answer).toMatchObject({ ok: false, error: { kind: 'abort' } });
        expect(!answer.ok && answer.error.cause).toBe(bound.reason);
      } else {
        const source = await readSource(pending);
        const read = source.body.next();
        await reading.promise;
        caller.abort(original);
        if (phase === 'unrelated') {
          await expect(read).rejects.toBe(restoredFrom!);
        } else {
          const item = await read;
          expect(item).toMatchObject({ done: false, value: { ok: false, error: { kind: 'abort' } } });
          expect(!item.done && !item.value.ok && item.value.error.cause).toBe(bound.reason);
          expect(await source.body.next()).toEqual({ done: true, value: undefined });
        }
      }
      expect(restoredFrom!).not.toBe(bound.reason);
      expect((bound.reason as Error).cause).toBe(original);
      expect(restoreRematerializedHttpAbort(restoredFrom!, AbortSignal.abort(new Error(restoredFrom!.message)))).toBeUndefined();
    } finally {
      native.mockRestore();
    }
  });

  it('preserves a rejected native body after its peer closes and the caller subsequently aborts', async () => {
    const peer = Promise.withResolvers<Socket>();
    const server = createServer((incoming, outgoing) => {
      peer.resolve(incoming.socket);
      outgoing.writeHead(200, { 'Content-Length': '20' });
      outgoing.write('first');
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address');
      const caller = new AbortController();
      const bodyClassified = vi.fn((cause: unknown): HttpStreamError | undefined => {
        if (cause instanceof TypeError && cause.cause instanceof Error && (cause.cause as NodeJS.ErrnoException).code === 'UND_ERR_SOCKET') {
          return { kind: 'transport', cause };
        }
      });
      const fetcher: Fetcher = (url, init) => fetchWithTransportErrors(url, { signal: init.signal! }, {
        isFetchTransportFailure: () => false,
        classifyBodyFailure: bodyClassified,
      });
      let nativeBody: ReadableStream<Uint8Array>;
      const source = await readSource(sendHttpRequest(async (url, init) => {
        const response = await fetcher(url, init);
        if (response.body === null) throw new Error('Expected a native response body');
        nativeBody = response.body;
        return response;
      }, { ...request, url: `http://127.0.0.1:${address.port}/` }, caller.signal));
      const openReader = vi.spyOn(nativeBody!, 'getReader');
      expect((await source.body.next()).value).toEqual({ ok: true, value: utf8.encode('first') });
      const reader = openReader.mock.results[0]?.value as ReadableStreamDefaultReader<Uint8Array>;
      const nativeFailure = reader.closed.catch((cause: unknown) => cause);
      (await peer.promise).destroy();
      const failure = await nativeFailure;
      expect(failure).toMatchObject({ name: 'TypeError', message: 'terminated', cause: { code: 'UND_ERR_SOCKET' } });
      caller.abort(new Error('client closed after the socket failed'));
      expect(await source.body.next()).toEqual({ done: false, value: { ok: false, error: { kind: 'transport', cause: failure } } });
      expect(bodyClassified).toHaveBeenCalledExactlyOnceWith(failure);
      expect(await source.body.next()).toEqual({ done: true, value: undefined });
      expect(nativeBody!.locked).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each([false, true])('cancels the source on early return with started=%j', async started => {
    const caller = new AbortController();
    const removeAbort = vi.spyOn(caller.signal, 'removeEventListener');
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(utf8.encode('data')); },
      cancel,
    }));
    const source = await readSource(sendHttpRequest(async () => response, request, caller.signal));
    if (started) expect((await source.body.next()).done).toBe(false);
    expect(await source.body.return()).toEqual({ value: undefined, done: true });
    expect(await source.body.return()).toEqual({ value: undefined, done: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
    expect(removeAbort).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));
  });

  it('classifies malformed remote headers while leaving invalid request construction as a panic', async () => {
    const fake = makeFakeDuplex();
    fake.respond('not HTTP\r\n\r\n');
    const caller = new AbortController();
    const fetcher: Fetcher = (_, init) => fetchOnStream(fake, { method: init.method!, path: '/', headers: [] });
    await expect(sendHttpRequest(fetcher, request, caller.signal)).resolves.toMatchObject({
      ok: false, error: { kind: 'transport', cause: { name: 'HttpProtocolError', code: 'BAD_STATUS_LINE' } },
    });
    await expect(sendHttpRequest(fetcher, { ...request, method: 'BAD METHOD' }, caller.signal)).rejects.toMatchObject({
      name: 'HttpProtocolError', code: 'BAD_HEADERS',
    });
  });

  it.each([
    ['Content-Length: 6', 'short', 'EOF'],
    ['Content-Encoding: unsupported', '', 'UNSUPPORTED_CONTENT_ENCODING'],
    ['Content-Encoding: gzip', 'invalid gzip', undefined],
  ])('delivers a body failure after a usable error response head with %s', async (field, body, code) => {
    const fake = makeFakeDuplex();
    const fetcher: Fetcher = () => fetchOnStream(fake, { method: 'GET', path: '/', headers: [] });
    const pending = sendHttpRequest(fetcher, request, new AbortController().signal);
    await fake.firstWrite();
    fake.respond(`HTTP/1.1 502 Bad Gateway\r\nRetry-After: 60\r\n${field}\r\n\r\n${body}`);
    fake.endResponse();
    const source = await readSource(pending);
    expect(source.status).toBe(502);
    expect(getHeader(source.headers, 'retry-after')).toBe('60');
    if (code === 'EOF') expect((await source.body.next()).value).toEqual({ ok: true, value: utf8.encode('short') });
    expect(await source.body.next()).toMatchObject({
      done: false,
      value: { ok: false, error: { kind: 'transport', cause: code === undefined ? { cause: expect.any(TypeError) } : { code } } },
    });
    expect(await source.body.next()).toEqual({ done: true, value: undefined });
  });

  it('leaves a source TypeError as a panic through a native codec', async () => {
    const bug = new TypeError('upstream adapter failed internally');
    const reached = Promise.withResolvers<void>();
    const fail = Promise.withResolvers<void>();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(utf8.encode('HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n')); },
      async pull(controller) {
        reached.resolve();
        await fail.promise;
        controller.error(bug);
      },
    }, { highWaterMark: 0 });
    const fetcher: Fetcher = () => fetchOnStream({ readable, writable: new WritableStream() }, { method: 'GET', path: '/', headers: [] });
    const source = await readSource(sendHttpRequest(fetcher, request, new AbortController().signal));
    const read = source.body.next();
    await reached.promise;
    fail.resolve();
    await expect(read).rejects.toBe(bug);
  });

  it.each(['programmer', 'transport'] as const)('preserves a %s error wrapped by a decoder with its own data-error shape', async kind => {
    const bug = new TypeError('source adapter failed');
    const failure = kind === 'transport' ? new HttpTransportError(bug) : bug;
    const reached = Promise.withResolvers<void>();
    const fail = Promise.withResolvers<void>();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(utf8.encode('HTTP/1.1 200 OK\r\nContent-Encoding: test\r\n\r\n')); },
      async pull(controller) {
        reached.resolve();
        await fail.promise;
        controller.error(failure);
      },
    }, { highWaterMark: 0 });
    let decoded: ReadableStreamDefaultController<Uint8Array>;
    const recognized = vi.fn((cause: unknown) => cause instanceof TypeError);
    const decoders: HttpContentDecoders = new Map([['test', () => ({
      readable: new ReadableStream<Uint8Array>({ start(controller) { decoded = controller; } }, { highWaterMark: 0 }),
      writable: new WritableStream<Uint8Array>({ abort(cause) { decoded.error(new TypeError('decoder failed', { cause })); } }),
      isDataError: recognized,
    })]]);
    const fetcher: Fetcher = () => fetchOnStream({ readable, writable: new WritableStream() }, { method: 'GET', path: '/', headers: [] }, undefined, decoders);
    const source = await readSource(sendHttpRequest(fetcher, request, new AbortController().signal));
    const read = source.body.next();
    await reached.promise;
    fail.resolve();
    if (kind === 'programmer') await expect(read).rejects.toBe(failure);
    else {
      expect(await read).toEqual({ done: false, value: { ok: false, error: { kind: 'transport', cause: failure } } });
      expect(await source.body.next()).toEqual({ done: true, value: undefined });
    }
    expect(recognized).not.toHaveBeenCalled();
  });
});

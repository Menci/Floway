import { describe, expect, it, vi } from 'vitest';

import { respondAndEnd } from './test-utils.ts';
import { HttpProtocolError, parseHttpResponse, sendHttpRequest as send, toWebResponse, UpstreamTransportError, type Fetcher, type FetchInit, type HttpRequestFact } from '../src/index.ts';
import { Secret } from '@floway-dev/pipeline';

const request: HttpRequestFact = {
  url: 'https://upstream.example/v1/messages',
  method: 'POST',
  headers: [['authorization', Secret.from('token').map(value => `Bearer ${value}`)], ['x-option', 'a'], ['X-Option', 'b']],
  body: new Uint8Array([5, 6]),
};

const sendHttpRequest = (fetcher: Fetcher, input: HttpRequestFact, signal: AbortSignal) =>
  send(async (url, init) => ({ response: await fetcher(url, init) }), input, signal);

describe('sendHttpRequest', () => {
  it('sends the final fact values and returns a byte stream with native completion', async () => {
    const fetcher = vi.fn((_url: string, _init: FetchInit) => Promise.resolve(new Response(new Uint8Array([7, 8]), {
      status: 201,
      statusText: 'Created',
      headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']],
    })));
    const result = await sendHttpRequest(fetcher, request, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(request.url, {
      method: 'POST',
      headers: [['authorization', 'Bearer token'], ['x-option', 'a'], ['X-Option', 'b']],
      body: request.body,
      signal: expect.any(AbortSignal),
    });
    expect(result).toMatchObject({ ok: true, value: { status: 201, statusText: 'Created', headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']] } });
    if (!result.ok || result.value.body === null) throw new Error('Expected HTTP bytes');
    await expect(result.value.body.next()).resolves.toEqual({ done: false, value: { ok: true, value: new Uint8Array([7, 8]) } });
    await expect(result.value.body.next()).resolves.toMatchObject({ done: true });
  });

  it('refuses a pre-aborted fetch before invoking it', async () => {
    const fetcher = vi.fn();
    const cause = new Error('caller cancelled');
    expect(await sendHttpRequest(fetcher, request, AbortSignal.abort(cause))).toEqual({ ok: false, error: { kind: 'abort', cause } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the confirmed reason to classify an in-flight pre-header cancellation', async () => {
    const controller = new AbortController();
    const parentReason = new Error('caller cancelled');
    let confirmedReason: unknown;
    const answer = sendHttpRequest((_url, { signal }) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => {
        confirmedReason = signal!.reason;
        reject(new Error('fetch cancelled', { cause: confirmedReason }));
      });
    }), request, controller.signal);
    controller.abort(parentReason);
    expect(confirmedReason).toMatchObject({ cause: parentReason });
    expect(await answer).toMatchObject({ ok: false, error: { kind: 'abort', cause: { cause: confirmedReason } } });
  });

  it('keeps an independent pre-header rejection when the caller aborts in the same turn', async () => {
    const controller = new AbortController();
    const transport = new UpstreamTransportError(new Error('connection reset'));
    const pending = Promise.withResolvers<Response>();
    const answer = sendHttpRequest(() => pending.promise, request, controller.signal);
    pending.reject(transport);
    controller.abort();
    expect(await answer).toEqual({ ok: false, error: { kind: 'transport', cause: transport } });
  });

  it('allows a bug thrown during fetch invocation to propagate', async () => {
    const controller = new AbortController();
    const bug = new TypeError('fetcher bug');
    await expect(sendHttpRequest(() => {
      controller.abort();
      throw bug;
    }, request, controller.signal)).rejects.toBe(bug);
  });

  it('propagates an unmarked asynchronous fetcher error even after cancellation', async () => {
    const controller = new AbortController();
    const bug = new TypeError('fetcher bug');
    const pending = Promise.withResolvers<Response>();
    const answer = sendHttpRequest(() => pending.promise, request, controller.signal);
    controller.abort();
    pending.reject(bug);
    await expect(answer).rejects.toBe(bug);
  });

  it.each(['abort', 'transport'] as const)('emits %s as the final item on the byte stream', async kind => {
    const controller = new AbortController();
    const transport = new UpstreamTransportError(new Error('connection reset'));
    const pulling = Promise.withResolvers<void>();
    let failTransport!: () => void;
    let ownedReason: unknown;
    const result = await sendHttpRequest((_url, { signal }) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(body) {
        failTransport = () => body.error(transport);
        signal!.addEventListener('abort', () => {
          ownedReason = signal!.reason;
          body.error(ownedReason);
        });
      },
      pull() { pulling.resolve(); },
    }, { highWaterMark: 0 }))), request, controller.signal);
    if (!result.ok || result.value.body === null) throw new Error('Expected HTTP bytes');
    const pending = result.value.body.next();
    await pulling.promise;
    if (kind === 'transport') failTransport();
    controller.abort();
    await expect(pending).resolves.toEqual({ done: false, value: { ok: false, error: { kind, cause: kind === 'abort' ? ownedReason : transport } } });
    await expect(result.value.body.next()).resolves.toMatchObject({ done: true });
  });

  it('emits an unsupported coding as a body protocol error after the response head', async () => {
    const raw = await parseHttpResponse(respondAndEnd('HTTP/1.1 429 Too Many Requests\r\nContent-Encoding: unknown\r\nX-Reply: upstream\r\nContent-Length: 0\r\n\r\n'));
    const result = await sendHttpRequest(() => Promise.resolve(toWebResponse(raw)), request, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { status: 429, headers: [['Content-Encoding', 'unknown'], ['X-Reply', 'upstream'], ['Content-Length', '0']] } });
    if (!result.ok || result.value.body === null) throw new Error('Expected HTTP bytes');
    await expect(result.value.body.next()).resolves.toMatchObject({ done: false, value: { ok: false, error: { kind: 'protocol', cause: { code: 'UNSUPPORTED_CONTENT_ENCODING' } } } });
    await expect(result.value.body.next()).resolves.toMatchObject({ done: true });
  });

  it('propagates an unclassified body reader rejection unchanged after abort', async () => {
    const controller = new AbortController();
    const pulling = Promise.withResolvers<void>();
    const failure = new TypeError('decoder failed');
    let fail!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(source) { fail = () => source.error(failure); },
      pull() { pulling.resolve(); },
    }, { highWaterMark: 0 });
    const result = await sendHttpRequest(() => Promise.resolve(new Response(body)), request, controller.signal);
    if (!result.ok || result.value.body === null) throw new Error('Expected HTTP bytes');
    const pending = result.value.body.next();
    await pulling.promise;
    controller.abort();
    fail();
    await expect(pending).rejects.toBe(failure);
  });

  it('propagates an HTTP-shaped codec construction error as a panic', async () => {
    const raw = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Encoding: test\r\nContent-Length: 0\r\n\r\n'));
    const failure = new HttpProtocolError('codec defect', 'UNSUPPORTED_CONTENT_ENCODING');
    const result = await sendHttpRequest(() => Promise.resolve(toWebResponse(raw, new Map([['test', () => { throw failure; }]]))), request, new AbortController().signal);
    if (!result.ok || result.value.body === null) throw new Error('Expected HTTP bytes');
    await expect(result.value.body.next()).rejects.toBe(failure);
  });

  it.each([false, true])('cancels the body and unbinds abort on iterator return after starting=%s', async started => {
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(body) { body.enqueue(new Uint8Array([5])); },
      cancel,
    });
    const result = await sendHttpRequest(() => Promise.resolve(new Response(source)), request, controller.signal);
    if (!result.ok || result.value.body === null) throw new Error('Expected HTTP bytes');
    const body = result.value.body;
    if (started) await expect(body.next()).resolves.toMatchObject({ done: false });
    await expect(body.return(undefined)).resolves.toMatchObject({ done: true });
    await expect(body.return(undefined)).resolves.toMatchObject({ done: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(removeAbort).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));
    expect(source.locked).toBe(false);
  });
});

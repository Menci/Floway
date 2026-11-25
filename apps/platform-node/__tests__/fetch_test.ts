import http from 'node:http';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { nodeFetch, nodeProviderFetch } from '../src/fetch.ts';
import { sendHttpRequest, UpstreamTransportError, type ProviderFetcher } from '@floway-dev/http';

let server: http.Server;
let url: string;

beforeEach(async () => {
  server = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/target' });
        response.end();
      } else {
        response.end('ok');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected an HTTP loopback address');
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

it('opens a replayable body with fixed framing and Node duplex', async () => {
  let observed: RequestInit | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    observed = init;
    return new Response('ok');
  }));

  await nodeFetch('https://example.com', {
    method: 'POST',
    body: { contentLength: 7, open: () => new Blob(['payload']).stream() },
  });

  expect(observed?.headers instanceof Headers && observed.headers.get('content-length')).toBe('7');
  expect((observed as RequestInit & { duplex?: string }).duplex).toBe('half');
  expect(await new Response(observed?.body).text()).toBe('payload');
});

it('preserves the native response and its clone after a redirect', async () => {
  const response = await nodeFetch(`${url}/redirect`, {});
  const copy = response.clone();
  for (const value of [response, copy]) {
    expect(value.url).toBe(`${url}/target`);
    expect(value.redirected).toBe(true);
    expect(value.type).toBe('basic');
    expect(() => value.headers.set('x-test', 'value')).toThrow(TypeError);
    expect(await value.text()).toBe('ok');
  }
});

it('preserves the native Fetch policy rejection of a forbidden port', async () => {
  const error = await nodeFetch('http://127.0.0.1:6667/', {}).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(TypeError);
  expect(error).not.toBeInstanceOf(UpstreamTransportError);
  expect(error).toMatchObject({ cause: { message: 'bad port' } });
});

it('preserves native Fetch redirect-policy and replayable-length rejections', async () => {
  const redirect = await nodeFetch(`${url}/redirect`, { redirect: 'error' }).catch((error: unknown) => error);
  expect(redirect).toBeInstanceOf(TypeError);
  expect(redirect).not.toBeInstanceOf(UpstreamTransportError);
  const mismatch = await nodeFetch(url, {
    method: 'POST',
    body: { contentLength: 2, open: () => new Blob(['a']).stream() },
  }).catch((error: unknown) => error);
  expect(mismatch).toBeInstanceOf(TypeError);
  expect(mismatch).not.toBeInstanceOf(UpstreamTransportError);
  expect(mismatch).toMatchObject({ cause: { code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' } });
});

it('marks a refused native network connection before headers', async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await expect(nodeFetch(url, {})).rejects.toMatchObject({
    name: 'UpstreamTransportError', cause: { cause: { code: 'ECONNREFUSED' } },
  });
});

it.each([
  Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', errno: -3008 }),
  Object.assign(new Error('resolver unavailable'), { code: 'EAI_AGAIN', syscall: 'getaddrinfo', errno: -3001 }),
  Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT', syscall: 'connect', errno: -60 }),
  Object.assign(new Error('connection timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT', [Symbol.for('undici.error.UND_ERR_CONNECT_TIMEOUT')]: true }),
])('marks an identified native connection failure for $code', async cause => {
  const failure = new TypeError('fetch failed', { cause });
  vi.stubGlobal('fetch', vi.fn(async () => { throw failure; }));
  await expect(nodeFetch(url, {})).rejects.toMatchObject({ name: 'UpstreamTransportError', cause: failure });
});

it.each([true, false])('classifies a native dual-stack failure only when both causes are transport=%s', async network => {
  const refusal = (address: string) => Object.assign(new Error(`connect refused on ${address}`), {
    code: 'ECONNREFUSED', syscall: 'connect', errno: -61, address,
  });
  const cause = new AggregateError([refusal('::1'), network ? refusal('127.0.0.1') : new TypeError('unexpected adapter rejection')]);
  const failure = new TypeError('fetch failed', { cause });
  vi.stubGlobal('fetch', vi.fn(async () => { throw failure; }));
  const sent = nodeFetch(url, {});
  if (network) await expect(sent).rejects.toMatchObject({ name: 'UpstreamTransportError', cause: failure });
  else await expect(sent).rejects.toBe(failure);
});

it('propagates the original request body pull error out of native Fetch', async () => {
  const failure = new TypeError('invalid upload data');
  const body = new ReadableStream<Uint8Array>({ pull() { throw failure; } });
  await expect(nodeFetch(url, { method: 'POST', body })).rejects.toBe(failure);
});

const sendBody = async (fetcher: ProviderFetcher = nodeProviderFetch) => {
  const result = await sendHttpRequest(fetcher, { url, method: 'GET', headers: [], body: null }, new AbortController().signal);
  if (!result.ok || result.value.body === null) throw new Error('Expected HTTP response bytes');
  return result.value.body;
};

it.each(['fixed-length EOF', 'chunked reset'])('classifies a premature native body interruption as transport for %s', async mode => {
  const interrupt = Promise.withResolvers<void>();
  server.removeAllListeners('request');
  server.on('request', (_request, response) => {
    const socket = response.socket!;
    response.writeHead(200, mode === 'fixed-length EOF' ? { 'content-length': '20' } : { 'transfer-encoding': 'chunked' });
    response.write('first bytes');
    void interrupt.promise.then(() => {
      if (mode === 'fixed-length EOF') response.destroy();
      else socket.resetAndDestroy();
    });
  });

  const body = await sendBody();
  expect(await body.next()).toEqual({ done: false, value: { ok: true, value: new TextEncoder().encode('first bytes') } });
  const pending = body.next();
  interrupt.resolve();
  await expect(pending).resolves.toMatchObject({ done: false, value: { ok: false, error: { kind: 'transport', cause: expect.any(UpstreamTransportError) } } });
  await expect(body.next()).resolves.toMatchObject({ done: true });
});

it('treats a close-delimited native response as completed at EOF', async () => {
  server.removeAllListeners('request');
  server.on('request', (_request, response) => {
    response.useChunkedEncodingByDefault = false;
    response.writeHead(200, { connection: 'close' });
    response.end('first bytes');
  });
  const body = await sendBody();
  expect(await Array.fromAsync(body)).toEqual([{ ok: true, value: new TextEncoder().encode('first bytes') }]);
});

it('keeps a local upload read failure as a panic after native Fetch has returned headers', async () => {
  const release = Promise.withResolvers<void>();
  const failure = Object.assign(new TypeError('local upload read failed'), { code: 'ECONNRESET', syscall: 'read', errno: -54 });
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    request.once('data', () => {
      response.writeHead(200);
      response.write('first bytes');
    });
  });
  let first = true;
  const upload = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(new Uint8Array([5]));
      } else {
        await release.promise;
        throw failure;
      }
    },
  }, { highWaterMark: 0 });

  const body = await sendBody((url, init) => nodeProviderFetch(url, { ...init, method: 'POST', body: upload }));
  expect(await body.next()).toEqual({ done: false, value: { ok: true, value: new TextEncoder().encode('first bytes') } });
  const pending = body.next();
  release.resolve();
  await expect(pending).rejects.toMatchObject({ name: 'TypeError', message: 'terminated', cause: failure });
});

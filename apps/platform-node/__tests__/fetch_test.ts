import { once } from 'node:events';
import http from 'node:http';
import type net from 'node:net';
import { deflateSync } from 'node:zlib';

import { afterEach, expect, test, vi } from 'vitest';

import { nodeFetch } from '../src/fetch.ts';
import { HttpTransportError, sendHttpRequest } from '@floway-dev/http';

afterEach(() => vi.unstubAllGlobals());

test('opens a replayable body with fixed framing and Node duplex', async () => {
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

const withHttpPeer = async (handler: http.RequestListener, run: (url: string) => Promise<void>): Promise<void> => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a loopback HTTP address');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
};

const send = (url: string) => sendHttpRequest(nodeFetch, { url, method: 'GET', headers: [], body: null }, new AbortController().signal);

test('preserves the native Response and redirect metadata', async () => {
  await withHttpPeer((req, res) => {
    if (req.url === '/') res.writeHead(307, { location: '/final' }).end();
    else res.end('final');
  }, async url => {
    const response = await nodeFetch(url, {});
    expect(response).toBeInstanceOf(Response);
    expect(response.url).toBe(`${url}/final`);
    expect(response.redirected).toBe(true);
    expect(await response.clone().text()).toBe('final');
    expect(await response.text()).toBe('final');
  });
});

test('tags a native pre-header failure with its underlying cause', async () => {
  await withHttpPeer((_req, res) => { res.destroy(); }, async url => {
    const failure = await nodeFetch(url, {}).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(HttpTransportError);
    expect((failure as HttpTransportError).cause).toMatchObject({ cause: { code: 'UND_ERR_SOCKET' } });
  });
});

test('reports a malformed native HTTP status line as a pre-header transport failure', async () => {
  await withHttpPeer(req => { req.socket.end('NOT HTTP\r\n\r\n'); }, async url => {
    await expect(send(url)).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'transport',
        cause: { name: 'HttpTransportError', cause: { cause: { name: 'HTTPParserError', code: 'HPE_INVALID_CONSTANT' } } },
      },
    });
  });
});

test.each([
  ['chunk length', 'G\r\n', 'HPE_INVALID_CHUNK_SIZE'],
  ['trailer field', '0\r\nBad\\Trailer: value\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
])('reports a malformed native HTTP %s after delivering valid response bytes', async (_label, damage, code) => {
  const peer = Promise.withResolvers<net.Socket>();
  await withHttpPeer((req, res) => {
    res.writeHead(200, { 'transfer-encoding': 'chunked' });
    res.write('x');
    peer.resolve(req.socket);
  }, async url => {
    const result = await send(url);
    if (!result.ok || result.value.body === null) throw new Error('expected a streaming response');
    expect(result.value.status).toBe(200);
    const body = result.value.body;
    await expect(body.next()).resolves.toEqual({ done: false, value: { ok: true, value: new Uint8Array([120]) } });
    const pending = body.next();
    (await peer.promise).end(damage);
    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { ok: false, error: { kind: 'transport', cause: { cause: { name: 'HTTPParserError', code } } } },
    });
    await expect(body.next()).resolves.toEqual({ done: true, value: undefined });
  });
});

test.each(['HPE_INVALID_CONSTANT', 'HPE_INVALID_EOF_STATE'])('preserves a programmer TypeError with unbranded %s', async code => {
  const cause = Object.assign(new Error('application invariant failed'), { code });
  const before = new TypeError('fetch failed', { cause });
  const after = new TypeError('terminated', { cause });
  vi.stubGlobal('fetch', vi.fn()
    .mockRejectedValueOnce(before)
    .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(after); } }))));

  await expect(send('https://example.com')).rejects.toBe(before);
  const result = await send('https://example.com');
  if (!result.ok || result.value.body === null) throw new Error('expected a streaming response');
  await expect(result.value.body.next()).rejects.toBe(after);
});

test('reports native deflate requiring an unavailable preset dictionary as damaged response data', async () => {
  const payload = deflateSync('a response referencing the shared dictionary', { dictionary: Buffer.from('shared dictionary') });
  await withHttpPeer((_req, res) => {
    res.writeHead(200, { 'content-encoding': 'deflate', 'content-length': payload.byteLength });
    res.end(payload);
  }, async url => {
    const result = await send(url);
    if (!result.ok || result.value.body === null) throw new Error('expected a streaming response');
    const body = result.value.body;
    await expect(body.next()).resolves.toMatchObject({
      done: false,
      value: { ok: false, error: { kind: 'transport', cause: { cause: { code: 'Z_NEED_DICT' } } } },
    });
    await expect(body.next()).resolves.toEqual({ done: true, value: undefined });
  });
});

test.each(['before', 'between'] as const)('keeps a native body loss that settled %s reads ahead of later abort', async phase => {
  const peer = Promise.withResolvers<http.ServerResponse>();
  await withHttpPeer((_req, res) => {
    res.writeHead(200, { 'content-length': '20' });
    res.write('prefix');
    peer.resolve(res);
  }, async url => {
    const caller = new AbortController();
    const response = await nodeFetch(url, { signal: caller.signal });
    const reader = response.body!.getReader();
    if (phase === 'between') expect(new TextDecoder().decode((await reader.read()).value)).toBe('prefix');
    const settled = reader.closed.catch((cause: unknown) => cause);
    (await peer.promise).destroy();
    const failure = await settled;
    expect(response.classifyBodyFailure?.(failure)).toEqual({ kind: 'transport', cause: failure });
    caller.abort(new Error('late cancellation'));
    await expect(reader.read()).rejects.toBe(failure);
  });
});

test.each(['before', 'pending', 'between'] as const)('preserves the caller abort cause %s reading the response body', async phase => {
  await withHttpPeer((_req, res) => { res.write('prefix'); }, async url => {
    const caller = new AbortController();
    const response = await nodeFetch(url, { signal: caller.signal });
    const reader = response.body!.getReader();
    if (phase !== 'before') expect(new TextDecoder().decode((await reader.read()).value)).toBe('prefix');
    const pending = phase === 'pending' ? reader.read() : undefined;
    const reason = new Error('caller cancelled');
    caller.abort(reason);
    await expect(pending ?? reader.read()).rejects.toBe(reason);
    expect(response.classifyBodyFailure?.(reason)).toBeUndefined();
  });
});

test.each([
  ['UND_ERR_SOCKET', Symbol.for('undici.error.UND_ERR_SOCKET')],
  ['HPE_INVALID_CONSTANT', Symbol.for('undici.error.UND_ERR_HTTP_PARSER')],
])('preserves a programmer error with the %s code from the native upload source', async (code, brand) => {
  await withHttpPeer((req, res) => { req.resume(); req.on('end', () => res.end()); }, async url => {
    const bug = Object.assign(new Error('upload invariant failed'), {
      code,
      [brand]: true,
    });
    const uploadFailed = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        uploadFailed();
        controller.error(bug);
      },
    });
    await expect(nodeFetch(url, { method: 'POST', body })).rejects.toBe(bug);
    expect(uploadFailed).toHaveBeenCalledOnce();
  });
});

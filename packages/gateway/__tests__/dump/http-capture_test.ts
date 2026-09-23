import { expect, test } from 'vitest';

import { HttpCapture } from '../../src/dump/http-capture.ts';
import { parseSSEStream } from '@floway-dev/protocols/common';
import { jsonRequestBody } from '@floway-dev/provider';

const utf8 = (text: string) => new TextEncoder().encode(text);

test('captures the serialized provider request and raw malformed SSE before parsing', async () => {
  const capture = new HttpCapture();
  const raw = ': keepalive\r\ndata: {broken json}\r\n\r\ndata: tail\n\n';
  const requestBody = { model: 'resolved-model', messages: [{ role: 'user', content: '上游' }] };
  const fetcher = capture.wrapFetcher(async (url, init) => {
    expect(url).toBe('https://upstream.test/chat');
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(JSON.stringify(requestBody));
    return new Response(raw, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'trace' } });
  }, 'upstream-1');
  const response = await fetcher('https://upstream.test/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonRequestBody(requestBody) });
  await expect((async () => { for await (const frame of parseSSEStream(response.body!)) JSON.parse(frame.data); })()).rejects.toThrow();
  expect(capture.exchanges[0]?.request.body).toEqual({ encoding: 'utf8', data: JSON.stringify(requestBody) });
  expect(capture.exchanges[0]?.response?.body).toEqual({ encoding: 'utf8', data: raw });
  expect(capture.exchanges[0]?.response?.headers).toContainEqual(['x-request-id', 'trace']);
  expect(capture.exchanges[0]?.response?.complete).toBe(false);
});

test('preserves bytes received before a network failure and propagates the original error', async () => {
  const capture = new HttpCapture();
  const failure = new Error('socket reset');
  let pulled = false;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled) controller.error(failure);
      else { pulled = true; controller.enqueue(utf8('data: partial\n')); }
    },
  }, { highWaterMark: 0 });
  const fetcher = capture.wrapFetcher(async () => new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }), 'u');
  const response = await fetcher('https://upstream.test', {});
  await expect(response.text()).rejects.toBe(failure);
  expect(capture.exchanges[0]?.response).toMatchObject({ body: { encoding: 'utf8', data: 'data: partial\n' }, complete: false });
  expect(capture.exchanges[0]?.response?.error).toContain('socket reset');
});

test('records every retry independently including empty response and dial failure', async () => {
  const capture = new HttpCapture();
  const failure = new Error('dial failed');
  await expect(capture.wrapFetcher(async () => { throw failure; }, 'a')('https://a.test', {})).rejects.toBe(failure);
  const response = await capture.wrapFetcher(async () => new Response('ok', { headers: { 'content-type': 'text/plain' } }), 'b')('https://b.test', {});
  expect(await response.text()).toBe('ok');
  await capture.wrapFetcher(async () => new Response(null, { status: 204 }), 'c')('https://c.test', {});
  expect(capture.exchanges).toHaveLength(3);
  expect(capture.exchanges[0]?.error).toContain('dial failed');
  expect(capture.exchanges[1]?.response).toMatchObject({ complete: true, body: { data: 'ok' } });
  expect(capture.exchanges[2]?.response).toMatchObject({ complete: true, status: 204, body: { data: '' } });
});

test('captures binary bytes without lossy UTF-8 decoding', async () => {
  const capture = new HttpCapture();
  const response = await capture.wrapFetcher(async () => new Response(new Uint8Array([255, 128]), { headers: { 'content-type': 'text/plain' } }), 'u')('https://u.test', {});
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([255, 128]);
  expect(capture.exchanges[0]?.response?.body).toEqual({ encoding: 'base64', data: '/4A=' });
});

test('cancelling a pending read remains incomplete and never closes an already cancelled controller', async () => {
  const capture = new HttpCapture();
  let cancelReason: unknown;
  const response = await capture.wrapFetcher(async () => new Response(new ReadableStream({ cancel(reason) { cancelReason = reason; } })), 'u')('https://u.test', {});
  const reader = response.body!.getReader();
  const pending = reader.read();
  await reader.cancel('client cancelled');
  await pending;
  expect(cancelReason).toBe('client cancelled');
  expect(capture.exchanges[0]?.response).toMatchObject({ complete: false, error: 'client cancelled' });
});

test('raw text preserves the UTF-8 BOM', async () => {
  const capture = new HttpCapture();
  const bytes = new Uint8Array([239, 187, 191, 120]);
  const response = await capture.wrapFetcher(async () => new Response(bytes, { headers: { 'content-type': 'text/plain' } }), 'u')('https://u.test', {});
  await response.arrayBuffer();
  expect(capture.exchanges[0]?.response?.body).toEqual({ encoding: 'utf8', data: '\uFEFFx' });
});

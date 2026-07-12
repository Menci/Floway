import { Hono } from 'hono';
import { describe, test } from 'vitest';

import { inboundHeadersForUpstream } from './inbound-headers.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

describe('inboundHeadersForUpstream', () => {
  test('copies inbound headers and strips the gateway-private set', async () => {
    const app = new Hono();
    let headers: Headers | undefined;
    app.get('/test', c => {
      headers = inboundHeadersForUpstream(c);
      return c.text('ok');
    });
    await app.request('/test', {
      headers: {
        // Mixed-case for `Authorization` exercises Headers' case-insensitive
        // lookup so a scrub spelt 'authorization' still hits a wire header
        // written 'Authorization'.
        'Authorization': 'Bearer gateway-api-key',
        'api-key': 'azure-key',
        'x-api-key': 'gateway-api-key',
        'x-floway-session': 'sess-1',
        'x-goog-api-key': 'goog-key',
        'proxy-authorization': 'Basic abcdef',
        'cookie': 'session=abc',
        'host': 'gateway.example.com',
        'content-type': 'multipart/form-data; boundary=abc',
        'content-length': '12345',
        'content-encoding': 'gzip',
        'transfer-encoding': 'chunked',
        'anthropic-beta': 'context-1m',
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-sdk/1.0',
      },
    });
    assertExists(headers);
    assertEquals(headers.has('authorization'), false);
    assertEquals(headers.has('api-key'), false);
    assertEquals(headers.has('x-api-key'), false);
    assertEquals(headers.has('x-floway-session'), false);
    assertEquals(headers.has('x-goog-api-key'), false);
    assertEquals(headers.has('proxy-authorization'), false);
    assertEquals(headers.has('cookie'), false);
    assertEquals(headers.has('host'), false);
    assertEquals(headers.has('content-type'), false);
    assertEquals(headers.has('content-length'), false);
    assertEquals(headers.has('content-encoding'), false);
    assertEquals(headers.has('transfer-encoding'), false);
    assertEquals(headers.get('anthropic-beta'), 'context-1m');
    assertEquals(headers.get('anthropic-version'), '2023-06-01');
    assertEquals(headers.get('user-agent'), 'claude-sdk/1.0');
  });

  test('strips HTTP/1.1 framing, hop-by-hop, accept-encoding, and client-IP propagation signals', async () => {
    const app = new Hono();
    let headers: Headers | undefined;
    app.post('/test', c => {
      headers = inboundHeadersForUpstream(c);
      return c.text('ok');
    });
    await app.request('/test', {
      method: 'POST',
      headers: {
        'accept-encoding': 'gzip, br',
        'connection': 'keep-alive',
        'content-length': '17',
        'expect': '100-continue',
        'keep-alive': 'timeout=5',
        'proxy-connection': 'keep-alive',
        'te': 'trailers',
        'trailer': 'X-After',
        'transfer-encoding': 'chunked',
        'upgrade': 'websocket',
        'forwarded': 'for=192.0.2.1;proto=https',
        'x-real-ip': '192.0.2.1',
        'x-client-ip': '192.0.2.1',
        'true-client-ip': '192.0.2.1',
        'x-forwarded-for': '192.0.2.1',
        'x-forwarded-host': 'gateway.example.com',
        'x-forwarded-proto': 'https',
        'cdn-loop': 'cloudflare',
        'anthropic-beta': 'context-1m',
      },
      body: 'inbound-body-bytes',
    });
    assertExists(headers);
    for (const name of [
      'accept-encoding',
      'connection',
      'content-length',
      'expect',
      'keep-alive',
      'proxy-connection',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'forwarded',
      'x-real-ip',
      'x-client-ip',
      'true-client-ip',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'cdn-loop',
    ]) {
      assertEquals(headers.has(name), false);
    }
    assertEquals(headers.get('anthropic-beta'), 'context-1m');
  });

  test('strips every cf-* header Cloudflare injects, by prefix', async () => {
    const app = new Hono();
    let headers: Headers | undefined;
    app.get('/test', c => {
      headers = inboundHeadersForUpstream(c);
      return c.text('ok');
    });
    await app.request('/test', {
      headers: {
        'cf-connecting-ip': '203.0.113.10',
        'cf-connecting-ipv6': '2001:db8::1',
        'cf-ipcountry': 'US',
        'cf-ray': 'abcdef1234567890-IAD',
        'cf-visitor': '{"scheme":"https"}',
        'cf-warp-tag-id': 'tag-1',
        'cf-worker': 'gateway.example.com',
        'cf-something-future': 'whatever',
        'anthropic-beta': 'context-1m',
      },
    });
    assertExists(headers);
    for (const name of [...headers.keys()]) {
      if (name.startsWith('cf-')) throw new Error(`expected cf-* to be scrubbed, saw ${name}`);
    }
    assertEquals(headers.get('anthropic-beta'), 'context-1m');
  });

  test('returns a fresh Headers each call so mutations do not leak across requests', async () => {
    const app = new Hono();
    let first: Headers | undefined;
    let second: Headers | undefined;
    app.get('/test', c => {
      first = inboundHeadersForUpstream(c);
      second = inboundHeadersForUpstream(c);
      return c.text('ok');
    });
    await app.request('/test', { headers: { 'anthropic-beta': 'context-1m' } });
    assertExists(first);
    assertExists(second);
    if (first === second) throw new Error('inboundHeadersForUpstream returned the same Headers instance twice');
    first.set('anthropic-beta', 'mutated');
    assertEquals(second.get('anthropic-beta'), 'context-1m');
  });
});

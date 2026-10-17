import { Duplex } from 'node:stream';
import { brotliCompressSync, createBrotliDecompress } from 'node:zlib';

import { expect, test, vi } from 'vitest';

import { createFetcher } from '../../src/dial/fetcher.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import type { HttpContentDecoders } from '@floway-dev/http';
import { runDirectConnectRequest, runProxiedRequest, type SocketDial } from '@floway-dev/proxy';

test.each(['direct_connect', 'proxy'])('%s carries runtime decoding through the socket request pipeline', async id => {
  const body = '{"error":{"type":"rate_limit_error","message":"Five-hour usage limit reached"}}';
  const compressed = brotliCompressSync(Buffer.from(body));
  let written = '';
  const socketDial: SocketDial = {
    async connect() {
      return {
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            if (id === 'proxy') controller.enqueue(new TextEncoder().encode('HTTP/1.1 200 Connection Established\r\n\r\n'));
            controller.enqueue(new TextEncoder().encode(
              `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Encoding: br\r\nContent-Length: ${compressed.length}\r\nRetry-After: 60\r\nAnthropic-Ratelimit-Unified-Status: rejected\r\n\r\n`,
            ));
            controller.enqueue(compressed);
            controller.close();
          },
        }),
        writable: new WritableStream({ write(chunk) { written += new TextDecoder().decode(chunk); } }),
        close: async () => {},
      };
    },
  };
  const decode = vi.fn(() => Duplex.toWeb(createBrotliDecompress()) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const contentDecoders: HttpContentDecoders = new Map([['br', decode]]);
  const runDirectFetch = vi.fn(async () => { throw new Error('unexpected native fetch fallback'); });
  const fetcher = createFetcher({
    repo: new InMemoryRepo(),
    upstreamId: 'upstream',
    fallbackList: [{ id }],
    runtimeLocation: null,
    proxyById: new Map([['proxy', { config: { kind: 'http', host: 'proxy.test', port: 8080, tls: false, name: 'Floway test proxy' }, dialTimeoutMs: null }]]),
    runProxied: runProxiedRequest,
    runDirectFetch,
    runDirectConnect: runDirectConnectRequest,
    socketDial: () => socketDial,
    contentDecoders: () => contentDecoders,
  });
  const response = await fetcher('http://upstream.test/v1/messages', { method: 'POST', headers: { 'accept-encoding': 'gzip, br' }, body: '{}' });
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(response.headers.get('anthropic-ratelimit-unified-status')).toBe('rejected');
  expect(await response.text()).toBe(body);
  expect(decode).toHaveBeenCalledTimes(1);
  expect(runDirectFetch).not.toHaveBeenCalled();
  expect(written).toContain('accept-encoding: gzip, br\r\n');
  expect(written).toContain('POST /v1/messages HTTP/1.1\r\n');
  if (id === 'proxy') expect(written).toContain('CONNECT upstream.test:80 HTTP/1.1\r\n');
});

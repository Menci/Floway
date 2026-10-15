import { brotliCompressSync, constants, createBrotliCompress, zstdCompressSync } from 'node:zlib';

import { expect, test, vi } from 'vitest';

import { cloudflareHttpContentDecoders } from '../src/http-content-decoders.ts';
import { fetchOnStream } from '@floway-dev/http';

test.each([
  ['br', brotliCompressSync],
  ['zstd', zstdCompressSync],
] as const)('decodes a %s-compressed 429 without losing its error or quota headers', async (coding, compress) => {
  const body = '{"type":"error","error":{"type":"rate_limit_error","message":"Five-hour usage limit reached"}}';
  const compressed = compress(Buffer.from(body));
  let written = '';
  const response = await fetchOnStream({
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Encoding: ${coding}\r\nContent-Length: ${compressed.length}\r\nRetry-After: 60\r\nAnthropic-Ratelimit-Unified-Reset: 1792080060\r\n\r\n`,
        ));
        for (let offset = 0; offset < compressed.length; offset += 3) controller.enqueue(compressed.subarray(offset, offset + 3));
        controller.close();
      },
    }),
    writable: new WritableStream({ write(chunk) { written += new TextDecoder().decode(chunk); } }),
  }, { method: 'POST', path: '/v1/messages', headers: [['Host', 'example.test'], ['Accept-Encoding', 'gzip, br, zstd']] }, undefined, cloudflareHttpContentDecoders);

  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(response.headers.get('anthropic-ratelimit-unified-reset')).toBe('1792080060');
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(response.headers.get('content-length')).toBeNull();
  expect(await response.text()).toBe(body);
  expect(written).toContain('Accept-Encoding: gzip, br, zstd\r\n');
});

test('a truncated Brotli response propagates the decoder error', async () => {
  const compressed = brotliCompressSync(Buffer.from('Floway compressed response'));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed.subarray(0, -1));
      controller.close();
    },
  }).pipeThrough(cloudflareHttpContentDecoders.get('br')!());
  await expect(new Response(body).text()).rejects.toMatchObject({ code: 'Z_BUF_ERROR' });
});

test('Brotli emits a flushed event before EOF and propagates cancellation upstream', async () => {
  const encoder = createBrotliCompress();
  const chunks: Buffer[] = [];
  encoder.on('data', (chunk: Buffer) => chunks.push(chunk));
  const event = 'data: {"type":"message_start"}\n\n';
  encoder.write(event);
  await new Promise<void>((resolve, reject) => {
    encoder.once('error', reject);
    encoder.flush(constants.BROTLI_OPERATION_FLUSH, resolve);
  });
  encoder.destroy();
  const cancel = vi.fn();
  const input = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.concat(chunks)); },
    cancel,
  });
  const reader = input.pipeThrough(cloudflareHttpContentDecoders.get('br')!()).getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(new TextDecoder().decode(first.value)).toBe(event);
  await reader.cancel(new Error('client disconnected'));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
});

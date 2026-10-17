import assert from 'node:assert/strict';
import { brotliCompressSync, constants, createBrotliCompress, createZstdCompress, gzipSync, zstdCompressSync } from 'node:zlib';

import { cloudflareHttpContentDecoders } from '../../src/http-content-decoders.ts';
import { fetchOnStream } from '@floway-dev/http';

type Coding = 'br' | 'zstd';
const event = 'data: {"type":"message_start"}\n\n';
const compress = { br: brotliCompressSync, zstd: zstdCompressSync };

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Floway decoder did not settle within 2 seconds')), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function flushed(coding: Coding): Promise<Uint8Array> {
  const encoder = coding === 'br' ? createBrotliCompress() : createZstdCompress();
  const chunks: Uint8Array[] = [];
  encoder.on('data', (chunk: Uint8Array) => chunks.push(chunk));
  try {
    encoder.write(event);
    await bounded(new Promise<void>((resolve, reject) => {
      encoder.once('error', reject);
      encoder.flush(coding === 'br' ? constants.BROTLI_OPERATION_FLUSH : constants.ZSTD_e_flush, resolve);
    }));
    return Buffer.concat(chunks);
  } finally {
    encoder.destroy();
  }
}

async function unlocked(input: ReadableStream<Uint8Array>) {
  await bounded((async () => {
    while (input.locked) await new Promise(resolve => setTimeout(resolve, 1));
  })());
}

async function response(coding: Coding, stacked = false) {
  const body = '{"type":"error","error":{"type":"rate_limit_error","message":"Five-hour usage limit reached"}}';
  const compressed = compress[coding](stacked ? gzipSync(body) : Buffer.from(body));
  let written = '';
  const result = await fetchOnStream({
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Encoding: ${stacked ? 'gzip, ' : ''}${coding}\r\nContent-Length: ${compressed.length}\r\nRetry-After: 60\r\nAnthropic-Ratelimit-Unified-Reset: 1792080060\r\n\r\n`,
        ));
        for (let offset = 0; offset < compressed.length; offset += 3) controller.enqueue(compressed.subarray(offset, offset + 3));
        controller.close();
      },
    }),
    writable: new WritableStream({ write(chunk) { written += new TextDecoder().decode(chunk); } }),
  }, { method: 'POST', path: '/v1/messages', headers: [['Host', 'example.test'], ['Accept-Encoding', 'gzip, br, zstd']] }, undefined, cloudflareHttpContentDecoders);
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('retry-after'), '60');
  assert.equal(result.headers.get('anthropic-ratelimit-unified-reset'), '1792080060');
  assert.equal(result.headers.get('content-encoding'), null);
  assert.equal(result.headers.get('content-length'), null);
  assert.equal(await bounded(result.text()), body);
  assert.ok(written.includes('Accept-Encoding: gzip, br, zstd\r\n'));
}

async function cancel(coding: Coding, afterData: boolean) {
  const bytes = afterData ? await flushed(coding) : undefined;
  const reason = new Error('Floway client disconnected');
  const cancellations: unknown[] = [];
  const input = new ReadableStream<Uint8Array>({
    start(controller) { if (bytes) controller.enqueue(bytes); },
    cancel(value) { cancellations.push(value); },
  });
  const reader = input.pipeThrough(cloudflareHttpContentDecoders.get(coding)!()).getReader();
  if (afterData) {
    const first = await bounded(reader.read());
    assert.equal(first.done, false);
    assert.equal(new TextDecoder().decode(first.value), event);
  }
  await bounded(reader.cancel(reason));
  await unlocked(input);
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0], reason);
}

async function sourceError(coding: Coding, afterData: boolean) {
  const bytes = afterData ? await flushed(coding) : undefined;
  const failure = new Error('Floway upstream socket failed');
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      if (bytes) controller.enqueue(bytes);
    },
  });
  const reader = input.pipeThrough(cloudflareHttpContentDecoders.get(coding)!()).getReader();
  if (afterData) {
    const first = await bounded(reader.read());
    assert.equal(first.done, false);
    assert.equal(new TextDecoder().decode(first.value), event);
  }
  const pending = reader.read();
  source.error(failure);
  await assert.rejects(bounded(pending), (error: unknown) => {
    assert.equal(error, failure);
    return true;
  });
  await unlocked(input);
}

async function truncated(coding: Coding) {
  const bytes = compress[coding](event).subarray(0, -1);
  const input = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
  const decoded = input.pipeThrough(cloudflareHttpContentDecoders.get(coding)!());
  await assert.rejects(bounded(new Response(decoded).text()), {
    code: coding === 'br' ? 'Z_BUF_ERROR' : 'ERR_ZSTD_DECOMPRESSION_FAILED',
  });
  await unlocked(input);
}

// workerd's test command and Cloudflare remote preview execute the same assertions.
// https://github.com/cloudflare/workerd/blob/main/src/workerd/server/README.md
export const brResponse = { test: () => response('br') };
export const zstdResponse = { test: () => response('zstd') };
export const stackedResponse = { test: () => response('br', true) };
export const brCancelBeforeData = { test: () => cancel('br', false) };
export const zstdCancelBeforeData = { test: () => cancel('zstd', false) };
export const brStreamingCancel = { test: () => cancel('br', true) };
export const zstdStreamingCancel = { test: () => cancel('zstd', true) };
export const brSourceErrorBeforeData = { test: () => sourceError('br', false) };
export const zstdSourceErrorBeforeData = { test: () => sourceError('zstd', false) };
export const brStreamingSourceError = { test: () => sourceError('br', true) };
export const zstdStreamingSourceError = { test: () => sourceError('zstd', true) };
export const brTruncated = { test: () => truncated('br') };
export const zstdTruncated = { test: () => truncated('zstd') };

const cases = {
  brResponse, zstdResponse, stackedResponse,
  brCancelBeforeData, zstdCancelBeforeData, brStreamingCancel, zstdStreamingCancel,
  brSourceErrorBeforeData, zstdSourceErrorBeforeData, brStreamingSourceError, zstdStreamingSourceError,
  brTruncated, zstdTruncated,
};

export default {
  async fetch() {
    const results: Record<string, string> = {};
    for (const [name, entry] of Object.entries(cases)) {
      try {
        await entry.test();
        results[name] = 'PASS';
      } catch (error) {
        results[name] = error instanceof Error ? error.stack ?? error.message : String(error);
      }
    }
    return Response.json(results, { status: Object.values(results).every(value => value === 'PASS') ? 200 : 500 });
  },
};

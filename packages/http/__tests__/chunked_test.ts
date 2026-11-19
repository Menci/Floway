import { describe, expect, it } from 'vitest';

import { decodeChunked } from '../src/chunked.ts';
import { HttpProtocolError } from '../src/errors.ts';

const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  let out = '';
  const dec = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
};

const drainExpectError = async (stream: ReadableStream<Uint8Array>): Promise<unknown> => {
  const reader = stream.getReader();
  while (true) {
    try {
      const { done } = await reader.read();
      if (done) return new Error('chunked stream closed without an error');
    } catch (e) {
      return e;
    }
  }
};

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const fromString = (s: string): { reader: ReadableStreamDefaultReader<Uint8Array>; head: Uint8Array } => {
  // The decoder takes a head buffer + a reader for the rest. Empty `head`
  // and the entire stream pre-loaded mirrors the realistic case where the
  // response head got peeled off in the same chunk as the first body bytes.
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc(s)); c.close(); },
  });
  return { reader: stream.getReader(), head: new Uint8Array(0) };
};

describe('decodeChunked — RFC 9112 §7.1 happy path', () => {
  it('concatenates chunks split into multiple size+data records', async () => {
    // Three chunks: "Wiki" (4), "pedia" (5), " in chunks." (B = 11).
    const input = '4\r\nWiki\r\n5\r\npedia\r\nB\r\n in chunks.\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('Wikipedia in chunks.');
  });
});

describe('decodeChunked — error vectors', () => {
  it('errors when EOF arrives mid-data', async () => {
    const input = '5\r\nhel'; // missing two more bytes + CRLF + 0
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect(err).toMatchObject({ code: 'EOF' });
  });

  it('errors when the data block is not followed by CRLF', async () => {
    // Five payload bytes, then garbage instead of CRLF.
    const input = '5\r\nhelloXX0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect(err).toMatchObject({ code: 'CHUNK_BAD_SIZE' });
  });
});

describe('decodeChunked — RFC 9112 §7.1.1 chunk-size grammar', () => {
  it('rejects a chunk size with a 0x prefix', async () => {
    const input = '0x5\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('CHUNK_BAD_SIZE');
  });
});

describe('decodeChunked — extensions and trailers (RFC 9112 §7.1.1, §7.1.2)', () => {
  it('rejects when a trailer block exceeds the 64 KiB cap', async () => {
    // 70 KiB of plausible trailer header lines, each terminated by CRLF
    // but never reaching the empty-line terminator.
    const big = Array.from({ length: 800 }, (_, i) => `X-Trailer-${i}: ${'p'.repeat(80)}`).join('\r\n');
    const input = `5\r\nhello\r\n0\r\n${big}\r\n\r\n`;
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('TRAILERS_TOO_LONG');
  });

  it('still accepts a 4 KiB trailer block delivered one byte at a time', async () => {
    // The trailer-cap accounting counts each byte once across drip-fed
    // reads. A per-iteration `buf.byteLength` add would collapse the
    // effective cap to ~O(sqrt(MAX_TRAILERS_BYTES)) (~360 bytes at the
    // 64 KiB cap) under byte-at-a-time delivery; 4 KiB here is more than
    // 10x past that threshold and still safely under the real 64 KiB cap,
    // so the test passes iff no error is raised.
    const big = Array.from({ length: 50 }, (_, i) => `X-Trailer-${i}: ${'p'.repeat(70)}`).join('\r\n');
    const input = `5\r\nhello\r\n0\r\n${big}\r\n\r\n`;
    expect(input.length).toBeGreaterThan(4096);
    expect(input.length).toBeLessThan(64 * 1024);
    const bytes = enc(input);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.byteLength; i++) c.enqueue(bytes.subarray(i, i + 1));
        c.close();
      },
    });
    expect(await drain(decodeChunked(stream.getReader(), new Uint8Array(0)))).toBe('hello');
  });

  it('rejects when the chunk-size line exceeds the 1 KiB cap due to a runaway extension', async () => {
    const input = `5;ext=${'a'.repeat(2000)}\r\nhello\r\n0\r\n\r\n`;
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('CHUNK_TOO_LONG');
  });
});

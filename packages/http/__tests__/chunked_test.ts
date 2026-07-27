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

  it('tolerates chunk extensions after a semicolon and ignores them', async () => {
    const input = '5;name=foo\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('hello');
  });

  it('consumes (and discards) trailing headers after the 0-sized terminator', async () => {
    const input = '5\r\nhello\r\n0\r\nX-Trailer: t1\r\nX-Trailer-2: t2\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('hello');
  });
});

describe('decodeChunked — error vectors', () => {
  it('errors on a hex size line containing non-hex bytes', async () => {
    const input = '5g\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as Error).message).toMatch(/bad size line/);
  });

  it('errors on an empty size line', async () => {
    const input = '\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
  });

  it('errors when EOF arrives mid-data', async () => {
    const input = '5\r\nhel'; // missing two more bytes + CRLF + 0
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as Error).message).toMatch(/EOF mid-data/);
  });

  it('errors when EOF arrives in the trailers block before the final CRLF', async () => {
    const input = '5\r\nhello\r\n0\r\nX-Trailer: t1\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as Error).message).toMatch(/EOF in trailers/);
  });

  it('errors when the data block is not followed by CRLF', async () => {
    // Five payload bytes, then garbage instead of CRLF.
    const input = '5\r\nhelloXX0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as Error).message).toMatch(/missing CRLF/);
  });
});

describe('decodeChunked — incremental reads', () => {
  it('handles chunks that arrive split across many ReadableStream chunks', async () => {
    const pieces = [
      '4\r',
      '\nWi', 'ki', '\r\n',
      '5\r\np', 'ed', 'ia', '\r\n',
      '0\r\n\r\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of pieces) c.enqueue(enc(p));
        c.close();
      },
    });
    const out = await drain(decodeChunked(stream.getReader(), new Uint8Array(0)));
    expect(out).toBe('Wikipedia');
  });

  it('handles a single byte arriving per ReadableStream chunk (worst-case slow drip)', async () => {
    const all = '4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n';
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of all) c.enqueue(enc(ch));
        c.close();
      },
    });
    const out = await drain(decodeChunked(stream.getReader(), new Uint8Array(0)));
    expect(out).toBe('Wikipedia');
  });

  it('handles a chunk-size line split across the head buffer and the reader', async () => {
    const head = enc('5\r');
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc('\nhello\r\n0\r\n\r\n')); c.close(); },
    });
    const out = await drain(decodeChunked(stream.getReader(), head));
    expect(out).toBe('hello');
  });
});

describe('decodeChunked — RFC 9112 §7.1.1 chunk-size grammar', () => {
  it('accepts uppercase hex digits (chunk-size = 1*HEXDIG)', async () => {
    // 0xFF = 255 'a' bytes.
    const data = 'a'.repeat(0xff);
    const input = `FF\r\n${data}\r\n0\r\n\r\n`;
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe(data);
  });

  it('accepts lowercase hex digits', async () => {
    const data = 'b'.repeat(0xab);
    const input = `ab\r\n${data}\r\n0\r\n\r\n`;
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe(data);
  });

  it('accepts a leading-zero chunk size (still a valid hex run)', async () => {
    const input = '005\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('hello');
  });

  it('rejects a chunk size with a 0x prefix', async () => {
    const input = '0x5\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('CHUNK_BAD_SIZE');
  });

  it('rejects a chunk size with a leading + sign', async () => {
    const input = '+5\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('CHUNK_BAD_SIZE');
  });

  it('rejects a negative chunk size', async () => {
    const input = '-5\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('CHUNK_BAD_SIZE');
  });

  it('rejects a chunk size with non-hex letters', async () => {
    const input = 'gg\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('CHUNK_BAD_SIZE');
  });

  it('rejects a chunk size that is just whitespace', async () => {
    const input = '   \r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('CHUNK_BAD_SIZE');
  });
});

describe('decodeChunked — extensions and trailers (RFC 9112 §7.1.1, §7.1.2)', () => {
  it('accepts a chunk extension with a name only and ignores it', async () => {
    const input = '5;ext\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('hello');
  });

  it('accepts a chunk extension with name=value and ignores it', async () => {
    const input = '5;name=value\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('hello');
  });

  it('accepts multiple chunk extensions on the same chunk', async () => {
    const input = '5;ilovew3;somuchlove=aretheseparametersfor\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('hello');
  });

  it('accepts a quoted-string chunk extension value', async () => {
    const input = '5;ext="quoted;value"\r\nhello\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('hello');
  });

  it('accepts a single trailing header after the 0-sized terminator', async () => {
    const input = '5\r\nhello\r\n0\r\nX-Trailer: t\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('hello');
  });

  it('accepts multiple trailing headers after the 0-sized terminator', async () => {
    const input = '5\r\nhello\r\n0\r\nA: 1\r\nB: 2\r\nC: 3\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('hello');
  });

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

  it('rejects a chunk-size line that drops bytes without ever delivering CRLF', async () => {
    // 1.5 KiB of pure hex digits — never terminated.
    const input = 'a'.repeat(1500);
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('CHUNK_TOO_LONG');
  });
});

describe('decodeChunked — multi-chunk bodies', () => {
  it('decodes two non-terminator chunks before the terminator', async () => {
    const input = '5\r\nhello\r\n5\r\nworld\r\n0\r\n\r\n';
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe('helloworld');
  });

  it('decodes many small chunks back-to-back', async () => {
    let payload = '';
    let expected = '';
    for (let i = 0; i < 50; i++) {
      payload += `1\r\n${String.fromCharCode(0x41 + (i % 26))}\r\n`;
      expected += String.fromCharCode(0x41 + (i % 26));
    }
    payload += '0\r\n\r\n';
    const { reader, head } = fromString(payload);
    expect(await drain(decodeChunked(reader, head))).toBe(expected);
  });

  it('decodes a single large chunk (1 KiB) in one go', async () => {
    const data = 'k'.repeat(1024);
    const input = `400\r\n${data}\r\n0\r\n\r\n`;
    const { reader, head } = fromString(input);
    expect(await drain(decodeChunked(reader, head))).toBe(data);
  });
});

describe('decodeChunked — premature EOF vectors', () => {
  it('errors with EOF when the size line never finishes', async () => {
    const input = '5'; // no CRLF, no anything else
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('EOF');
  });

  it('errors with EOF when CRLF is missing after the chunk data', async () => {
    const input = '5\r\nhello'; // no CRLF after data
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('EOF');
  });

  it('errors with EOF when stream ends after the 0-sized line but before the terminator CRLF', async () => {
    const input = '5\r\nhello\r\n0\r\n'; // missing the empty trailers terminator CRLF
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('EOF');
  });

  it('errors with CHUNK_BAD_SIZE when garbage replaces the trailing CRLF after data', async () => {
    const input = '5\r\nhelloXXmore stuff';
    const { reader, head } = fromString(input);
    const err = await drainExpectError(decodeChunked(reader, head));
    expect(err).toBeInstanceOf(HttpProtocolError);
    expect((err as HttpProtocolError).code).toBe('CHUNK_BAD_SIZE');
  });
});

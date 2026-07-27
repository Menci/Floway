import { describe, expect, it } from 'vitest';

import { makeExactReader } from '../src/exact-reader.ts';

// Build a ReadableStream that emits the supplied chunks in order. The reader
// returned by getReader() lets the exact-reader walk them one .read() at a
// time, matching how a real socket's readable behaves.
const makeReader = (chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> => {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!);
        i++;
      } else {
        controller.close();
      }
    },
  }).getReader();
};

describe('makeExactReader', () => {
  it('serves a single read from the first chunk when it has exactly N bytes', async () => {
    const read = makeExactReader(makeReader([new Uint8Array([1, 2, 3, 4])]), 'T');
    expect(Array.from(await read(4))).toEqual([1, 2, 3, 4]);
  });

  it('joins multiple short chunks until N bytes have arrived', async () => {
    const read = makeExactReader(
      makeReader([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]),
      'T',
    );
    expect(Array.from(await read(5))).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the tail of an oversized chunk as leftover for the next call', async () => {
    // Single chunk carries 6 bytes; the first 2-byte read consumes 2 and
    // leftover holds 4. The next 4-byte read drains leftover with no
    // additional .read(). The third 0-byte read returns an empty buffer.
    const read = makeExactReader(makeReader([new Uint8Array([10, 20, 30, 40, 50, 60])]), 'T');
    expect(Array.from(await read(2))).toEqual([10, 20]);
    expect(Array.from(await read(4))).toEqual([30, 40, 50, 60]);
    expect(Array.from(await read(0))).toEqual([]);
  });

  it('splits leftover across multiple smaller reads without re-pulling', async () => {
    const read = makeExactReader(makeReader([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]), 'T');
    expect(Array.from(await read(3))).toEqual([1, 2, 3]);
    expect(Array.from(await read(3))).toEqual([4, 5, 6]);
    expect(Array.from(await read(2))).toEqual([7, 8]);
  });

  it('flushes leftover then resumes pulling for the remainder of a larger read', async () => {
    // First read leaves 3 bytes in leftover; the next 5-byte read consumes
    // those 3 then must pull again to satisfy the remaining 2.
    const read = makeExactReader(
      makeReader([new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([6, 7])]),
      'T',
    );
    expect(Array.from(await read(2))).toEqual([1, 2]);
    expect(Array.from(await read(5))).toEqual([3, 4, 5, 6, 7]);
  });

  it('throws a labelled EOF error when the stream closes before N bytes arrive', async () => {
    const read = makeExactReader(makeReader([new Uint8Array([1, 2])]), 'SS2022');
    await expect(read(5)).rejects.toThrowError(/SS2022: EOF, want 5 got 2/);
  });

  it('returns an ArrayBuffer-backed buffer that the caller can retain safely', async () => {
    // Crypto consumers (HKDF / AEAD) hold these buffers past the next read,
    // so the returned memory must not share storage with the transport's
    // possibly-pooled chunk.
    const src = new Uint8Array([1, 2, 3, 4]);
    const read = makeExactReader(makeReader([src]), 'T');
    const out = await read(4);
    expect(out.buffer).not.toBe(src.buffer);
  });
});

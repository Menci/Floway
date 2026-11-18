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
});

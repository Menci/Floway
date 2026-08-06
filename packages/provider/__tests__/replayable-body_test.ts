import { expect, test, vi } from 'vitest';

import { directFetcher } from '../src/options.ts';
import { createReplayableBody, nativeFetchInit, prepareNativeFetch, replayableBodySource, replayableBodyStream } from '../src/replayable-body.ts';

const read = async (body: BodyInit): Promise<number[]> =>
  Array.from(new Uint8Array(await new Response(body).arrayBuffer()));

test('replayable body streams borrowed segment views without concatenating them', async () => {
  const first = Uint8Array.of(1, 2);
  const second = Uint8Array.of(3, 4);
  const stream = createReplayableBody([first, second]);
  const source = replayableBodySource(stream);

  expect(source).not.toBeNull();
  expect(source?.segments).toEqual([first, second]);
  expect(source?.byteLength).toBe(4);
  expect(await read(stream)).toEqual([1, 2, 3, 4]);
  expect(await read(replayableBodyStream(source!))).toEqual([1, 2, 3, 4]);
});

test('native fetch init creates a fresh stream and authoritative framing headers', async () => {
  const original = createReplayableBody([Uint8Array.of(1), Uint8Array.of(2, 3)]);
  const init = nativeFetchInit({
    method: 'POST',
    headers: { 'content-length': '999', 'transfer-encoding': 'chunked' },
    body: original,
  });

  expect(init.body).toBeInstanceOf(ReadableStream);
  expect(init.body).not.toBe(original);
  expect(new Headers(init.headers).get('content-length')).toBe('3');
  expect(new Headers(init.headers).has('transfer-encoding')).toBe(false);
  expect(await read(init.body!)).toEqual([1, 2, 3]);
});

test('native fetch init uses FixedLengthStream when the runtime provides it', async () => {
  const original = Reflect.get(globalThis, 'FixedLengthStream');
  let expectedLength: number | undefined;
  class FakeFixedLengthStream {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    constructor(length: number) {
      expectedLength = length;
      const transform = new TransformStream<Uint8Array, Uint8Array>();
      this.readable = transform.readable;
      this.writable = transform.writable;
    }
  }
  Reflect.set(globalThis, 'FixedLengthStream', FakeFixedLengthStream);
  try {
    const prepared = prepareNativeFetch({ body: createReplayableBody([Uint8Array.of(1, 2, 3)]) });
    expect(expectedLength).toBe(3);
    expect(await read(prepared.init.body!)).toEqual([1, 2, 3]);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'FixedLengthStream');
    else Reflect.set(globalThis, 'FixedLengthStream', original);
  }
});

test('replayable body rejects forged byte lengths before publishing framing', () => {
  expect(() => replayableBodyStream({ segments: [Uint8Array.of(1)], byteLength: 999 }))
    .toThrow(/does not match/u);
});

test('replayable body rejects a detached borrowed segment before dispatch', () => {
  const bytes = Uint8Array.of(1, 2, 3);
  const body = createReplayableBody([bytes]);
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });

  expect(() => nativeFetchInit({ body })).toThrow(/does not match/u);
});

test('direct fetch cancels a FixedLengthStream pump when fetch rejects before reading', async () => {
  const original = Reflect.get(globalThis, 'FixedLengthStream');
  let writable: WritableStream<Uint8Array> | undefined;
  class FakeFixedLengthStream {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    constructor() {
      const transform = new TransformStream<Uint8Array, Uint8Array>();
      this.readable = transform.readable;
      this.writable = transform.writable;
      writable = this.writable;
    }
  }
  Reflect.set(globalThis, 'FixedLengthStream', FakeFixedLengthStream);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch rejected')));
  try {
    await expect(directFetcher('https://example.test', {
      method: 'POST',
      body: createReplayableBody([Uint8Array.of(1, 2, 3)]),
    })).rejects.toThrow('fetch rejected');
    expect(writable?.locked).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    if (original === undefined) Reflect.deleteProperty(globalThis, 'FixedLengthStream');
    else Reflect.set(globalThis, 'FixedLengthStream', original);
  }
});

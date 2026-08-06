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

test('native fetch init removes transport-owned framing from ordinary bodies', () => {
  const body = Uint8Array.of(1, 2, 3);
  const init = nativeFetchInit({
    method: 'POST',
    headers: {
      'content-length': '999',
      'transfer-encoding': 'chunked',
      'x-request-header': 'kept',
    },
    body,
  });

  expect(init.body).toBe(body);
  expect(new Headers(init.headers).has('content-length')).toBe(false);
  expect(new Headers(init.headers).has('transfer-encoding')).toBe(false);
  expect(new Headers(init.headers).get('x-request-header')).toBe('kept');
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

test.each([
  ['Error values', new Error('readable cancel failed'), new Error('pump failed')],
  ['undefined values', undefined, undefined],
])('direct fetch preserves immediate FixedLengthStream cleanup failures, including %s', async (_label, readableError, pumpError) => {
  const original = Reflect.get(globalThis, 'FixedLengthStream');
  const fetchError = new Error('fetch rejected');
  let notifyWriteStarted!: () => void;
  const writeStarted = new Promise<void>(resolve => { notifyWriteStarted = resolve; });
  class FailingFixedLengthStream {
    readonly readable = new ReadableStream<Uint8Array>({
      cancel: () => { throw readableError; },
    });
    readonly writable = new WritableStream<Uint8Array>({
      write() {
        notifyWriteStarted();
        throw pumpError;
      },
    });
  }
  Reflect.set(globalThis, 'FixedLengthStream', FailingFixedLengthStream);
  vi.stubGlobal('fetch', vi.fn(async () => {
    await writeStarted;
    await Promise.resolve();
    throw fetchError;
  }));
  try {
    const rejection = await directFetcher('https://example.test', {
      method: 'POST',
      body: createReplayableBody([Uint8Array.of(1, 2, 3)]),
    }).catch((error: unknown) => error) as AggregateError;

    expect(rejection).toBeInstanceOf(AggregateError);
    expect(rejection.errors).toEqual(readableError === pumpError
      ? [fetchError, readableError]
      : [fetchError, readableError, pumpError]);
    expect(rejection.cause).toBe(fetchError);
  } finally {
    vi.unstubAllGlobals();
    if (original === undefined) Reflect.deleteProperty(globalThis, 'FixedLengthStream');
    else Reflect.set(globalThis, 'FixedLengthStream', original);
  }
});

test('direct fetch bounds late FixedLengthStream cleanup rejection and observes its eventual failure', async () => {
  vi.useFakeTimers();
  const original = Reflect.get(globalThis, 'FixedLengthStream');
  const fetchError = new Error('fetch rejected');
  const pumpError = new Error('pump failed');
  const lateCancelError = new Error('late readable cancel failure');
  let notifyWriteStarted!: () => void;
  const writeStarted = new Promise<void>(resolve => { notifyWriteStarted = resolve; });
  let rejectReadableCancel!: (error: unknown) => void;
  class LateFailingFixedLengthStream {
    readonly readable = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>((_resolve, reject) => { rejectReadableCancel = reject; }),
    });
    readonly writable = new WritableStream<Uint8Array>({
      write() {
        notifyWriteStarted();
        throw pumpError;
      },
    });
  }
  Reflect.set(globalThis, 'FixedLengthStream', LateFailingFixedLengthStream);
  vi.stubGlobal('fetch', vi.fn(async () => {
    await writeStarted;
    await Promise.resolve();
    throw fetchError;
  }));
  try {
    const rejectionPending = directFetcher('https://example.test', {
      method: 'POST',
      body: createReplayableBody([Uint8Array.of(1, 2, 3)]),
    }).catch((error: unknown) => error) as Promise<AggregateError>;
    await writeStarted;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    const rejection = await rejectionPending;

    expect(rejection).toBeInstanceOf(AggregateError);
    expect(rejection.errors[0]).toBe(fetchError);
    expect(rejection.errors[1]).toMatchObject({
      name: 'NativeFetchCleanupTimeoutError',
      operationIndex: 0,
      timeoutMs: 5_000,
    });
    expect(rejection.errors[2]).toBe(pumpError);
    rejectReadableCancel(lateCancelError);
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (original === undefined) Reflect.deleteProperty(globalThis, 'FixedLengthStream');
    else Reflect.set(globalThis, 'FixedLengthStream', original);
  }
});

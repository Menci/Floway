import { describe, expect, it, vi } from 'vitest';

import { postHandshakeReadable } from '../src/post-handshake-readable.ts';
import type { DialedSocket } from '../src/types.ts';

const fakeReader = (overrides: {
  read?: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel?: (reason?: unknown) => Promise<void>;
  releaseLock?: () => void;
}): ReadableStreamDefaultReader<Uint8Array> => ({
  read: overrides.read ?? vi.fn(async () => ({ done: true, value: undefined })),
  cancel: overrides.cancel ?? vi.fn(async () => {}),
  releaseLock: overrides.releaseLock ?? vi.fn(),
} as unknown as ReadableStreamDefaultReader<Uint8Array>);

const fakeSocket = (close: () => Promise<void>): DialedSocket => ({
  readable: new ReadableStream<Uint8Array>(),
  writable: new WritableStream<Uint8Array>(),
  close,
});

describe('postHandshakeReadable cleanup failures', () => {
  it('rejects cancellation with reader, release, and socket failures in order', async () => {
    const cancelError = new Error('cancel failed');
    const releaseError = new Error('release failed');
    const closeError = new Error('close failed');
    const reader = fakeReader({
      cancel: vi.fn(async () => { throw cancelError; }),
      releaseLock: vi.fn(() => { throw releaseError; }),
    });
    const stream = postHandshakeReadable(fakeSocket(async () => { throw closeError; }), reader, new Uint8Array(0));

    const rejection = await stream.cancel('stop').catch((error: unknown) => error) as AggregateError;
    expect(rejection).toBeInstanceOf(AggregateError);
    expect(rejection.errors).toEqual([cancelError, releaseError, closeError]);
    expect(rejection.cause).toBe(cancelError);
  });

  it('keeps a read failure primary while reporting release and close failures', async () => {
    const readError = new Error('read failed');
    const releaseError = new Error('release failed');
    const closeError = new Error('close failed');
    const reader = fakeReader({
      read: vi.fn(async () => { throw readError; }),
      releaseLock: vi.fn(() => { throw releaseError; }),
    });
    const stream = postHandshakeReadable(fakeSocket(async () => { throw closeError; }), reader, new Uint8Array(0));

    const rejection = await stream.getReader().read().catch((error: unknown) => error) as AggregateError;
    expect(rejection.errors).toEqual([readError, releaseError, closeError]);
    expect(rejection.cause).toBe(readError);
  });

  it('surfaces socket close failure instead of announcing a clean EOF', async () => {
    const closeError = new Error('close failed');
    const stream = postHandshakeReadable(
      fakeSocket(async () => { throw closeError; }),
      fakeReader({}),
      new Uint8Array(0),
    );

    await expect(stream.getReader().read()).rejects.toBe(closeError);
  });

  it('starts socket close without waiting for a pending reader cancellation', async () => {
    let resolveCancel!: () => void;
    const cancelPending = new Promise<void>(resolve => { resolveCancel = resolve; });
    const close = vi.fn(async () => {});
    const stream = postHandshakeReadable(
      fakeSocket(close),
      fakeReader({ cancel: vi.fn(async () => await cancelPending) }),
      new Uint8Array(0),
    );

    const cancellation = stream.cancel('stop');
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    resolveCancel();
    await cancellation;
  });
});

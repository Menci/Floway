import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFakeDuplex } from './test-utils.ts';
import { CLEANUP_OPERATION_DEADLINE_MS, CleanupTimeoutError } from '../src/cleanup.ts';
import { userspaceTls } from '../src/tls.ts';

interface MockTlsOptions {
  write(record: { header: Uint8Array; content: Uint8Array }): void;
  onHandshake(): void;
  onApplicationData(plaintext: Uint8Array): void;
  onTlsEnd(error?: unknown): void;
}

interface MockTlsClient {
  startHandshake(): Promise<void>;
  handleReceivedBytes(bytes: Uint8Array): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
}

const tlsMock = vi.hoisted(() => ({
  options: null as MockTlsOptions | null,
  client: null as MockTlsClient | null,
  startGate: null as Promise<void> | null,
  startFailure: null as unknown,
  endFailure: null as unknown,
  endWrite: false,
  handledChunks: 0,
  onHandled: null as (() => void) | null,
}));

vi.mock('@reclaimprotocol/tls', () => ({
  setCryptoImplementation: vi.fn(),
  makeTLSClient: vi.fn((options: MockTlsOptions): MockTlsClient => {
    tlsMock.options = options;
    const client: MockTlsClient = {
      async startHandshake() {
        if (tlsMock.startGate) await tlsMock.startGate;
        if (tlsMock.startFailure !== null) throw tlsMock.startFailure;
        options.write({ header: new Uint8Array([0x16]), content: new Uint8Array(0) });
        options.onHandshake();
      },
      async handleReceivedBytes(bytes) {
        tlsMock.handledChunks++;
        for (const byte of bytes) options.onApplicationData(new Uint8Array([byte]));
        tlsMock.onHandled?.();
      },
      async write(bytes) {
        options.write({ header: new Uint8Array([0x17]), content: bytes });
      },
      async end() {
        if (tlsMock.endWrite) options.write({ header: new Uint8Array([0x15]), content: new Uint8Array(0) });
        if (tlsMock.endFailure !== null) throw tlsMock.endFailure;
      },
    };
    tlsMock.client = client;
    return client;
  }),
}));

const makeTransport = (write?: (chunk: Uint8Array) => void | Promise<void>) => {
  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) { readableController = controller; },
  });
  const writes: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      writes.push(new Uint8Array(chunk));
      await write?.(chunk);
    },
  });
  return { readable, writable, readableController, writes };
};

beforeEach(() => {
  tlsMock.options = null;
  tlsMock.client = null;
  tlsMock.startGate = null;
  tlsMock.startFailure = null;
  tlsMock.endFailure = null;
  tlsMock.endWrite = false;
  tlsMock.handledChunks = 0;
  tlsMock.onHandled = null;
});

afterEach(() => vi.useRealTimers());

describe('userspaceTls lifecycle', () => {
  it('does not resolve the handshake before the ClientHello transport write settles', async () => {
    let resolveWrite!: () => void;
    let writeStartedResolve!: () => void;
    const writeStarted = new Promise<void>(resolve => { writeStartedResolve = resolve; });
    const writeDone = new Promise<void>(resolve => { resolveWrite = resolve; });
    const transport = makeTransport(async () => {
      writeStartedResolve();
      await writeDone;
    });

    let resolved = false;
    const handshake = userspaceTls(transport, { host: 'example.com' });
    void handshake.then(() => { resolved = true; });
    await writeStarted;
    expect(resolved).toBe(false);
    resolveWrite();
    const tls = await handshake;
    await tls.readable.cancel();
  });

  it('snapshots prefix bytes before an asynchronous ClientHello build', async () => {
    let releaseStart!: () => void;
    tlsMock.startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    const prefix = new Uint8Array([0xde, 0xad]);
    const transport = makeTransport();
    const handshake = userspaceTls(transport, { host: 'example.com', prefix });
    prefix.fill(0);
    releaseStart();
    const tls = await handshake;
    expect(transport.writes[0]).toEqual(new Uint8Array([0xde, 0xad, 0x16]));
    await tls.readable.cancel();
  });

  it('does not consume another transport chunk until plaintext demand returns', async () => {
    const transport = makeTransport();
    const tls = await userspaceTls(transport, { host: 'example.com' });
    let firstHandledResolve!: () => void;
    const firstHandled = new Promise<void>(resolve => { firstHandledResolve = resolve; });
    tlsMock.onHandled = firstHandledResolve;
    transport.readableController.enqueue(new Uint8Array([1]));
    transport.readableController.enqueue(new Uint8Array([2]));
    await firstHandled;
    expect(tlsMock.handledChunks).toBe(1);

    let secondHandledResolve!: () => void;
    const secondHandled = new Promise<void>(resolve => { secondHandledResolve = resolve; });
    tlsMock.onHandled = secondHandledResolve;
    const reader = tls.readable.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    await secondHandled;
    expect(tlsMock.handledChunks).toBe(2);
    await reader.cancel();
  });

  it('preserves a falsy TLS failure and releases the transport writer', async () => {
    const transport = makeTransport();
    const tls = await userspaceTls(transport, { host: 'example.com' });
    tlsMock.options!.onTlsEnd(false);
    let rejection: unknown = Symbol('not rejected');
    try { await tls.readable.getReader().read(); } catch (error) { rejection = error; }
    expect(rejection).toBe(false);
    await Promise.resolve();
    expect(transport.writable.locked).toBe(false);
  });

  it('keeps a handshake failure primary while reporting reader and writer cleanup failures', async () => {
    const primary = new Error('handshake failed');
    const cancelError = new Error('reader cancel failed');
    const abortError = new Error('writer abort failed');
    tlsMock.startFailure = primary;
    const transport = makeFakeDuplex({
      readableCancel: async () => { throw cancelError; },
      writableAbort: async () => { throw abortError; },
    });

    const rejection = await userspaceTls(transport, { host: 'example.com' })
      .catch((error: unknown) => error) as AggregateError;
    expect(rejection.errors).toEqual([primary, cancelError, abortError]);
    expect(rejection.cause).toBe(primary);
    expect(transport.readable.locked).toBe(false);
    expect(transport.writable.locked).toBe(false);
  });

  it('aborts a never-settling handshake without waiting for startHandshake', async () => {
    tlsMock.startGate = new Promise<void>(() => {});
    const transport = makeFakeDuplex();
    const controller = new AbortController();
    const reason = new DOMException('stop', 'AbortError');
    const handshake = userspaceTls(transport, { host: 'example.com', signal: controller.signal });
    await Promise.resolve();

    controller.abort(reason);
    const outcome = await Promise.race([
      handshake.then(() => 'resolved' as const, error => error),
      new Promise<'turn-expired'>(resolve => setTimeout(() => resolve('turn-expired'), 0)),
    ]);
    expect(outcome).toBe(reason);
    expect(transport.readable.locked).toBe(false);
    expect(transport.writable.locked).toBe(false);
  });

  it('rejects raw EOF before a never-settling handshake completes', async () => {
    tlsMock.startGate = new Promise<void>(() => {});
    const transport = makeFakeDuplex();
    const handshake = userspaceTls(transport, { host: 'example.com' });
    await Promise.resolve();

    transport.endResponse();
    const outcome = await Promise.race([
      handshake.then(() => 'resolved' as const, error => error),
      new Promise<'turn-expired'>(resolve => setTimeout(() => resolve('turn-expired'), 0)),
    ]);
    expect(outcome).toMatchObject({ message: 'TLS ended before handshake' });
    expect(transport.readable.locked).toBe(false);
    expect(transport.writable.locked).toBe(false);
  });

  it('keeps a post-handshake TLS failure primary through reader and writer cleanup failures', async () => {
    const primary = new Error('TLS failed');
    const cancelError = new Error('reader cancel failed');
    const abortError = new Error('writer abort failed');
    const transport = makeFakeDuplex({
      readableCancel: async () => { throw cancelError; },
      writableAbort: async () => { throw abortError; },
    });
    const tls = await userspaceTls(transport, { host: 'example.com' });
    const pendingRead = tls.readable.getReader().read().catch((error: unknown) => error);

    tlsMock.options!.onTlsEnd(primary);
    const rejection = await pendingRead as AggregateError;
    expect(rejection.errors).toEqual([primary, cancelError, abortError]);
    expect(rejection.cause).toBe(primary);
  });

  it('reports clean EOF cleanup failures without inventing a primary', async () => {
    const endError = new Error('TLS end failed');
    const closeError = new Error('writer close failed');
    tlsMock.endFailure = endError;
    const transport = makeFakeDuplex({ writableClose: async () => { throw closeError; } });
    const tls = await userspaceTls(transport, { host: 'example.com' });
    const pendingRead = tls.readable.getReader().read().catch((error: unknown) => error);

    transport.endResponse();
    const rejection = await pendingRead as AggregateError;
    expect(rejection.errors).toEqual([endError, closeError]);
    expect(rejection.cause).toBe(endError);
  });

  it('rejects readable cancellation with cleanup failures only', async () => {
    const endError = new Error('TLS end failed');
    const cancelError = new Error('reader cancel failed');
    const abortError = new Error('writer abort failed');
    tlsMock.endFailure = endError;
    const transport = makeFakeDuplex({
      readableCancel: async () => { throw cancelError; },
      writableAbort: async () => { throw abortError; },
    });
    const tls = await userspaceTls(transport, { host: 'example.com' });

    const rejection = await tls.readable.cancel(new Error('consumer reason'))
      .catch((error: unknown) => error) as AggregateError;
    expect(rejection.errors).toEqual([endError, cancelError, abortError]);
    expect(rejection.cause).toBe(endError);
  });

  it('surfaces a queued transport write failure during writable abort without an unhandled rejection', async () => {
    const writeError = new Error('close record write failed');
    tlsMock.endWrite = true;
    const transport = makeFakeDuplex({
      writableWrite: async index => { if (index === 1) throw writeError; },
    });
    const tls = await userspaceTls(transport, { host: 'example.com' });

    await expect(tls.writable.abort('stop')).rejects.toBe(writeError);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(transport.readable.locked).toBe(false);
    expect(transport.writable.locked).toBe(false);
  });

  it('bounds never-settling reader cancel and writer close while starting both immediately', async () => {
    const cancel = vi.fn(async () => await new Promise<void>(() => {}));
    const close = vi.fn(async () => await new Promise<void>(() => {}));
    const transport = makeFakeDuplex({
      readableCancel: cancel,
      writableClose: close,
    });
    const tls = await userspaceTls(transport, { host: 'example.com' });
    vi.useFakeTimers();

    const cancellation = tls.readable.cancel('stop').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CLEANUP_OPERATION_DEADLINE_MS);
    const rejection = await cancellation as AggregateError;
    expect(rejection.errors).toHaveLength(2);
    expect(rejection.errors.every(error => error instanceof CleanupTimeoutError)).toBe(true);
    expect(rejection.cause).toBe(rejection.errors[0]);
    expect(transport.readable.locked).toBe(false);
    expect(transport.writable.locked).toBe(false);
  });
});

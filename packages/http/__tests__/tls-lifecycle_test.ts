import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      async end() {},
    };
    tlsMock.client = client;
    return client;
  }),
}));

import { userspaceTls } from '../src/tls.ts';

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
  tlsMock.handledChunks = 0;
  tlsMock.onHandled = null;
});

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
});

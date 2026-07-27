// In-memory `SocketDial` for protocol wire-byte tests.
//
// The dialer sees a duplex byte stream; the test sees the inverse pair —
// `read(n)` consumes exactly the bytes the dialer just wrote, and `respond`
// enqueues bytes the dialer's reader will pull. Tests assert on exact byte
// sequences and feed crafted server responses (including malformed framing)
// to exercise dial-side error handling.

import type { DialedSocket, SocketDial } from '../../src/types.ts';

export interface FakeServer {
  /**
   * Resolves once the dialer has written at least `n` bytes; consumes them
   * from the buffer and returns them. Throws if the dialer-side writable
   * closes before `n` bytes have arrived.
   */
  read(n: number): Promise<Uint8Array>;
  /** Returns all bytes the dialer wrote so far without removing them. */
  peekWritten(): Uint8Array;
  /** Push bytes into the dialer's readable. */
  respond(bytes: Uint8Array | string): void;
  /** Close the dialer's readable (server EOF). */
  endResponse(): void;
}

export interface FakeSocketDial {
  socketDial: SocketDial;
  /** Awaits the next connect call (or the first if not yet observed). */
  awaitConnect(): Promise<FakeServer>;
  /** Throw when the dialer connects, simulating a TCP-level failure. */
  failNextConnect(err: unknown): void;
  connectCount(): number;
}

export const makeFakeSocketDial = (): FakeSocketDial => {
  let server: FakeServer | null = null;
  let resolveServer: ((s: FakeServer) => void) | null = null;
  const serverReady = new Promise<FakeServer>(resolve => { resolveServer = resolve; });

  let pendingConnectError: unknown = null;
  let connectCount = 0;

  const socketDial: SocketDial = {
    connect: async () => {
      connectCount++;
      if (pendingConnectError) {
        const err = pendingConnectError;
        pendingConnectError = null;
        throw err;
      }
      const { socket, srv } = makeFakeSocket();
      server = srv;
      resolveServer?.(srv);
      resolveServer = null;
      return socket;
    },
  };

  return {
    socketDial,
    awaitConnect: async () => server ?? await serverReady,
    failNextConnect: err => { pendingConnectError = err; },
    connectCount: () => connectCount,
  };
};

const makeFakeSocket = (): { socket: DialedSocket; srv: FakeServer } => {
  let writeBuffer = new Uint8Array(0);
  let writableClosed = false;
  const readWaiters: Array<{ n: number; resolve: (v: Uint8Array) => void; reject: (e: unknown) => void }> = [];

  const tryDispatchReads = (): void => {
    while (readWaiters.length && writeBuffer.byteLength >= readWaiters[0]!.n) {
      const w = readWaiters.shift()!;
      const chunk = writeBuffer.subarray(0, w.n);
      writeBuffer = writeBuffer.subarray(w.n);
      w.resolve(new Uint8Array(chunk));
    }
    if (writableClosed) {
      while (readWaiters.length) {
        const w = readWaiters.shift()!;
        w.reject(new Error(
          `fake server: dialer closed writable with only ${writeBuffer.byteLength} bytes buffered, want ${w.n}`,
        ));
      }
    }
  };

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      const next = new Uint8Array(writeBuffer.byteLength + chunk.byteLength);
      next.set(writeBuffer, 0);
      next.set(chunk, writeBuffer.byteLength);
      writeBuffer = next;
      tryDispatchReads();
    },
    close() {
      writableClosed = true;
      tryDispatchReads();
    },
    abort() {
      writableClosed = true;
      tryDispatchReads();
    },
  });

  let readableController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) { readableController = c; },
  });

  const enc = new TextEncoder();

  const srv: FakeServer = {
    read(n) {
      if (n <= 0) return Promise.resolve(new Uint8Array(0));
      if (writeBuffer.byteLength >= n) {
        const chunk = writeBuffer.subarray(0, n);
        writeBuffer = writeBuffer.subarray(n);
        return Promise.resolve(new Uint8Array(chunk));
      }
      if (writableClosed) {
        return Promise.reject(new Error(
          `fake server: dialer already closed writable with ${writeBuffer.byteLength} bytes buffered, want ${n}`,
        ));
      }
      return new Promise<Uint8Array>((resolve, reject) => {
        readWaiters.push({ n, resolve, reject });
      });
    },
    peekWritten: () => new Uint8Array(writeBuffer),
    respond(bytes) {
      const u = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
      readableController.enqueue(new Uint8Array(u));
    },
    endResponse() { readableController.close(); },
  };

  let closed = false;
  const socket: DialedSocket = {
    readable,
    writable,
    close: async () => {
      if (closed) return;
      closed = true;
      try { readableController.close(); } catch { /* already closed */ }
    },
  };

  return { socket, srv };
};

// Helper duplex for HTTP-layer tests.
//
// Pairs a duplex that the HTTP layer reads/writes against with a server-side
// handle for asserting on emitted bytes and feeding crafted server responses
// (chunked, malformed, CL+TE smuggling vectors, …).

export interface FakeDuplex {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;

  written(): Uint8Array;
  waitForWritten(minBytes: number): Promise<Uint8Array>;
  waitWritableClosed(): Promise<void>;

  respond(bytes: Uint8Array | string): void;
  failResponse(reason: unknown): void;
  /** Close the readable (server EOF). */
  endResponse(): void;
}

export interface FakeDuplexHooks {
  readonly readableCancel?: (reason: unknown) => void | Promise<void>;
  readonly writableWrite?: (index: number, chunk: Uint8Array) => void | Promise<void>;
  readonly writableClose?: () => void | Promise<void>;
  readonly writableAbort?: (reason: unknown) => void | Promise<void>;
}

export const makeFakeDuplex = (hooks: FakeDuplexHooks = {}): FakeDuplex => {
  let writeBuffer = new Uint8Array(0);
  const writeWaiters: Array<{
    minBytes: number;
    resolve: (bytes: Uint8Array) => void;
  }> = [];
  const dispatchWriteWaiters = (): void => {
    for (let i = writeWaiters.length - 1; i >= 0; i--) {
      const waiter = writeWaiters[i]!;
      if (writeBuffer.byteLength < waiter.minBytes) continue;
      writeWaiters.splice(i, 1);
      waiter.resolve(new Uint8Array(writeBuffer));
    }
  };
  let writableClosedResolve!: () => void;
  const writableClosedPromise = new Promise<void>(r => { writableClosedResolve = r; });

  let writeIndex = 0;
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      await hooks.writableWrite?.(writeIndex++, chunk);
      const next = new Uint8Array(writeBuffer.byteLength + chunk.byteLength);
      next.set(writeBuffer, 0);
      next.set(chunk, writeBuffer.byteLength);
      writeBuffer = next;
      dispatchWriteWaiters();
    },
    async close() {
      writableClosedResolve();
      await hooks.writableClose?.();
    },
    async abort(reason) {
      writableClosedResolve();
      await hooks.writableAbort?.(reason);
    },
  });

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    async cancel(reason) { await hooks.readableCancel?.(reason); },
  });

  const enc = new TextEncoder();

  return {
    readable,
    writable,
    written: () => new Uint8Array(writeBuffer),
    waitForWritten(minBytes) {
      if (writeBuffer.byteLength >= minBytes) {
        return Promise.resolve(new Uint8Array(writeBuffer));
      }
      return new Promise(resolve => { writeWaiters.push({ minBytes, resolve }); });
    },
    waitWritableClosed: () => writableClosedPromise,
    respond(bytes) {
      const u = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
      controller.enqueue(new Uint8Array(u));
    },
    failResponse(reason) { controller.error(reason); },
    endResponse() { controller.close(); },
  };
};

/** Feed `head` to a fresh fake duplex, EOF the server side, and return the
 *  readable for the parser tests to consume in one shot. */
export const respondAndEnd = (head: string): ReadableStream<Uint8Array> => {
  const fake = makeFakeDuplex();
  fake.respond(head);
  fake.endResponse();
  return fake.readable;
};

export const collectBody = async (resp: { body: ReadableStream<Uint8Array> } | Response): Promise<string> => {
  if (resp instanceof Response) {
    const buf = await resp.arrayBuffer();
    return new TextDecoder().decode(buf);
  }
  const buf = await collectBodyBytes(resp);
  return new TextDecoder().decode(buf);
};

export const collectBodyBytes = async (resp: { body: ReadableStream<Uint8Array> }): Promise<Uint8Array> => {
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
};

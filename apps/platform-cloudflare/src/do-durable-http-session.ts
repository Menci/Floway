import type {
  DurableHttpSessionStartInit,
  DurableHttpSessionStartResult,
} from './durable-http-session-do.ts';
import type {
  DurableHttpSession,
  DurableHttpSessionAcquireOptions,
  DurableHttpSessionHandle,
  DurableHttpSessionInit,
} from '@floway-dev/platform';

// CF implementation of the DurableHttpSession contract, mirroring the
// DurableObjectChannelBroker shape: resolve a per-sessionKey DO stub, then
// drive it over RPC + a WebSocket body channel. The DO holds the live outbound
// RunSSE response; this broker exposes it as the contract's ReadableStream.

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// One credit = "send me the next chunk". The broker sends exactly one per
// ReadableStream pull; the DO treats any inbound message as a credit and ignores
// the content, so a 1-byte sentinel is enough.
const CREDIT_BYTE = new Uint8Array([1]);

// Minimal namespace/stub surface — declared locally so this file stays off
// `@cloudflare/workers-types` (same convention as do-channel-broker.ts).
export interface DurableHttpSessionNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableHttpSessionStub;
}

interface DurableHttpSessionStub {
  queryOrStart(
    init: DurableHttpSessionStartInit | null,
    idleTimeoutMs: number,
  ): Promise<DurableHttpSessionStartResult | null>;
  release(): Promise<void>;
  discard(reason: string): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

export class DurableObjectDurableHttpSession implements DurableHttpSession {
  constructor(private readonly namespace: DurableHttpSessionNamespace) {}

  private stub(sessionKey: string): DurableHttpSessionStub {
    return this.namespace.get(this.namespace.idFromName(sessionKey));
  }

  async acquire(
    sessionKey: string,
    init: DurableHttpSessionInit | null,
    opts?: DurableHttpSessionAcquireOptions,
  ): Promise<DurableHttpSessionHandle | null> {
    const stub = this.stub(sessionKey);
    const idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    const meta = await stub.queryOrStart(init, idleTimeoutMs);
    if (!meta) return null; // miss + init=null → caller degrades

    const wsResponse = await stub.fetch(new Request('https://durable-http.do/body', {
      headers: { Upgrade: 'websocket' },
    }));
    if (wsResponse.status !== 101) {
      throw new Error(`DurableHttpSessionDO body upgrade returned HTTP ${wsResponse.status} instead of 101`);
    }
    const socket = (wsResponse as Response & { webSocket?: WebSocket }).webSocket;
    if (!socket) throw new Error('DurableHttpSessionDO returned 101 without a webSocket');
    socket.accept();

    const body = wsToByteStream(socket, opts?.signal);

    return {
      status: meta.status,
      headers: new Headers(meta.headers),
      body,
      async release(): Promise<void> {
        try { socket.close(1000, 'released'); } catch { /* already closed */ }
        await stub.release();
      },
      async discard(reason: string): Promise<void> {
        try { socket.close(1000, 'discarded'); } catch { /* already closed */ }
        await stub.discard(reason);
      },
    };
  }
}

// Wrap the body WebSocket as a ReadableStream<Uint8Array>. Binary frames are
// the body bytes; a close ends the stream; an error rejects the pending read.
// Aborting the caller signal closes the socket and ends the stream — it does
// NOT discard the DO session (sibling acquires keep working), matching the
// contract's signal semantics.
const wsToByteStream = (
  socket: WebSocket,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> => {
  // Head-index cursor over a push-only array so a burst that queues dozens of
  // chunks before the consumer resumes doesn't pay O(n) per delivered chunk.
  const queue: Uint8Array[] = [];
  let queueHead = 0;
  let pull: ((v: { value?: Uint8Array; done: boolean }) => void) | null = null;
  let pendingError: unknown = null;
  let closed = false;

  const deliver = (chunk: Uint8Array | null): void => {
    if (pull) {
      const r = pull;
      pull = null;
      r(chunk ? { value: chunk, done: false } : { done: true });
    } else if (chunk) {
      queue.push(chunk);
    }
  };

  const end = (): void => {
    if (closed) return;
    closed = true;
    deliver(null);
    try { socket.close(1000, 'consumer done'); } catch { /* already closed */ }
  };

  socket.addEventListener('message', event => {
    if (closed) return;
    const raw = (event as MessageEvent).data as string | ArrayBuffer | Uint8Array;
    let bytes: Uint8Array;
    if (typeof raw === 'string') bytes = new TextEncoder().encode(raw);
    else if (raw instanceof Uint8Array) bytes = raw;
    else bytes = new Uint8Array(raw);
    deliver(bytes);
  });
  socket.addEventListener('close', () => { closed = true; deliver(null); });
  socket.addEventListener('error', () => {
    if (pendingError === null) pendingError = new Error('DurableHttpSession body socket error');
    closed = true;
    deliver(null);
  });

  if (signal) {
    if (signal.aborted) end();
    else signal.addEventListener('abort', end, { once: true });
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (queueHead < queue.length) {
        controller.enqueue(queue[queueHead]!);
        queueHead += 1;
        if (queueHead >= queue.length) {
          queue.length = 0;
          queueHead = 0;
        }
        return;
      }
      if (closed) {
        if (pendingError) { controller.error(pendingError); return; }
        controller.close();
        return;
      }
      // Credit-based backpressure: request exactly one chunk, then wait for it.
      // With highWaterMark 0 the stream only pulls on an active read, so a
      // consumer that pauses (transport parked at exec_mcp) sends no credit and
      // the DO holds subsequent chunks in its buffer for the next acquire.
      try { socket.send(CREDIT_BYTE); } catch { controller.close(); return; }
      const result = await new Promise<{ value?: Uint8Array; done: boolean }>(resolve => { pull = resolve; });
      if (result.done) {
        if (pendingError) controller.error(pendingError);
        else controller.close();
        return;
      }
      if (result.value) controller.enqueue(result.value);
    },
    cancel(): void { end(); },
  }, { highWaterMark: 0 });
};

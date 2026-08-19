import type { LogStream, LogStreamStore } from '@floway-dev/platform';

// The binding to `LogStreamDO`. Appends and `end()` are RPC; a read is the object's
// hibernatable WebSocket, and the close code is what says which of the two outcomes a read
// had. `1000` after the object drained means the stream ended; `1006` — which is what both a
// memory reset and a deployment produce, measured — means it did not.
//
// A browser never sees this hop. It talks to a Worker over the framed HTTP body, and the
// Worker holds this socket. Keeping the Worker in the middle costs almost nothing, since
// Workers bill CPU time rather than wall clock.

// Minimal namespace surface, declared locally so this file stays off
// `@cloudflare/workers-types`.
export interface LogStreamNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): LogStreamStub;
}

interface LogStreamStub {
  append(atOffset: number, bytes: ArrayBuffer): Promise<void>;
  end(): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

export class DurableObjectLogStreamStore implements LogStreamStore {
  constructor(private readonly namespace: LogStreamNamespace) {}

  open(streamId: string): LogStream {
    return new DurableObjectLogStream(() => this.namespace.get(this.namespace.idFromName(streamId)));
  }
}

class DurableObjectLogStream implements LogStream {
  // A stub obtained fresh per call, because the old one stays broken after an error and the
  // writer's retry has to reach a working one.
  constructor(private readonly stub: () => LogStreamStub) {}

  async append(atOffset: number, bytes: Uint8Array): Promise<void> {
    // Awaited so backpressure reaches the writer: an unbounded pile of un-awaited writes is
    // the one documented way to grow the storage buffer without limit.
    await this.stub().append(atOffset, bytes.slice().buffer as ArrayBuffer);
  }

  async end(): Promise<void> {
    await this.stub().end();
  }

  read(fromOffset: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const stub = this.stub();
    return {
      async *[Symbol.asyncIterator]() {
        const response = await stub.fetch(new Request(`https://log-stream/read?fromOffset=${fromOffset}`, {
          headers: { upgrade: 'websocket' },
        }));
        const socket = response.webSocket;
        if (!socket) throw new Error('LogStream read did not upgrade to a WebSocket');
        socket.accept();

        const queue: Uint8Array[] = [];
        let wake: (() => void) | null = null;
        let outcome: 'open' | 'ended' | 'interrupted' = 'open';
        const settle = (next: 'ended' | 'interrupted') => {
          if (outcome === 'open') outcome = next;
          wake?.();
        };

        socket.addEventListener('message', event => {
          const data = event.data;
          queue.push(typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer));
          wake?.();
        });
        socket.addEventListener('close', event => { settle(event.code === 1000 ? 'ended' : 'interrupted'); });
        socket.addEventListener('error', () => { settle('interrupted'); });
        signal.addEventListener('abort', () => { settle('interrupted'); }, { once: true });

        try {
          while (true) {
            while (queue.length > 0) yield queue.shift()!;
            if (outcome !== 'open') break;
            await new Promise<void>(resolve => { wake = resolve; });
            wake = null;
          }
          // Drain whatever landed alongside the close before deciding.
          while (queue.length > 0) yield queue.shift()!;
          if (outcome === 'interrupted') throw new Error('LogStream read was interrupted');
        } finally {
          try {
            socket.close();
          } catch {
            // Already closed by the object or by the runtime; nothing to undo.
          }
        }
      },
    };
  }
}

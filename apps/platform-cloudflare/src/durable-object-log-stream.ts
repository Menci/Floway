import type { LogStreamStub } from './log-stream-contract.ts';
import { LogStreamEndedError, LogStreamExpiredError, LogStreamHoleError, type LogStream, type LogStreamStore } from '@floway-dev/platform';

export interface LogStreamNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): LogStreamStub;
}

export class DurableObjectLogStreamStore implements LogStreamStore {
  constructor(private readonly namespace: LogStreamNamespace) {}

  async open(streamId: string): Promise<LogStream> {
    const stream = this.stream(streamId);
    await stream.open();
    return stream;
  }

  async get(streamId: string): Promise<LogStream | null> {
    const stream = this.stream(streamId);
    return await stream.exists() ? stream : null;
  }

  private stream(streamId: string): DurableObjectLogStream {
    return new DurableObjectLogStream(() => this.namespace.get(this.namespace.idFromName(streamId)));
  }
}

class DurableObjectLogStream implements LogStream {
  // Each operation obtains a fresh stub because an RPC error breaks that stub.
  constructor(private readonly stub: () => LogStreamStub) {}

  async open(): Promise<void> { await this.stub().open(); }
  async exists(): Promise<boolean> { return await this.stub().exists(); }

  async append(atOffset: number, bytes: Uint8Array): Promise<void> {
    const result = await this.stub().append(atOffset, bytes.slice().buffer as ArrayBuffer);
    if (result.kind === 'hole') throw new LogStreamHoleError(atOffset, result.length);
    if (result.kind === 'ended') throw new LogStreamEndedError();
    if (result.kind === 'expired') throw new LogStreamExpiredError();
  }

  async end(): Promise<void> {
    if (await this.stub().end() === 'expired') throw new LogStreamExpiredError();
  }

  read(fromOffset: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const stream = this;
    return {
      async *[Symbol.asyncIterator]() {
        signal.throwIfAborted();
        const response = await stream.stub().fetch(new Request(`https://log-stream/read?fromOffset=${fromOffset}`, {
          headers: { upgrade: 'websocket' },
        }));
        if (response.status === 404) throw new LogStreamExpiredError();
        const socket = response.webSocket;
        if (!socket) throw new Error('LogStream read did not upgrade to a WebSocket');
        socket.accept();
        const queue: Uint8Array[] = [];
        let wake: (() => void) | null = null;
        let outcome: 'open' | 'ended' | 'interrupted' | 'expired' = 'open';
        const settle = (next: 'ended' | 'interrupted' | 'expired') => {
          if (outcome === 'open') outcome = next;
          wake?.();
        };
        const interrupt = () => { settle('interrupted'); };
        socket.addEventListener('message', event => {
          queue.push(new Uint8Array(event.data as ArrayBuffer));
          wake?.();
        });
        socket.addEventListener('close', event => {
          settle(event.code === 1000 ? 'ended' : event.code === 1012 && event.reason === 'expired' ? 'expired' : 'interrupted');
        });
        socket.addEventListener('error', interrupt);
        signal.addEventListener('abort', interrupt, { once: true });
        if (signal.aborted) interrupt();
        try {
          for (;;) {
            signal.throwIfAborted();
            while (queue.length > 0) { signal.throwIfAborted(); yield queue.shift()!; }
            if (outcome !== 'open') break;
            await new Promise<void>(resolve => { wake = resolve; });
            wake = null;
          }
          if (outcome === 'expired') throw new LogStreamExpiredError();
          if (outcome === 'interrupted') throw new Error('LogStream read was interrupted');
        } finally {
          signal.removeEventListener('abort', interrupt);
          socket.close();
        }
      },
    };
  }
}

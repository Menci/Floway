import type { LogStreamStub } from './log-stream-contract.ts';
import {
  LogStreamEndedError,
  LogStreamExpiredError,
  LogStreamHoleError,
  type LogStream,
  type LogStreamStore,
} from '@floway-dev/platform';

export interface LogStreamNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): LogStreamStub;
}

export class DurableObjectLogStreamStore implements LogStreamStore {
  constructor(private readonly namespace: LogStreamNamespace) {}

  async open(streamId: string): Promise<LogStream> {
    const stream = this.createStream(streamId);
    await stream.open();
    return stream;
  }

  async get(streamId: string): Promise<LogStream | null> {
    const stream = this.createStream(streamId);
    return await stream.exists() ? stream : null;
  }

  private createStream(streamId: string): DurableObjectLogStream {
    return new DurableObjectLogStream(() => this.namespace.get(this.namespace.idFromName(streamId)));
  }
}

const assertOffset = (offset: number, name: string): void => {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
};

class DurableObjectLogStream implements LogStream {
  // An RPC failure breaks its stub, so every operation asks for a fresh one.
  constructor(private readonly stub: () => LogStreamStub) {}

  async open(): Promise<void> {
    await this.stub().open();
  }

  async exists(): Promise<boolean> {
    return await this.stub().exists();
  }

  async append(atOffset: number, bytes: Uint8Array): Promise<void> {
    assertOffset(atOffset, 'LogStream append offset');
    const result = await this.stub().append(atOffset, bytes.slice().buffer as ArrayBuffer);
    switch (result.kind) {
    case 'appended':
      return;
    case 'hole':
      throw new LogStreamHoleError(atOffset, result.length);
    case 'ended':
      throw new LogStreamEndedError();
    case 'expired':
      throw new LogStreamExpiredError();
    }
  }

  async end(): Promise<void> {
    if (await this.stub().end() === 'expired') throw new LogStreamExpiredError();
  }

  read(fromOffset: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
    assertOffset(fromOffset, 'LogStream read offset');
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

        let revision = 0;
        let wake: (() => void) | null = null;
        let outcome: 'open' | 'ended' | 'interrupted' | 'expired' = 'open';
        const currentOutcome = (): typeof outcome => outcome;
        const settle = (next: Exclude<typeof outcome, 'open'>): void => {
          if (outcome === 'open') outcome = next;
          wake?.();
        };
        const interrupt = (): void => { settle('interrupted'); };

        socket.addEventListener('message', () => {
          revision++;
          wake?.();
        });
        socket.addEventListener('close', event => {
          settle(event.code === 1000 ? 'ended' : event.code === 1012 && event.reason === 'expired' ? 'expired' : 'interrupted');
          wake?.();
        });
        socket.addEventListener('error', interrupt);
        signal.addEventListener('abort', interrupt, { once: true });
        if (signal.aborted) interrupt();

        let offset = fromOffset;
        try {
          for (;;) {
            signal.throwIfAborted();
            if (currentOutcome() === 'expired') throw new LogStreamExpiredError();
            if (currentOutcome() === 'interrupted') throw new Error('LogStream read was interrupted');

            const observedRevision = revision;
            const result = await stream.stub().readChunk(offset);
            signal.throwIfAborted();
            if (result.kind === 'expired') throw new LogStreamExpiredError();
            if (result.kind === 'chunk') {
              const bytes = new Uint8Array(result.bytes);
              offset += bytes.byteLength;
              yield bytes;
              continue;
            }
            if (result.ended) return;
            if (revision !== observedRevision || outcome !== 'open') continue;

            await new Promise<void>(resolve => { wake = resolve; });
            wake = null;
          }
        } finally {
          signal.removeEventListener('abort', interrupt);
          socket.close();
        }
      },
    };
  }
}

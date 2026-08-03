import { act } from '@testing-library/react';
import { afterEach, beforeEach, expect } from 'vitest';

import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

export const record = (id: string): DumpMetadata => ({
  id,
  startedAt: 0,
  completedAt: 0,
  method: 'POST',
  path: `/v1/${id}`,
  status: 200,
  upstream: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 0,
  error: null,
});

export interface Lifecycle { event: 'open' | 'close'; keyId: string }

class StubEventSource {
  static readonly CLOSED = 2;

  readyState = 1;
  private readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(readonly url: string, private readonly stub: EventSourceStub) {
    stub.sources.push(this);
    stub.lifecycle.push({ event: 'open', keyId: this.keyId });
  }

  get keyId(): string {
    return decodeURIComponent(new URL(this.url, 'https://dashboard.test').pathname.split('/')[4] ?? '');
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    if (this.readyState === StubEventSource.CLOSED) return;
    this.readyState = StubEventSource.CLOSED;
    this.stub.lifecycle.push({ event: 'close', keyId: this.keyId });
  }

  emit(type: string, data: string): void {
    act(() => {
      this.listeners.get(type)?.forEach(listener => { listener(new MessageEvent(type, { data })); });
    });
  }

  // A transport-level drop, as opposed to an error the server sent: the browser
  // has already given up on the connection by the time the event arrives, so
  // the state moves before the listeners run and the event carries no data.
  drop(): void {
    this.close();
    this.emit('error', '');
  }
}

export interface EventSourceStub {
  readonly sources: StubEventSource[];
  readonly lifecycle: Lifecycle[];
  readonly closed: number;
  liveSource: () => StubEventSource;
}

// happy-dom ships no `EventSource`, and a suite about the dump stream is a
// suite about when that object is constructed and closed, so the stub records
// its own lifecycle rather than only carrying events.
export const stubEventSource = (): EventSourceStub => {
  const sources: StubEventSource[] = [];
  const lifecycle: Lifecycle[] = [];
  const original = Reflect.getOwnPropertyDescriptor(globalThis, 'EventSource');
  const stub: EventSourceStub = {
    sources,
    lifecycle,
    get closed() { return sources.filter(source => source.readyState === StubEventSource.CLOSED).length; },
    liveSource: () => {
      const open = sources.filter(source => source.readyState !== StubEventSource.CLOSED);
      expect(open).toHaveLength(1);
      return open[0]!;
    },
  };

  beforeEach(() => {
    sources.length = 0;
    lifecycle.length = 0;
    Object.defineProperty(globalThis, 'EventSource', {
      configurable: true,
      writable: true,
      value: class extends StubEventSource {
        constructor(url: string) {
          super(url, stub);
        }
      },
    });
  });

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'EventSource', original);
    else Reflect.deleteProperty(globalThis, 'EventSource');
  });

  return stub;
};

export const eventSourceClosed = StubEventSource.CLOSED;

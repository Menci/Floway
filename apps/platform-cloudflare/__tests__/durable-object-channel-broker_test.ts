import { test } from 'vitest';

import { DurableObjectChannelBroker, type ExecutionDurableObjectNamespace } from '../src/durable-object-channel-broker.ts';
import type { ChannelCodec } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

// Identity string codec: every test below drives the generic broker through
// it, so the broker's typing flows without any reference to a higher-level
// payload shape.
const stringCodec: ChannelCodec<string> = {
  encode: value => value,
  decode: payload => payload,
};

class FakeServerSocket {
  readonly listeners = new Map<string, Set<(e: Event) => void>>();
  closed: { code: number; reason: string } | null = null;
  sent: string[] = [];

  addEventListener(type: string, fn: (e: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  accept(): void { /* noop */ }
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = { code, reason };
    // workerd emits the 'close' event asynchronously after close() returns;
    // mirror that here so subscribers can't observe a synchronous close.
    queueMicrotask(() => this.emit('close', new Event('close')));
  }
  send(data: string): void { this.sent.push(data); }
  emit(type: string, event: Event): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

const buildNamespace = (
  socket: FakeServerSocket,
  broadcasts: string[] = [],
  closeAlls: string[] = [],
  fetches?: { count: number; stubIds?: string[] },
): ExecutionDurableObjectNamespace => ({
  idFromName: name => name,
  get: id => ({
    async fetch(request) {
      if (fetches) {
        fetches.count += 1;
        fetches.stubIds?.push(String(id));
      }
      const url = new URL(request.url);
      if (url.pathname === '/broadcast' && request.method === 'POST') {
        broadcasts.push(await request.text());
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/broadcast/close' && request.method === 'POST') {
        closeAlls.push(await request.text());
        return new Response(null, { status: 204 });
      }
      // Real CF returns 101; Node's `Response` rejects status 101 in its
      // constructor, so synthesise it by overriding `status` after the fact.
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, 'status', { value: 101, configurable: true });
      Object.defineProperty(response, 'webSocket', { value: socket, configurable: true });
      return response;
    },
  }),
});

test('DurableObjectChannelBroker.subscribe drives payloads through the broadcast socket', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  // Let the subscribe coroutine attach its listeners (one microtask is enough).
  await Promise.resolve();
  await Promise.resolve();
  socket.emit('message', new MessageEvent('message', { data: 'hello' }));
  const first = await iter.next();
  assertEquals(first.value, 'hello');

  // Abort alone must end the iterator AND close the upstream socket — without
  // the close, every SSE disconnect would orphan one WS in the DO hibernation
  // registry per subscriber session.
  controller.abort();
  const end = await iter.next();
  assertEquals(end.done, true);
  // Microtask drains the abort handler's openPromise-then-close chain.
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(socket.closed?.code, 1000);
});

test('DurableObjectChannelBroker.subscribe surfaces a server-side socket error by throwing from .next()', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  await Promise.resolve();
  await Promise.resolve();
  socket.emit('error', new Event('error'));

  let caught: unknown = null;
  try {
    await iter.next();
  } catch (err) {
    caught = err;
  }
  assertEquals(caught instanceof Error, true);
});

test('DurableObjectChannelBroker.subscribe closes the socket when the iterator returns', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  await Promise.resolve();
  await Promise.resolve();
  await iter.return?.();

  assertEquals(socket.closed?.code, 1000);
  assertEquals(socket.listeners.get('message')?.size, 0);
  assertEquals(socket.listeners.get('close')?.size, 0);
  assertEquals(socket.listeners.get('error')?.size, 0);
});

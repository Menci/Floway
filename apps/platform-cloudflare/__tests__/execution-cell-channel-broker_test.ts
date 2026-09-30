import { test } from 'vitest';

import { ExecutionCellChannelBroker } from '../src/execution-cell-channel-broker.ts';
import type { ChannelCodec, ExecutionCellNamespace } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

// String codec: encode passes through, decode rejects payloads prefixed with
// `bad:` so the parse-fail path has a deterministic trigger. Every test below
// drives the generic broker through this codec, so the broker's typing flows
// without any reference to a higher-level payload shape.
const stringCodec: ChannelCodec<string> = {
  encode: value => value,
  decode: payload => {
    if (payload.startsWith('bad:')) {
      throw new Error(`stringCodec rejected payload: ${payload}`);
    }
    return payload;
  },
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
  fetches?: { count: number; cellIds?: string[] },
) => {
  const ns: ExecutionCellNamespace = {
    async fetch(cellId, request) {
      if (fetches) {
        fetches.count += 1;
        fetches.cellIds?.push(cellId);
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
  };
  return ns;
};

test('ExecutionCellChannelBroker.subscribe drives payloads through the broadcast socket', async () => {
  const socket = new FakeServerSocket();
  const broker = new ExecutionCellChannelBroker<string>(buildNamespace(socket), stringCodec);
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

test('ExecutionCellChannelBroker.subscribe does not open a socket for an already-aborted signal', async () => {
  const socket = new FakeServerSocket();
  const fetches = { count: 0 };
  const broker = new ExecutionCellChannelBroker<string>(buildNamespace(socket, [], [], fetches), stringCodec);
  const controller = new AbortController();
  controller.abort();

  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  assertEquals((await iter.next()).done, true);
  assertEquals(fetches.count, 0);
  assertEquals(socket.closed, null);
});

test('ExecutionCellChannelBroker.subscribe resolves concurrent reads in socket order', async () => {
  const socket = new FakeServerSocket();
  const broker = new ExecutionCellChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();
  const first = iter.next();
  const second = iter.next();

  await Promise.resolve();
  await Promise.resolve();
  socket.emit('message', new MessageEvent('message', { data: 'a1' }));
  socket.emit('message', new MessageEvent('message', { data: 'a2' }));

  assertEquals((await first).value, 'a1');
  assertEquals((await second).value, 'a2');
  controller.abort();
});

test('ExecutionCellChannelBroker.publish encodes the payload through the codec', async () => {
  const broadcasts: string[] = [];
  const fetches = { count: 0, cellIds: [] as string[] };
  const ns = buildNamespace(new FakeServerSocket(), broadcasts, [], fetches);
  const broker = new ExecutionCellChannelBroker<string>(ns, stringCodec);
  await broker.publish('k', 'frame-a');
  assertEquals(broadcasts.length, 1);
  assertEquals(broadcasts[0], 'frame-a');
  assertEquals(fetches.cellIds, [JSON.stringify(['broadcast', 'k'])]);
});

test('ExecutionCellChannelBroker.closeChannel forwards the reason to the actor', async () => {
  const closeAlls: string[] = [];
  const ns = buildNamespace(new FakeServerSocket(), [], closeAlls);
  const broker = new ExecutionCellChannelBroker<string>(ns, stringCodec);
  await broker.closeChannel('k', 'custom-reason');
  assertEquals(closeAlls.length, 1);
  assertEquals(closeAlls[0], 'custom-reason');
});

test('ExecutionCellChannelBroker.subscribe rejects every pending read when decoding fails', async () => {
  const socket = new FakeServerSocket();
  const broker = new ExecutionCellChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  const first = iter.next();
  const second = iter.next();

  await Promise.resolve();
  await Promise.resolve();
  socket.emit('message', new MessageEvent('message', { data: 'bad:payload' }));

  const results = await Promise.allSettled([first, second]);
  assertEquals(results.map(result => result.status), ['rejected', 'rejected']);
  assertEquals((results[0] as PromiseRejectedResult).reason.message, 'stringCodec rejected payload: bad:payload');
  assertEquals((results[1] as PromiseRejectedResult).reason.message, 'stringCodec rejected payload: bad:payload');
});

test('ExecutionCellChannelBroker.subscribe drains buffered payloads before surfacing a decode failure', async () => {
  const socket = new FakeServerSocket();
  const broker = new ExecutionCellChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  await Promise.resolve();
  await Promise.resolve();
  socket.emit('message', new MessageEvent('message', { data: 'good' }));
  socket.emit('message', new MessageEvent('message', { data: 'bad:payload' }));

  assertEquals((await iter.next()).value, 'good');
  const failed = await Promise.allSettled([iter.next()]);
  assertEquals(failed[0].status, 'rejected');
  assertEquals((failed[0] as PromiseRejectedResult).reason.message, 'stringCodec rejected payload: bad:payload');
});

test('ExecutionCellChannelBroker.subscribe ends the iterator on a server-initiated socket close', async () => {
  const socket = new FakeServerSocket();
  const broker = new ExecutionCellChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  await Promise.resolve();
  await Promise.resolve();
  socket.emit('close', new Event('close'));

  const result = await iter.next();
  assertEquals(result.done, true);
});

test('ExecutionCellChannelBroker.subscribe surfaces a server-side socket error by throwing from .next()', async () => {
  const socket = new FakeServerSocket();
  const broker = new ExecutionCellChannelBroker<string>(buildNamespace(socket), stringCodec);
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
  assertEquals((caught as Error).message, 'ExecutionDO socket error');
});

test('ExecutionCellChannelBroker.subscribe delivers a frame buffered before the first .next() call', async () => {
  const socket = new FakeServerSocket();
  const broker = new ExecutionCellChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  await Promise.resolve();
  await Promise.resolve();
  // Emit BEFORE the first .next(): the broker's eager listener attach must
  // buffer the frame so the first read returns it instead of waiting on a
  // future emit.
  socket.emit('message', new MessageEvent('message', { data: 'pre-buffered' }));
  const first = await iter.next();
  assertEquals(first.value, 'pre-buffered');
});

test('ExecutionCellChannelBroker.subscribe closes the socket when the iterator returns', async () => {
  const socket = new FakeServerSocket();
  const broker = new ExecutionCellChannelBroker<string>(buildNamespace(socket), stringCodec);
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

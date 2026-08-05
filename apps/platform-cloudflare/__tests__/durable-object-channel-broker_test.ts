import { test } from 'vitest';

import { DurableObjectChannelBroker, type BroadcastNamespace } from '../src/durable-object-channel-broker.ts';
import { CHANNEL_SUBSCRIPTION_BUFFER_CAPACITY, type ChannelCodec } from '@floway-dev/platform';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

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
  private readonly closeObservedResolver: () => void;
  readonly closeObserved: Promise<void>;
  closed: { code: number; reason: string } | null = null;
  sent: string[] = [];

  constructor() {
    let resolve!: () => void;
    this.closeObserved = new Promise<void>(done => { resolve = done; });
    this.closeObservedResolver = resolve;
  }

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
    this.closeObservedResolver();
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
  fetches?: { count: number },
  fetchResponse?: () => Promise<Response>,
) => {
  const ns: BroadcastNamespace = {
    idFromName(_name) { return {}; },
    get(_id) {
      return {
        broadcast: async payload => { broadcasts.push(payload); },
        closeAll: async reason => { closeAlls.push(reason); },
        fetch: async () => {
          if (fetches) fetches.count += 1;
          if (fetchResponse) return await fetchResponse();
          // Real CF returns 101; Node's `Response` rejects status 101 in its
          // constructor, so synthesise it by overriding `status` after the
          // fact. The broker only reads `status` and `webSocket`.
          const response = new Response(null, { status: 200 });
          Object.defineProperty(response, 'status', { value: 101, configurable: true });
          Object.defineProperty(response, 'webSocket', { value: socket, configurable: true });
          return response;
        },
      };
    },
  };
  return ns;
};

const closeEvent = (code: number, reason: string): CloseEvent => Object.assign(
  new Event('close'),
  { code, reason, wasClean: false },
) as CloseEvent;

test('DurableObjectChannelBroker.subscribe drives payloads through the broadcast socket', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();

  socket.emit('message', new MessageEvent('message', { data: 'hello' }));
  const first = await iter.next();
  assertEquals(first.value, 'hello');

  // Abort alone must end the iterator AND close the upstream socket — without
  // the close, every SSE disconnect would orphan one WS in the DO hibernation
  // registry per subscriber session.
  controller.abort();
  const end = await iter.next();
  assertEquals(end.done, true);
  await socket.closeObserved;
  assertEquals(socket.closed?.code, 1000);
});

test('DurableObjectChannelBroker.subscribe does not open a socket for an already-aborted signal', async () => {
  const socket = new FakeServerSocket();
  const fetches = { count: 0 };
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket, [], [], fetches), stringCodec);
  const controller = new AbortController();
  controller.abort();

  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();

  assertEquals((await iter.next()).done, true);
  assertEquals(fetches.count, 0);
  assertEquals(socket.closed, null);
});

test('DurableObjectChannelBroker.subscribe resolves concurrent reads in socket order', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();
  const first = iter.next();
  const second = iter.next();

  socket.emit('message', new MessageEvent('message', { data: 'a1' }));
  socket.emit('message', new MessageEvent('message', { data: 'a2' }));

  assertEquals((await first).value, 'a1');
  assertEquals((await second).value, 'a2');
  controller.abort();
});

test('DurableObjectChannelBroker.publish encodes the payload through the codec', async () => {
  const broadcasts: string[] = [];
  const ns = buildNamespace(new FakeServerSocket(), broadcasts);
  const broker = new DurableObjectChannelBroker<string>(ns, stringCodec);
  await broker.publish('k', 'frame-a');
  assertEquals(broadcasts.length, 1);
  assertEquals(broadcasts[0], 'frame-a');
});

test('DurableObjectChannelBroker.closeChannel forwards the reason to the actor', async () => {
  const closeAlls: string[] = [];
  const ns = buildNamespace(new FakeServerSocket(), [], closeAlls);
  const broker = new DurableObjectChannelBroker<string>(ns, stringCodec);
  await broker.closeChannel('k', 'custom-reason');
  assertEquals(closeAlls.length, 1);
  assertEquals(closeAlls[0], 'custom-reason');
});

test('DurableObjectChannelBroker.subscribe rejects every pending read when decoding fails', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();

  const first = iter.next();
  const second = iter.next();

  socket.emit('message', new MessageEvent('message', { data: 'bad:payload' }));

  const results = await Promise.allSettled([first, second]);
  assertEquals(results.map(result => result.status), ['rejected', 'rejected']);
  assertEquals((results[0] as PromiseRejectedResult).reason.message, 'stringCodec rejected payload: bad:payload');
  assertEquals((results[1] as PromiseRejectedResult).reason.message, 'stringCodec rejected payload: bad:payload');
});

test('DurableObjectChannelBroker.subscribe drains buffered payloads before surfacing a decode failure', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();

  socket.emit('message', new MessageEvent('message', { data: 'good' }));
  socket.emit('message', new MessageEvent('message', { data: 'bad:payload' }));

  assertEquals((await iter.next()).value, 'good');
  const failed = await Promise.allSettled([iter.next()]);
  assertEquals(failed[0].status, 'rejected');
  assertEquals((failed[0] as PromiseRejectedResult).reason.message, 'stringCodec rejected payload: bad:payload');
});

test('DurableObjectChannelBroker reciprocates a server close before ending the iterator', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();

  socket.emit('close', closeEvent(1001, 'server shutdown'));

  const result = await iter.next();
  assertEquals(result.done, true);
  assertEquals(socket.closed, { code: 1001, reason: 'server shutdown' });
});

test('DurableObjectChannelBroker.subscribe surfaces a server-side socket error by throwing from .next()', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();

  socket.emit('error', new Event('error'));

  let caught: unknown = null;
  try {
    await iter.next();
  } catch (err) {
    caught = err;
  }
  assertEquals(caught instanceof Error, true);
  assertEquals((caught as Error).message, 'BroadcastDO socket error');
});

test('DurableObjectChannelBroker.subscribe delivers a frame buffered before the first .next() call', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();

  // Emit BEFORE the first .next(): the broker's eager listener attach must
  // buffer the frame so the first read returns it instead of waiting on a
  // future emit.
  socket.emit('message', new MessageEvent('message', { data: 'pre-buffered' }));
  const first = await iter.next();
  assertEquals(first.value, 'pre-buffered');
});

test('DurableObjectChannelBroker.subscribe closes the socket when the iterator returns', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();

  await iter.return?.();

  assertEquals(socket.closed?.code, 1000);
  assertEquals(socket.listeners.get('message')?.size, 0);
  assertEquals(socket.listeners.get('close')?.size, 0);
  assertEquals(socket.listeners.get('error')?.size, 0);
});

test('DurableObjectChannelBroker closes a slow subscriber at the bounded queue capacity', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const iter = (await broker.subscribe('k', new AbortController().signal))[Symbol.asyncIterator]();
  for (let i = 0; i <= CHANNEL_SUBSCRIPTION_BUFFER_CAPACITY; i += 1) {
    socket.emit('message', new MessageEvent('message', { data: `frame-${i}` }));
  }

  for (let i = 0; i < CHANNEL_SUBSCRIPTION_BUFFER_CAPACITY; i += 1) {
    assertEquals((await iter.next()).value, `frame-${i}`);
  }
  await assertRejects(
    () => iter.next(),
    Error,
    `Channel subscriber exceeded ${CHANNEL_SUBSCRIPTION_BUFFER_CAPACITY} buffered frames`,
  );
  assertEquals(socket.closed?.code, 1000);
  assertEquals(socket.listeners.get('message')?.size, 0);
  assertEquals(socket.listeners.get('close')?.size, 0);
  assertEquals(socket.listeners.get('error')?.size, 0);
});

test('DurableObjectChannelBroker discards buffered frames when the subscriber aborts', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectChannelBroker<string>(buildNamespace(socket), stringCodec);
  const controller = new AbortController();
  const iter = (await broker.subscribe('k', controller.signal))[Symbol.asyncIterator]();
  socket.emit('message', new MessageEvent('message', { data: 'already-buffered' }));

  controller.abort();

  assertEquals((await iter.next()).done, true);
  await socket.closeObserved;
  assertEquals(socket.closed?.code, 1000);
});

test('DurableObjectChannelBroker does not report subscription readiness before the upgrade resolves', async () => {
  const socket = new FakeServerSocket();
  let resolveFetch!: (response: Response) => void;
  const fetchGate = new Promise<Response>(resolve => { resolveFetch = resolve; });
  const broker = new DurableObjectChannelBroker<string>(
    buildNamespace(socket, [], [], undefined, () => fetchGate),
    stringCodec,
  );
  let ready = false;
  const subscription = broker.subscribe('k', new AbortController().signal).then(value => {
    ready = true;
    return value;
  });
  await Promise.resolve();
  assertEquals(ready, false);

  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, 'status', { value: 101, configurable: true });
  Object.defineProperty(response, 'webSocket', { value: socket, configurable: true });
  resolveFetch(response);

  const iter = (await subscription)[Symbol.asyncIterator]();
  assertEquals(ready, true);
  socket.emit('message', new MessageEvent('message', { data: 'after-ready' }));
  assertEquals((await iter.next()).value, 'after-ready');
  await iter.return?.();
});

test('DurableObjectChannelBroker exposes malformed upgrade responses and fetch failures', async () => {
  const missingSocket = new Response(null, { status: 200 });
  Object.defineProperty(missingSocket, 'status', { value: 101, configurable: true });
  const cases: Array<{ response: () => Promise<Response>; message: string }> = [
    {
      response: () => Promise.resolve(new Response(null, { status: 503 })),
      message: 'BroadcastDO subscribe returned HTTP 503 instead of 101',
    },
    {
      response: () => Promise.resolve(missingSocket),
      message: 'BroadcastDO returned 101 without a webSocket',
    },
  ];

  for (const { response, message } of cases) {
    const broker = new DurableObjectChannelBroker<string>(
      buildNamespace(new FakeServerSocket(), [], [], undefined, response),
      stringCodec,
    );
    await assertRejects(
      () => broker.subscribe('k', new AbortController().signal),
      Error,
      message,
    );
  }

  const expected = new Error('transport failed');
  const broker = new DurableObjectChannelBroker<string>(
    buildNamespace(new FakeServerSocket(), [], [], undefined, () => Promise.reject(expected)),
    stringCodec,
  );
  const [result] = await Promise.allSettled([
    broker.subscribe('k', new AbortController().signal),
  ]);
  assertEquals(result.status, 'rejected');
  assertEquals((result as PromiseRejectedResult).reason, expected);
});

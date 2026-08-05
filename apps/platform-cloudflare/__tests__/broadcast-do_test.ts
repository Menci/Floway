import { DurableObject } from 'cloudflare:workers';
import { test } from 'vitest';

import { BroadcastDO } from '../src/broadcast-do.ts';
import { assertEquals } from '@floway-dev/test-utils';

// Minimal stub of the CF DurableObject runtime surface the actor touches.
// Tests don't run in workerd; install just enough of the WS hibernation API
// for the actor's fetch + broadcast + closeAll + lifecycle-hook paths.
class FakeWebSocket implements WebSocket {
  readyState = 1;
  binaryType: BinaryType = 'arraybuffer';
  bufferedAmount = 0;
  extensions = '';
  protocol = '';
  url = '';
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  CONNECTING = 0 as const;
  OPEN = 1 as const;
  CLOSING = 2 as const;
  CLOSED = 3 as const;

  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(private readonly failures: { send?: Error; close?: Error } = {}) {}

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    // BroadcastDO's `broadcast(payload: string)` contract forbids non-string
    // payloads; throw loud on any binary input so a regression that sneaks
    // ArrayBuffer/Blob through surfaces here instead of becoming a silent
    // empty frame on the wire.
    if (typeof data !== 'string') throw new Error('FakeWebSocket.send: expected string payload');
    if (this.failures.send) throw this.failures.send;
    this.sent.push(data);
  }
  close(code = 1000, reason = ''): void {
    if (this.failures.close) throw this.failures.close;
    this.closed = { code, reason };
  }
  accept(): void { /* noop */ }
  addEventListener(): void { /* noop */ }
  removeEventListener(): void { /* noop */ }
  dispatchEvent(): boolean { return true; }
}

class FakeState {
  readonly sockets: FakeWebSocket[] = [];
  acceptWebSocket(ws: WebSocket): void {
    this.sockets.push(ws as FakeWebSocket);
  }
  getWebSockets(): WebSocket[] {
    return this.sockets;
  }
  push(ws: FakeWebSocket): void {
    this.sockets.push(ws);
  }
}

test('BroadcastDO extends DurableObject so the runtime gates RPC dispatch on it', () => {
  // BroadcastDO must extend DurableObject so the CF runtime gates RPC
  // dispatch on the subclass; without the extends declaration, direct method
  // invocation (`stub.broadcast(...)`, `stub.closeAll(...)`) fails with
  // "the receiving Durable Object does not support RPC". The unit-test
  // surface doesn't reach the runtime RPC machinery, so the prototype-chain
  // check pins that the extends declaration is present.
  assertEquals(Object.getPrototypeOf(BroadcastDO.prototype) === DurableObject.prototype, true);
});

test('BroadcastDO.broadcast sends the payload verbatim to every registered socket', async () => {
  const state = new FakeState();
  const ws1 = new FakeWebSocket();
  const ws2 = new FakeWebSocket();
  state.push(ws1);
  state.push(ws2);
  const actor = new BroadcastDO(state, {});

  await actor.broadcast('hello world');

  assertEquals(ws1.sent.length, 1);
  assertEquals(ws1.sent[0], 'hello world');
  assertEquals(ws2.sent[0], 'hello world');
});

test('BroadcastDO.broadcast attempts every socket before exposing all send failures', async () => {
  const firstError = new Error('first socket failed');
  const secondError = new Error('second socket failed');
  const state = new FakeState();
  state.push(new FakeWebSocket({ send: firstError }));
  const healthy = new FakeWebSocket();
  state.push(healthy);
  state.push(new FakeWebSocket({ send: secondError }));
  const actor = new BroadcastDO(state, {});

  const [result] = await Promise.allSettled([actor.broadcast('survives failures')]);

  assertEquals(result.status, 'rejected');
  const error = (result as PromiseRejectedResult).reason;
  assertEquals(error instanceof AggregateError, true);
  assertEquals(error.message, 'BroadcastDO.broadcast failed for 2 WebSocket connection(s)');
  assertEquals(error.errors, [firstError, secondError]);
  assertEquals(healthy.sent, ['survives failures']);
});

test('BroadcastDO.closeAll closes every socket with the given reason and code 1000', async () => {
  const state = new FakeState();
  const ws1 = new FakeWebSocket();
  const ws2 = new FakeWebSocket();
  state.push(ws1);
  state.push(ws2);
  const actor = new BroadcastDO(state, {});

  await actor.closeAll('reason of the day');

  assertEquals(ws1.closed?.code, 1000);
  assertEquals(ws1.closed?.reason, 'reason of the day');
  assertEquals(ws2.closed?.code, 1000);
  assertEquals(ws2.closed?.reason, 'reason of the day');
});

test('BroadcastDO.closeAll attempts every socket before exposing all close failures', async () => {
  const firstError = new Error('first close failed');
  const secondError = new Error('second close failed');
  const state = new FakeState();
  state.push(new FakeWebSocket({ close: firstError }));
  const healthy = new FakeWebSocket();
  state.push(healthy);
  state.push(new FakeWebSocket({ close: secondError }));
  const actor = new BroadcastDO(state, {});

  const [result] = await Promise.allSettled([actor.closeAll('shutdown')]);

  assertEquals(result.status, 'rejected');
  const error = (result as PromiseRejectedResult).reason;
  assertEquals(error instanceof AggregateError, true);
  assertEquals(error.message, 'BroadcastDO.closeAll failed for 2 WebSocket connection(s)');
  assertEquals(error.errors, [firstError, secondError]);
  assertEquals(healthy.closed, { code: 1000, reason: 'shutdown' });
});

test('BroadcastDO.webSocketClose calls ws.close to complete the close handshake', async () => {
  const actor = new BroadcastDO(new FakeState(), {});
  const ws = new FakeWebSocket();
  await actor.webSocketClose(ws, 1001, 'going away', true);
  assertEquals(ws.closed?.code, 1001);
  assertEquals(ws.closed?.reason, 'going away');
});

test('BroadcastDO.webSocketError exists so the runtime delivers close events', async () => {
  // The hook's mere presence is what gates close-event delivery; assert the
  // method is declared on the class itself so the gating contract survives a
  // refactor that mistakes the no-op body for dead code.
  assertEquals(typeof BroadcastDO.prototype.webSocketError, 'function');
  assertEquals(Object.prototype.hasOwnProperty.call(BroadcastDO.prototype, 'webSocketError'), true);
  const actor = new BroadcastDO(new FakeState(), {});
  const ws = new FakeWebSocket();
  await actor.webSocketError(ws, new Error('whatever'));
  // No side effect — the runtime drops the socket from getWebSockets() on its own.
  assertEquals(ws.closed, null);
});

test('BroadcastDO.fetch upgrades to a WebSocket and registers the server side', async () => {
  // The actor's fetch path is the subscriber entry point: it must mint a
  // WebSocketPair, hand the server side to the runtime via acceptWebSocket,
  // and return a 101 response carrying the client side. Stub the CF-only
  // globals locally — Node's `Response` constructor rejects status 101 so
  // we patch the global to accept it for the duration of the test.
  const realResponse = globalThis.Response;
  const realWebSocketPair = (globalThis as Record<string, unknown>).WebSocketPair;

  const PairCtor = function (): [WebSocket, WebSocket] {
    return [new FakeWebSocket() as unknown as WebSocket, new FakeWebSocket() as unknown as WebSocket];
  };
  (globalThis as Record<string, unknown>).WebSocketPair = PairCtor as unknown;

  class StubResponse {
    readonly status: number;
    readonly webSocket: WebSocket | undefined;
    constructor(_body: BodyInit | null, init?: ResponseInit) {
      this.status = init?.status ?? 200;
      this.webSocket = init?.webSocket;
    }
  }
  (globalThis as Record<string, unknown>).Response = StubResponse as unknown as typeof Response;

  try {
    const state = new FakeState();
    const actor = new BroadcastDO(state, {});

    const response = await actor.fetch(new Request('https://broadcast.do/subscribe', {
      headers: { Upgrade: 'websocket' },
    }));

    assertEquals(response.status, 101);
    assertEquals(response.webSocket !== undefined, true);
    assertEquals(state.sockets.length, 1);
  } finally {
    globalThis.Response = realResponse;
    if (realWebSocketPair === undefined) {
      delete (globalThis as Record<string, unknown>).WebSocketPair;
    } else {
      (globalThis as Record<string, unknown>).WebSocketPair = realWebSocketPair;
    }
  }
});

test('BroadcastDO.fetch rejects malformed upgrades before registering a socket', async () => {
  const requests = [
    new Request('https://broadcast.do/subscribe'),
    new Request('https://broadcast.do/subscribe', { headers: { Upgrade: 'h2c' } }),
    new Request('https://broadcast.do/subscribe', {
      method: 'POST',
      headers: { Upgrade: 'websocket' },
    }),
  ];

  for (const request of requests) {
    const state = new FakeState();
    const actor = new BroadcastDO(state, {});

    const response = await actor.fetch(request);

    assertEquals(response.status, 426);
    assertEquals(response.headers.get('Upgrade'), 'websocket');
    assertEquals(state.sockets.length, 0);
  }
});

import { DurableObject } from 'cloudflare:workers';
import { test } from 'vitest';

import { ExecutionDO } from '../src/execution-do.ts';
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

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    // Broadcast protocol payloads are text; reject binary test input loudly.
    if (typeof data !== 'string') throw new Error('FakeWebSocket.send: expected string payload');
    this.sent.push(data);
  }
  close(code = 1000, reason = ''): void { this.closed = { code, reason }; }
  accept(): void { /* noop */ }
  addEventListener(): void { /* noop */ }
  removeEventListener(): void { /* noop */ }
  dispatchEvent(): boolean { return true; }
}

class FakeState {
  readonly sockets: FakeWebSocket[] = [];
  readonly exports = {
    ExecutionOperationEntrypoint: {
      fetch: async (_request: Request) => new Response('executed'),
    },
  };
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

test('ExecutionDO extends the platform DurableObject base', () => {
  assertEquals(Object.getPrototypeOf(ExecutionDO.prototype) === DurableObject.prototype, true);
});

test('ExecutionDO broadcast request sends the payload verbatim to every registered socket', async () => {
  const state = new FakeState();
  const ws1 = new FakeWebSocket();
  const ws2 = new FakeWebSocket();
  state.push(ws1);
  state.push(ws2);
  const actor = new ExecutionDO(state, {});

  const response = await actor.fetch(new Request('https://execution.do/broadcast', { method: 'POST', body: 'hello world' }));

  assertEquals(response.status, 204);
  assertEquals(ws1.sent.length, 1);
  assertEquals(ws1.sent[0], 'hello world');
  assertEquals(ws2.sent[0], 'hello world');
});

test('ExecutionDO close request closes every socket with the given reason and code 1000', async () => {
  const state = new FakeState();
  const ws1 = new FakeWebSocket();
  const ws2 = new FakeWebSocket();
  state.push(ws1);
  state.push(ws2);
  const actor = new ExecutionDO(state, {});

  const response = await actor.fetch(new Request('https://execution.do/broadcast/close', { method: 'POST', body: 'reason of the day' }));

  assertEquals(response.status, 204);
  assertEquals(ws1.closed?.code, 1000);
  assertEquals(ws1.closed?.reason, 'reason of the day');
  assertEquals(ws2.closed?.code, 1000);
  assertEquals(ws2.closed?.reason, 'reason of the day');
});

test('ExecutionDO.webSocketClose calls ws.close to complete the close handshake', async () => {
  const actor = new ExecutionDO(new FakeState(), {});
  const ws = new FakeWebSocket();
  await actor.webSocketClose(ws, 1001, 'going away', true);
  assertEquals(ws.closed?.code, 1001);
  assertEquals(ws.closed?.reason, 'going away');
});

test('ExecutionDO.webSocketError exists so the runtime delivers close events', async () => {
  // The hook's mere presence is what gates close-event delivery; assert the
  // method is declared on the class itself so the gating contract survives a
  // refactor that mistakes the no-op body for dead code.
  assertEquals(typeof ExecutionDO.prototype.webSocketError, 'function');
  assertEquals(Object.prototype.hasOwnProperty.call(ExecutionDO.prototype, 'webSocketError'), true);
  const actor = new ExecutionDO(new FakeState(), {});
  const ws = new FakeWebSocket();
  await actor.webSocketError(ws, new Error('whatever'));
  // No side effect — the runtime drops the socket from getWebSockets() on its own.
  assertEquals(ws.closed, null);
});

test('ExecutionDO.fetch upgrades to a WebSocket and registers the server side', async () => {
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
    const actor = new ExecutionDO(state, {});

    const response = await actor.fetch(new Request('https://execution.do/broadcast', { headers: { Upgrade: 'websocket' } }));

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

test('ExecutionDO coalesces concurrent operations and returns independent responses', async () => {
  let calls = 0;
  const state = new FakeState();
  state.exports.ExecutionOperationEntrypoint.fetch = async () => {
    calls += 1;
    return new Response('models refreshed', { status: 202, headers: { 'x-execution': 'done' } });
  };
  const actor = new ExecutionDO(state, {});

  const first = actor.fetch(new Request('https://execution.do/models/refresh', { method: 'POST' }));
  const second = actor.fetch(new Request('https://execution.do/models/refresh', { method: 'POST' }));

  assertEquals((await first).status, 202);
  const secondResponse = await second;
  assertEquals(await secondResponse.text(), 'models refreshed');
  assertEquals(secondResponse.headers.get('x-execution'), 'done');
  assertEquals(calls, 1);

  await actor.fetch(new Request('https://execution.do/models/refresh', { method: 'POST' }));
  assertEquals(calls, 2);
});

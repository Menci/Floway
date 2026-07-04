import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// vi.mock factories are hoisted above module init, so the mock fns + the
// control state they read must live in vi.hoisted (also hoisted) rather than
// in plain top-level consts.
//
// socket-dial is mocked so this test never imports `cloudflare:sockets` (the
// vitest config only aliases `cloudflare:workers`). fetchOnStream is mocked so
// we drive the upstream response body directly — the DO's job under test is the
// session / buffer / consumer plumbing, not HTTP parsing.
const h = vi.hoisted(() => {
  const ctl = {
    bodyController: null as ReadableStreamDefaultController<Uint8Array> | null,
    status: 200,
    headers: { 'x-test': 'hi' } as Record<string, string>,
    hasBody: true,
  };
  const socketClose = vi.fn(async () => {});
  const connect = vi.fn(async () => ({
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    close: socketClose,
  }));
  const fetchOnStream = vi.fn(async () => {
    const body = ctl.hasBody
      ? new ReadableStream<Uint8Array>({ start(c) { ctl.bodyController = c; } })
      : null;
    return new Response(body, { status: ctl.status, headers: ctl.headers });
  });
  return { ctl, socketClose, connect, fetchOnStream };
});
vi.mock('./socket-dial.ts', () => ({ cloudflareSocketDial: { connect: h.connect } }));
vi.mock('@floway-dev/http', () => ({ fetchOnStream: h.fetchOnStream }));

import { DurableHttpSessionDO } from './durable-http-session-do.ts';

// Minimal CF runtime surface. WebSocketPair / WebSocket are workerd globals;
// stub just enough for the consumer-attach path.
class FakeWebSocket {
  readonly sent: Uint8Array[] = [];
  readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  closed: { code: number; reason: string } | null = null;
  accept(): void {}
  send(data: Uint8Array): void { this.sent.push(data); }
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = { code, reason };
    for (const fn of this.listeners.get('close') ?? []) fn({ code, reason });
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  // Test helper: simulate the broker sending one credit ("send me one chunk").
  // The DO's message listener ignores the payload, so any data works.
  credit(): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: new Uint8Array([1]) });
  }
}

const createdPairs: [FakeWebSocket, FakeWebSocket][] = [];

class FakeAlarmStorage {
  setAlarmCalls = 0;
  deleteAlarmCalls = 0;
  async setAlarm(): Promise<void> { this.setAlarmCalls++; }
  async deleteAlarm(): Promise<void> { this.deleteAlarmCalls++; }
}

class FakeState {
  readonly accepted: WebSocket[] = [];
  readonly storage = new FakeAlarmStorage();
  acceptWebSocket(ws: WebSocket): void { this.accepted.push(ws); }
  getWebSockets(): WebSocket[] { return this.accepted; }
}

const flushMicrotasks = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const POST_INIT = { method: 'POST' as const, url: 'https://api2.cursor.sh/RunSSE', headers: {} };

// CF lets `new Response(null, { status: 101, webSocket })` carry a hibernation
// upgrade; Node's Response refuses status 101. Shim only that case so the DO's
// fetch() upgrade path runs under Node; everything else delegates to the real
// Response (the fetchOnStream mock needs a real streaming body).
const RealResponse = globalThis.Response;
function ShimResponse(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }): Response {
  if (init?.status === 101) {
    return { status: 101, webSocket: init.webSocket, body: null, headers: new Headers() } as unknown as Response;
  }
  return new RealResponse(body ?? null, init);
}

beforeEach(() => {
  h.ctl.bodyController = null;
  h.ctl.status = 200;
  h.ctl.headers = { 'x-test': 'hi' };
  h.ctl.hasBody = true;
  createdPairs.length = 0;
  h.connect.mockClear();
  h.socketClose.mockClear();
  h.fetchOnStream.mockClear();
  (globalThis as { Response: unknown }).Response = ShimResponse;
  (globalThis as { WebSocketPair?: unknown }).WebSocketPair = class {
    constructor() {
      const pair: [FakeWebSocket, FakeWebSocket] = [new FakeWebSocket(), new FakeWebSocket()];
      createdPairs.push(pair);
      return pair as unknown as FakeWebSocket;
    }
  };
});

afterEach(() => {
  (globalThis as { Response: unknown }).Response = RealResponse;
  delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
});

const makeDO = (): { actor: DurableHttpSessionDO; state: FakeState } => {
  const state = new FakeState();
  const actor = new DurableHttpSessionDO(state as unknown as DurableObjectState, {});
  return { actor, state };
};

describe('DurableHttpSessionDO.queryOrStart', () => {
  test('miss + init=null returns null without dialing', async () => {
    const { actor } = makeDO();
    expect(await actor.queryOrStart(null, 1000)).toBeNull();
    expect(h.connect).not.toHaveBeenCalled();
  });

  test('miss + init dials, runs the request, returns status/headers, arms the alarm', async () => {
    const { actor, state } = makeDO();
    const meta = await actor.queryOrStart(POST_INIT, 1000);
    expect(meta).toEqual({ status: 200, headers: [['x-test', 'hi']] });
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.connect).toHaveBeenCalledWith('api2.cursor.sh', 443, { tls: true });
    expect(state.storage.setAlarmCalls).toBe(1);
  });

  test('hit (already started) returns meta without dialing again', async () => {
    const { actor } = makeDO();
    await actor.queryOrStart(POST_INIT, 1000);
    h.connect.mockClear();
    const meta = await actor.queryOrStart(POST_INIT, 1000);
    expect(meta).toEqual({ status: 200, headers: [['x-test', 'hi']] });
    expect(h.connect).not.toHaveBeenCalled();
  });

  test('upstream with no body discards and throws', async () => {
    h.ctl.hasBody = false;
    const { actor } = makeDO();
    await expect(actor.queryOrStart(POST_INIT, 1000)).rejects.toThrow('returned no body');
    expect(h.socketClose).toHaveBeenCalled();
  });
});

describe('DurableHttpSessionDO body channel + lifecycle', () => {
  test('fetch before start returns 409', async () => {
    const { actor } = makeDO();
    const resp = await actor.fetch(new Request('https://durable-http.do/body'));
    expect(resp.status).toBe(409);
  });

  test('fetch after start upgrades to 101 and delivers one chunk per credit', async () => {
    const { actor } = makeDO();
    await actor.queryOrStart(POST_INIT, 1000);

    h.ctl.bodyController!.enqueue(new Uint8Array([1, 2]));
    await flushMicrotasks();

    const resp = await actor.fetch(new Request('https://durable-http.do/body'));
    expect(resp.status).toBe(101);
    const server = createdPairs[0]![1];
    // Credit-based backpressure: nothing is sent until the consumer requests it.
    expect(server.sent).toEqual([]);

    server.credit();
    expect(server.sent.flatMap(c => Array.from(c))).toEqual([1, 2]);

    // A live chunk stays buffered until the next credit.
    h.ctl.bodyController!.enqueue(new Uint8Array([3]));
    await flushMicrotasks();
    expect(server.sent.flatMap(c => Array.from(c))).toEqual([1, 2]);
    server.credit();
    expect(server.sent.flatMap(c => Array.from(c))).toEqual([1, 2, 3]);
  });

  test('upstream end closes the consumer socket once a credit is waiting', async () => {
    const { actor } = makeDO();
    await actor.queryOrStart(POST_INIT, 1000);
    await actor.fetch(new Request('https://durable-http.do/body'));
    const server = createdPairs[0]![1];
    h.ctl.bodyController!.close();
    await flushMicrotasks();
    // End-of-stream is delivered on a pull, not pushed: no credit → no close.
    expect(server.closed).toBeNull();
    server.credit();
    expect(server.closed).not.toBeNull();
  });

  test('discard cancels reader, closes the socket, deletes the alarm, resets to miss', async () => {
    const { actor, state } = makeDO();
    await actor.queryOrStart(POST_INIT, 1000);
    await actor.discard('framing error');
    expect(h.socketClose).toHaveBeenCalled();
    expect(state.storage.deleteAlarmCalls).toBe(1);
    expect(await actor.queryOrStart(null, 1000)).toBeNull();
  });

  test('buffer overflow with no consumer discards the session', async () => {
    const { actor } = makeDO();
    await actor.queryOrStart(POST_INIT, 1000);
    h.ctl.bodyController!.enqueue(new Uint8Array(1_100_000));
    await flushMicrotasks();
    expect(h.socketClose).toHaveBeenCalled();
  });
});

describe('DurableHttpSessionDO.alarm', () => {
  test('re-arms (does not discard) while activity is recent', async () => {
    const { actor, state } = makeDO();
    await actor.queryOrStart(POST_INIT, 1000);
    state.storage.setAlarmCalls = 0;
    await actor.alarm();
    expect(state.storage.setAlarmCalls).toBe(1);
    expect(h.socketClose).not.toHaveBeenCalled();
  });

  test('re-arms while a consumer is attached', async () => {
    const { actor, state } = makeDO();
    await actor.queryOrStart(POST_INIT, 1000);
    await actor.fetch(new Request('https://durable-http.do/body'));
    state.storage.setAlarmCalls = 0;
    await actor.alarm();
    expect(state.storage.setAlarmCalls).toBe(1);
    expect(h.socketClose).not.toHaveBeenCalled();
  });

  test('evicts an attached-but-silent consumer past the idle timeout', async () => {
    // A consumer that opened the WS, received bytes, then paused reading past
    // the idle timeout must not pin the DO to the 15-minute runtime cap; the
    // alarm has to discard regardless of consumer presence.
    const { actor, state } = makeDO();
    await actor.queryOrStart(POST_INIT, 1);
    await actor.fetch(new Request('https://durable-http.do/body'));
    await new Promise(resolve => setTimeout(resolve, 5));
    state.storage.setAlarmCalls = 0;
    state.storage.deleteAlarmCalls = 0;
    await actor.alarm();
    expect(h.socketClose).toHaveBeenCalled();
    expect(state.storage.deleteAlarmCalls).toBe(1);
    expect(state.storage.setAlarmCalls).toBe(0);
  });
});

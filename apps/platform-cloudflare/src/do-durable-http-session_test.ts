import { describe, expect, test, vi } from 'vitest';

import { DurableObjectDurableHttpSession, type DurableHttpSessionNamespace } from './do-durable-http-session.ts';

// Fake WebSocket the broker treats as the DO body channel. Tests drive it by
// calling emitMessage / emitClose after the broker has wired its listeners. The
// broker sends one credit (send) per ReadableStream pull; `credits` records them
// and `onCredit` lets a test script a frame per credit (the real DO's behavior).
class FakeWebSocket {
  readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  readonly credits: Uint8Array[] = [];
  onCredit: (() => void) | null = null;
  closed: { code: number; reason: string } | null = null;
  accepted = false;
  accept(): void { this.accepted = true; }
  send(data: Uint8Array): void { this.credits.push(data); this.onCredit?.(); }
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.fire('close', { code, reason });
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  private fire(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  emitMessage(data: Uint8Array | string): void { this.fire('message', { data }); }
  emitClose(): void { this.close(1000, 'upstream ended'); }
}

interface StubCalls {
  queryOrStart: Array<{ init: unknown; idleTimeoutMs: number }>;
  released: number;
  discarded: string[];
}

function makeNamespace(opts: {
  meta: { status: number; headers: [string, string][] } | null;
  socket?: FakeWebSocket;
}): { ns: DurableHttpSessionNamespace; calls: StubCalls; idFromName: ReturnType<typeof vi.fn> } {
  const calls: StubCalls = { queryOrStart: [], released: 0, discarded: [] };
  const socket = opts.socket ?? new FakeWebSocket();
  const stub = {
    async queryOrStart(init: unknown, idleTimeoutMs: number) {
      calls.queryOrStart.push({ init, idleTimeoutMs });
      return opts.meta;
    },
    async release() { calls.released++; },
    async discard(reason: string) { calls.discarded.push(reason); },
    async fetch() {
      // CF returns 101 + webSocket on a hibernation upgrade; Node's Response
      // refuses status 101, so hand back a structural stand-in.
      return { status: 101, webSocket: socket } as unknown as Response;
    },
  };
  const idFromName = vi.fn((name: string) => `id:${name}`);
  const ns: DurableHttpSessionNamespace = { idFromName, get: () => stub };
  return { ns, calls, idFromName };
}

const drain = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array[]> => {
  const out: Uint8Array[] = [];
  const reader = body.getReader();
  while (true) { const { done, value } = await reader.read(); if (done) break; if (value) out.push(value); }
  return out;
};

describe('DurableObjectDurableHttpSession.acquire', () => {
  test('miss + init=null returns null (queryOrStart said no session)', async () => {
    const { ns, calls } = makeNamespace({ meta: null });
    const broker = new DurableObjectDurableHttpSession(ns);
    const handle = await broker.acquire('cursor:up:key:auto:abc', null, { idleTimeoutMs: 1000 });
    expect(handle).toBeNull();
    expect(calls.queryOrStart).toHaveLength(1);
    expect(calls.queryOrStart[0]!.idleTimeoutMs).toBe(1000);
  });

  test('hit returns a handle exposing status/headers and streaming body', async () => {
    const socket = new FakeWebSocket();
    const { ns } = makeNamespace({ meta: { status: 200, headers: [['x-test', 'hi']] }, socket });
    const broker = new DurableObjectDurableHttpSession(ns);

    const handle = await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} });
    expect(handle).not.toBeNull();
    expect(handle!.status).toBe(200);
    expect(handle!.headers.get('x-test')).toBe('hi');
    expect(socket.accepted).toBe(true);

    const collected = drain(handle!.body);
    socket.emitMessage(new Uint8Array([1, 2, 3]));
    socket.emitMessage(new Uint8Array([4]));
    socket.emitClose();
    const chunks = await collected;
    expect(chunks.flatMap(c => Array.from(c))).toEqual([1, 2, 3, 4]);
  });

  test('issues exactly one credit per pull (strict backpressure)', async () => {
    const socket = new FakeWebSocket();
    // Respond to each credit with the next frame, then the close — modelling the
    // DO's one-chunk-per-credit delivery.
    const frames = [new Uint8Array([1]), new Uint8Array([2])];
    let i = 0;
    socket.onCredit = () => {
      queueMicrotask(() => { if (i < frames.length) socket.emitMessage(frames[i++]); else socket.emitClose(); });
    };
    const { ns } = makeNamespace({ meta: { status: 200, headers: [] }, socket });
    const broker = new DurableObjectDurableHttpSession(ns);
    const handle = await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} });

    const chunks = await drain(handle!.body);
    expect(chunks.flatMap(c => Array.from(c))).toEqual([1, 2]);
    // Two data chunks + the final pull that received the close = three credits.
    expect(socket.credits).toHaveLength(3);
  });

  test('release closes the body socket and calls stub.release', async () => {
    const socket = new FakeWebSocket();
    const { ns, calls } = makeNamespace({ meta: { status: 200, headers: [] }, socket });
    const broker = new DurableObjectDurableHttpSession(ns);
    const handle = await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} });
    await handle!.release();
    expect(calls.released).toBe(1);
    expect(socket.closed).not.toBeNull();
  });

  test('discard closes the body socket and calls stub.discard with the reason', async () => {
    const socket = new FakeWebSocket();
    const { ns, calls } = makeNamespace({ meta: { status: 200, headers: [] }, socket });
    const broker = new DurableObjectDurableHttpSession(ns);
    const handle = await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} });
    await handle!.discard('framing error');
    expect(calls.discarded).toEqual(['framing error']);
    expect(socket.closed).not.toBeNull();
  });

  test('aborting the caller signal ends the body stream without discarding', async () => {
    const socket = new FakeWebSocket();
    const { ns, calls } = makeNamespace({ meta: { status: 200, headers: [] }, socket });
    const broker = new DurableObjectDurableHttpSession(ns);
    const ac = new AbortController();
    const handle = await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} }, { signal: ac.signal });

    const collected = drain(handle!.body);
    socket.emitMessage(new Uint8Array([9]));
    ac.abort();
    const chunks = await collected;
    expect(chunks.flatMap(c => Array.from(c))).toEqual([9]);
    expect(socket.closed).not.toBeNull();
    expect(calls.discarded).toHaveLength(0); // abort != discard
  });

  test('idFromName is keyed by sessionKey so each conversation maps to its own actor', async () => {
    const { ns, idFromName } = makeNamespace({ meta: { status: 200, headers: [] } });
    const broker = new DurableObjectDurableHttpSession(ns);
    await broker.acquire('cursor:up:keyA:auto:1', null);
    await broker.acquire('cursor:up:keyB:auto:2', null);
    expect(idFromName.mock.calls.map(c => c[0])).toEqual(['cursor:up:keyA:auto:1', 'cursor:up:keyB:auto:2']);
  });
});

import { test } from 'vitest';

import { ExecutionDO } from '../src/execution-do.ts';
import { assertEquals } from '@floway-dev/test-utils';

// Vitest has no workerd; stub the WebSocket and loopback export APIs used here.
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
  private attachment: unknown = null;

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }

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
  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> { return await callback(); }
  readonly sockets: FakeWebSocket[] = [];
  readonly storage = null as unknown as DurableObjectStorage;
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

  const firstResponse = await first;
  const secondResponse = await second;
  assertEquals(firstResponse.status, 202);
  assertEquals(await firstResponse.text(), 'models refreshed');
  assertEquals(await secondResponse.text(), 'models refreshed');
  assertEquals(secondResponse.headers.get('x-execution'), 'done');
  assertEquals(calls, 1);

  await actor.fetch(new Request('https://execution.do/models/refresh', { method: 'POST' }));
  assertEquals(calls, 2);
});

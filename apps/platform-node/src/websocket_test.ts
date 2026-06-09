import type { Context } from 'hono';
import { beforeEach, expect, test, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { createNodeServeOptions, initNodeResponsesWebSocketUpgradeResolver } from './websocket.ts';
import type { ResponsesWebSocketEvents } from '@floway-dev/gateway';
import { assertEquals } from '@floway-dev/test-utils';

const mocks = vi.hoisted(() => ({
  upgradeWebSocket: vi.fn((_c: unknown, _events: unknown, _options: unknown) => new Response(null, { status: 200 })),
}));

vi.mock('@hono/node-server', () => ({
  upgradeWebSocket: mocks.upgradeWebSocket,
}));

beforeEach(() => {
  mocks.upgradeWebSocket.mockClear();
});

test('creates serve options with a ws noServer upgrade handler', () => {
  const fetch = vi.fn(async () => new Response('ok'));

  const options = createNodeServeOptions(fetch, 19090);
  const server = options.websocket?.server as WebSocketServer | undefined;

  assertEquals(options.fetch, fetch);
  assertEquals(options.port, 19090);
  expect(server).toBeInstanceOf(WebSocketServer);
  assertEquals(server?.options.noServer, true);
  server?.close();
});

test('registers Responses WebSocket upgrades through the Hono Node helper', async () => {
  const register = vi.fn();
  const context = {} as Context;
  const events: ResponsesWebSocketEvents = { onMessage: vi.fn() };

  initNodeResponsesWebSocketUpgradeResolver(register);

  assertEquals(register.mock.calls.length, 1);
  const resolver = register.mock.calls[0]?.[0] as ((c: Context, events: ResponsesWebSocketEvents) => Response | Promise<Response>) | undefined;
  if (!resolver) throw new Error('missing registered resolver');

  const response = await resolver(context, events);

  assertEquals(response.status, 200);
  assertEquals(mocks.upgradeWebSocket.mock.calls.length, 1);
  const [seenContext, seenEvents, options] = mocks.upgradeWebSocket.mock.calls[0] ?? [];
  assertEquals(seenContext, context);
  assertEquals(seenEvents, events);
  assertEquals(typeof (options as { onError?: unknown } | undefined)?.onError, 'function');

  const err = new Error('upgrade failed');
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    (options as { onError: (error: unknown) => void }).onError(err);
    expect(consoleError).toHaveBeenCalledWith('[websocket]', err);
  } finally {
    consoleError.mockRestore();
  }
});

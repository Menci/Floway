import { once } from 'node:events';
import { createServer } from 'node:http';

import { test } from 'vitest';
import WebSocket from 'ws';

import { createResponsesWebSocketServer } from '../src/responses-websocket-server.ts';
import { RESPONSES_WEBSOCKET_LIMITS } from '@floway-dev/gateway';
import { assertEquals } from '@floway-dev/test-utils';

test('Node Responses WebSocket server enforces the shared message ceiling before gateway dispatch', () => {
  const server = createResponsesWebSocketServer();
  assertEquals(server.options.noServer, true);
  assertEquals(server.options.maxPayload, RESPONSES_WEBSOCKET_LIMITS.maxMessageBytes);
  assertEquals(server.options.maxPayload, 32 * 1024 * 1024);
});

test('Node Responses WebSocket transport closes an oversized message with 1009', async () => {
  const httpServer = createServer();
  const websocketServer = createResponsesWebSocketServer(4);
  websocketServer.on('connection', socket => {
    socket.on('error', () => {});
  });
  httpServer.on('upgrade', (request, socket, head) => {
    websocketServer.handleUpgrade(request, socket, head, websocket => {
      websocketServer.emit('connection', websocket, request);
    });
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP test listener');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);

  try {
    await once(client, 'open');
    const closed = once(client, 'close');
    client.send('12345');
    const [code] = await closed;
    assertEquals(code, 1009);
  } finally {
    client.terminate();
    websocketServer.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close(error => { if (error) reject(error); else resolve(); });
    });
  }
});

import { test } from 'vitest';

import { createResponsesWebSocketServer } from '../src/responses-websocket-server.ts';
import { RESPONSES_WEBSOCKET_LIMITS } from '@floway-dev/gateway';
import { assertEquals } from '@floway-dev/test-utils';

test('Node Responses WebSocket server enforces the shared message ceiling before gateway dispatch', () => {
  const server = createResponsesWebSocketServer();
  assertEquals(server.options.noServer, true);
  assertEquals(server.options.maxPayload, RESPONSES_WEBSOCKET_LIMITS.maxMessageBytes);
  assertEquals(server.options.maxPayload, 32 * 1024 * 1024);
});

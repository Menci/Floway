import { test } from 'vitest';

import { prepareResponsesWebSocketMessage, ResponsesWebSocketIngressBudget } from '../../../../src/data-plane/chat/responses/websocket-policy.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('Responses WebSocket ingress budget enforces message, turn, and aggregate byte boundaries', () => {
  const budget = new ResponsesWebSocketIngressBudget({
    maxMessageBytes: 4,
    maxPendingTurns: 2,
    maxPendingBytes: 6,
  });
  assertEquals(budget.reserve(5), { kind: 'message-too-large', byteLength: 5 });

  const first = budget.reserve(4);
  const second = budget.reserve(2);
  if (first.kind !== 'accepted' || second.kind !== 'accepted') throw new Error('expected exact boundaries to be accepted');
  assertEquals(budget.reserve(0), { kind: 'queue-full' });

  first.reservation.release();
  first.reservation.release();
  const replacement = budget.reserve(4);
  if (replacement.kind !== 'accepted') throw new Error('expected released capacity to be reusable');
  assertEquals(budget.reserve(1), { kind: 'queue-full' });
  second.reservation.release();
  replacement.reservation.release();
});

test('Responses WebSocket message preparation rejects before encoding and owns accepted views', () => {
  const emoji = prepareResponsesWebSocketMessage('😀', 4);
  assertEquals(emoji.kind, 'ready');
  if (emoji.kind !== 'ready') throw new Error('expected exact UTF-8 boundary to be accepted');
  assertEquals(emoji.bytes.byteLength, 4);
  assertEquals(prepareResponsesWebSocketMessage('😀a', 4), { kind: 'message-too-large', byteLength: 5 });

  const backing = Uint8Array.of(9, 1, 2, 3, 4, 9);
  const view = prepareResponsesWebSocketMessage(backing.subarray(1, 5), 4);
  assertEquals(view.kind, 'ready');
  if (view.kind !== 'ready') throw new Error('expected exact view boundary to be accepted');
  backing.fill(0);
  assertEquals(Array.from(view.bytes), [1, 2, 3, 4]);
  assertEquals(view.bytes.buffer.byteLength, 4);
});

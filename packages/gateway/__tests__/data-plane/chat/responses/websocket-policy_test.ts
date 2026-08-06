import { test, vi } from 'vitest';

import { prepareResponsesWebSocketMessage, ResponsesWebSocketIngressBudget } from '../../../../src/data-plane/chat/responses/websocket-policy.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('Responses WebSocket ingress budget rejects one byte beyond the per-message boundary', () => {
  const budget = new ResponsesWebSocketIngressBudget({
    maxMessageBytes: 4,
    maxPendingTurns: 10,
    maxPendingBytes: 100,
  });
  assertEquals(budget.reserve(5), { kind: 'message-too-large', byteLength: 5 });
  const exact = budget.reserve(4);
  if (exact.kind !== 'accepted') throw new Error('expected the exact message boundary to be accepted');
  exact.reservation.release();
});

test('Responses WebSocket ingress budget enforces the pending-turn boundary independently', () => {
  const budget = new ResponsesWebSocketIngressBudget({
    maxMessageBytes: 100,
    maxPendingTurns: 2,
    maxPendingBytes: 100,
  });
  const first = budget.reserve(1);
  const second = budget.reserve(1);
  if (first.kind !== 'accepted' || second.kind !== 'accepted') throw new Error('expected the turn boundary to be accepted');
  assertEquals(budget.reserve(0), { kind: 'queue-full' });
  first.reservation.release();
  second.reservation.release();
});

test('Responses WebSocket ingress budget enforces aggregate bytes below the turn boundary', () => {
  const budget = new ResponsesWebSocketIngressBudget({
    maxMessageBytes: 100,
    maxPendingTurns: 3,
    maxPendingBytes: 6,
  });
  const first = budget.reserve(4);
  const second = budget.reserve(2);
  if (first.kind !== 'accepted' || second.kind !== 'accepted') throw new Error('expected the exact byte boundary to be accepted');
  assertEquals(budget.reserve(1), { kind: 'queue-full' });

  first.reservation.release();
  first.reservation.release();
  const replacement = budget.reserve(4);
  if (replacement.kind !== 'accepted') throw new Error('expected released capacity to be reusable');
  assertEquals(budget.reserve(1), { kind: 'queue-full' });
  second.reservation.release();
  replacement.reservation.release();
});

test('Responses WebSocket message preparation rejects before encoding and owns accepted views', () => {
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  try {
    assertEquals(prepareResponsesWebSocketMessage('😀a', 4), { kind: 'message-too-large', byteLength: 5 });
    assertEquals(encode.mock.calls.length, 0);

    const emoji = prepareResponsesWebSocketMessage('😀', 4);
    assertEquals(emoji.kind, 'ready');
    if (emoji.kind !== 'ready') throw new Error('expected exact UTF-8 boundary to be accepted');
    assertEquals(emoji.bytes.byteLength, 4);
    assertEquals(encode.mock.calls.length, 1);
  } finally {
    encode.mockRestore();
  }

  const backing = Uint8Array.of(9, 1, 2, 3, 4, 9);
  const view = prepareResponsesWebSocketMessage(backing.subarray(1, 5), 4);
  assertEquals(view.kind, 'ready');
  if (view.kind !== 'ready') throw new Error('expected exact view boundary to be accepted');
  backing.fill(0);
  assertEquals(Array.from(view.bytes), [1, 2, 3, 4]);
  assertEquals(view.bytes.buffer.byteLength, 4);
});

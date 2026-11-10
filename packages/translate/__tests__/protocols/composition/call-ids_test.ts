import { test } from 'vitest';

import type { IRInputTurn } from '../../../src/ir/input/types.ts';
import { assignCallIds } from '../../../src/protocols/composition/call-ids.ts';
import { assertEquals } from '@floway-dev/test-utils';

const call = (name: string, callId?: string): IRInputTurn => ({
  kind: 'assistant',
  items: [{ type: 'function_call', name, arguments: '{}', ...(callId === undefined ? {} : { call_id: callId }) }],
});
const result = (name?: string, callId?: string): IRInputTurn => ({
  kind: 'client',
  items: [{ type: 'tool_result', ...(name === undefined ? {} : { name }), ...(callId === undefined ? {} : { call_id: callId }), output: '' }],
});

/** The id the result in the last piece was answered with. */
const answeredId = (turns: ReturnType<typeof assignCallIds>): string | undefined => {
  const piece = turns[turns.length - 1];
  if (piece.kind !== 'client') return undefined;
  const item = piece.items[0];
  return item?.type === 'tool_result' ? item.call_id : undefined;
};

test('an id-less result answers the oldest call of its name', () => {
  assertEquals(answeredId(assignCallIds([call('read', 'a'), call('read', 'b'), result('read')], () => [])), 'a');
});

test('an id-less result with no name answers the oldest pending call', () => {
  assertEquals(answeredId(assignCallIds([call('read', 'a'), call('write', 'b'), result()], () => [])), 'a');
});

test('a result naming a call nothing awaits keeps its own id instead of taking another', () => {
  // The call it answers is a turn this side never saw — a trimmed history, say.
  // Falling back to the oldest pending call would answer the wrong one, and
  // discarding the result would lose what the model did, so it stands alone.
  const pieces = assignCallIds([call('read', 'a'), result('write')], () => []);
  assertEquals(answeredId(pieces), 'write_call_1');
  assertEquals(answeredId(pieces) === 'a', false);
});

test('a stated result releases its call so a later id-less result cannot take it', () => {
  assertEquals(answeredId(assignCallIds([call('read', 'a'), call('read', 'b'), result(undefined, 'a'), result('read')], () => [])), 'b');
});

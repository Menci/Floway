import { test } from 'vitest';

import type { IRInputTurn } from '../../src/ir/input/types.ts';
import { assignCallIds } from '../../src/shared/call-ids.ts';
import { assertThrows, assertEquals } from '@floway-dev/test-utils';

const call = (name: string, callId?: string): IRInputTurn => ({
  kind: 'assistant',
  items: [{ type: 'function_call', name, arguments: '{}', ...(callId === undefined ? {} : { call_id: callId }) }],
});
const result = (name?: string, callId?: string): IRInputTurn => ({
  kind: 'client',
  items: [{ type: 'tool_result', ...(name === undefined ? {} : { name }), ...(callId === undefined ? {} : { call_id: callId }), output: '' }],
});

/** The id the result in the last piece was answered with. */
const answeredId = (pieces: ReturnType<typeof assignCallIds>): string | undefined => {
  const piece = pieces[pieces.length - 1];
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

test('a result naming a call nothing awaits is refused rather than taking another call id', () => {
  // Falling back to the oldest pending call would silently answer the wrong
  // call, so a name that matches nothing has to fail.
  assertThrows(() => assignCallIds([call('read', 'a'), result('write')], () => []), Error, "names 'write'");
});

test('a stated result releases its call so a later id-less result cannot take it', () => {
  assertEquals(answeredId(assignCallIds([call('read', 'a'), call('read', 'b'), result(undefined, 'a'), result('read')], () => [])), 'b');
});

import { test } from 'vitest';

import type { IRInputTurn } from '../../../src/ir/input/types.ts';
import { assignCallIds, type PendingCall } from '../../../src/protocols/composition/call-ids.ts';
import type { ResolvedTurn } from '../../../src/protocols/composition/segments.ts';
import { TranslatorInputError } from '../../../src/types.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const call = (name: string, callId?: string): IRInputTurn => ({
  kind: 'assistant',
  items: [{ type: 'function_call', name, arguments: '{}', ...(callId === undefined ? {} : { call_id: callId }) }],
});
const result = (name?: string, callId?: string): IRInputTurn => ({
  kind: 'client',
  items: [{ type: 'tool_result', ...(name === undefined ? {} : { name }), ...(callId === undefined ? {} : { call_id: callId }), output: '' }],
});
/** A turn a sidecar restored: one the target states natively, with its own calls. */
const restored = (calls: readonly PendingCall[]): ResolvedTurn<readonly PendingCall[]> => ({ kind: 'resolved', turn: calls });
const restoredCalls = (turn: readonly PendingCall[]): readonly PendingCall[] => turn;

/** The result the last client turn ends with. */
const lastResult = (turns: ReturnType<typeof assignCallIds>) => {
  const piece = turns.at(-1);
  if (piece?.kind !== 'client') throw new Error('expected a client turn');
  const item = piece.items.at(-1);
  if (item?.type !== 'tool_result') throw new Error('expected a tool result');
  return item;
};

test('an id-less result answers the oldest call of its name', () => {
  assertEquals(lastResult(assignCallIds([call('read', 'a'), call('read', 'b'), result('read')], () => [])).call_id, 'a');
});

test('an id-less result with no name answers the oldest pending call', () => {
  assertEquals(lastResult(assignCallIds([call('read', 'a'), call('write', 'b'), result()], () => [])).call_id, 'a');
});

test('an id-less result answers a call a sidecar restored', () => {
  assertEquals(lastResult(assignCallIds([restored([{ name: 'read', callId: 'native-1' }]), result()], restoredCalls)).call_id, 'native-1');
});

test('a result naming a call nothing awaits is refused rather than answered with an invented id', () => {
  // The call it names is a turn this side never saw — a trimmed history, say.
  // Answering an oldest pending call instead would pair it with the wrong one,
  // and inventing an id would state a call no assistant turn ever made.
  assertThrows(() => assignCallIds([call('read', 'a'), result('write')], () => []), TranslatorInputError);
  assertThrows(() => assignCallIds([call('read', 'a'), result(undefined, 'invented')], () => []), TranslatorInputError);
});

test('a stated result releases its call so a later id-less result cannot take it', () => {
  assertEquals(lastResult(assignCallIds([call('read', 'a'), call('read', 'b'), result(undefined, 'a'), result('read')], () => [])).call_id, 'b');
});

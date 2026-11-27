import { test } from 'vitest';

import type { RestoredAssistantTurn } from '../../../src/composition/reading.ts';
import { assignCallIds, type PendingCall } from '../../../src/composition/request/call-ids.ts';
import type { IRInputTurn } from '../../../src/ir/input/types.ts';
import { TranslateInputException } from '../../../src/shared/input-error.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const call = (name: string, callId?: string): IRInputTurn => ({
  kind: 'assistant',
  items: [{ type: 'function_call', name, arguments: '{}', ...(callId === undefined ? {} : { call_id: callId }) }],
});
const result = (name?: string, callId?: string): IRInputTurn => ({
  kind: 'client',
  items: [{ type: 'tool_result', ...(name === undefined ? {} : { name }), ...(callId === undefined ? {} : { call_id: callId }), output: '' }],
});

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

test('a result naming a call nothing awaits is refused rather than answered with an invented id', () => {
  // The call it names is a turn this side never saw — a trimmed history, say.
  // Answering an oldest pending call instead would pair it with the wrong one,
  // and inventing an id would state a call no assistant turn ever made.
  assertThrows(() => assignCallIds([call('read', 'a'), result('write')], () => []), TranslateInputException);
  assertThrows(() => assignCallIds([call('read', 'a'), result(undefined, 'invented')], () => []), TranslateInputException);
});

test('a stated result releases its call so a later id-less result cannot take it', () => {
  assertEquals(lastResult(assignCallIds([call('read', 'a'), call('read', 'b'), result(undefined, 'a'), result('read')], () => [])).call_id, 'b');
});

test('an invented id does not collide with one the conversation states', () => {
  // A source may state any string as a real id, including one this step would
  // otherwise invent, and two calls sharing an id cannot be told apart.
  const ids = assignCallIds([call('read'), call('read', 'read_call_1')], () => [])
    .flatMap(turn => turn.kind === 'assistant' ? turn.items.flatMap(item => item.type === 'function_call' ? [item.call_id] : []) : []);
  assertEquals(new Set(ids).size, ids.length);
  // An orphan result spelling the first candidate must not accidentally match an id-less call.
  assertThrows(() => assignCallIds([call('read'), result('read', 'read_call_1')], () => []), TranslateInputException);
});

test('allocates collision-free IDs for id-less restored calls and reports exact call order for restored and ordinary matches', () => {
  interface TaggedCall extends PendingCall {
    readonly tag: string;
  }
  const first: RestoredAssistantTurn<string> = { kind: 'restored', turn: 'first', sourceCallIds: [undefined] };
  const second: RestoredAssistantTurn<string> = { kind: 'restored', turn: 'second', sourceCallIds: ['dup'] };
  const third: RestoredAssistantTurn<string> = { kind: 'restored', turn: 'third', sourceCallIds: ['dup'] };
  const matched: Array<[number, string, string | undefined]> = [];
  const turns = assignCallIds<string, TaggedCall>(
    [first, second, third, call('extra', 'ord_1'), result('lookup'), result(undefined, 'dup'), result(undefined, 'ord_1'), result(undefined, 'dup')],
    piece => piece.turn === 'first'
      ? [{ name: 'lookup', tag: 'idless' }]
      : [{ name: 'lookup', callId: 'dup', tag: piece.turn }],
    { onMatch: (item, match) => { matched.push([match.order, item.call_id, match.restored?.tag]); } },
  );
  assertEquals(matched, [
    [0, 'lookup_call_1', 'idless'],
    [1, 'dup', 'second'],
    [3, 'ord_1', undefined],
    [2, 'dup', 'third'],
  ]);
  assertEquals(lastResult(turns).call_id, 'dup');
});

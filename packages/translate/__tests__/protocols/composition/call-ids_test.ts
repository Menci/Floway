import { test } from 'vitest';

import type { IRInputTurn } from '../../../src/ir/input/types.ts';
import { assignCallIds } from '../../../src/protocols/composition/call-ids.ts';
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
type Restored = readonly { readonly name: string; readonly callId?: string }[];
/** A turn a sidecar restored: one the target states natively, with its own calls. */
const restored = (names: readonly (readonly [string, string?])[]): ResolvedTurn<Restored> => ({
  kind: 'resolved',
  turn: names.map(([name, callId]) => ({ name, ...(callId === undefined ? {} : { callId }) })),
});
const restoredCalls = (turn: Restored): Restored => turn;

/** The result the last client turn ends with. */
const lastResult = (turns: ReturnType<typeof assignCallIds>) => {
  const piece = turns.at(-1);
  if (piece?.kind !== 'client') throw new Error('expected a client turn');
  const item = piece.items.at(-1);
  if (item?.type !== 'tool_result') throw new Error('expected a tool result');
  return item;
};

test('an id-less result answers the oldest call of its name', () => {
  assertEquals(lastResult(assignCallIds([call('read', 'a'), call('read', 'b'), result('read')], restoredCalls)).call_id, 'a');
});

test('an id-less result with no name answers the oldest pending call', () => {
  assertEquals(lastResult(assignCallIds([call('read', 'a'), call('write', 'b'), result()], restoredCalls)).call_id, 'a');
});

test('a result naming a call nothing awaits is refused rather than answered with an invented id', () => {
  // The call it names is a turn this side never saw — a trimmed history, say.
  // Answering an oldest pending call instead would pair it with the wrong one,
  // and inventing an id would state a call no assistant turn ever made.
  assertThrows(() => assignCallIds([call('read', 'a'), result('write')], restoredCalls), TranslatorInputError);
});

test('a result naming no held call answers the one call stated without an id', () => {
  // A restored legacy call carries no id, so the id the client answers with is
  // one it invented and this conversation never states. The answer records the
  // call's name, which is what the wire pairs the two by.
  const answered = lastResult(assignCallIds([call('read', 'a'), restored([['lookup']]), result(undefined, 'client-invented')], restoredCalls));
  assertEquals(answered.call_id, 'client-invented');
  assertEquals(answered.legacy_call_name, 'lookup');
});

test('two calls awaiting an answer without an id is refused as ambiguous', () => {
  // Neither call can be named, so nothing tells the two answers apart.
  assertThrows(
    () => assignCallIds([restored([['lookup'], ['find']]), result(undefined, 'client-invented')], restoredCalls),
    TranslatorInputError,
  );
});

test('a call without an id is refused when the next turn does not answer it', () => {
  // A later turn cannot say which id-less call it means, so the intent is lost.
  assertThrows(
    () => assignCallIds([restored([['lookup']]), result(), result()], restoredCalls),
    TranslatorInputError,
  );
});

test('a restored call without an id is held to the same rule', () => {
  // The rule is about the call, not about which side stated it: a restored
  // turn's legacy call has no more identity than an in-IR one. The turn after
  // it carries no result at all, so nothing ever answers the call.
  const message: IRInputTurn = { kind: 'client', items: [{ type: 'message', content: [{ type: 'text', text: 'still thinking' }] }] };
  assertThrows(
    () => assignCallIds([restored([['lookup']]), message, result('lookup')], restoredCalls),
    TranslatorInputError,
  );
});

test('a call without an id may still await its answer at the end of the conversation', () => {
  // A conversation that ends on the call has not missed anything yet.
  const pieces = assignCallIds([call('read', 'a'), restored([['lookup']])], restoredCalls);
  assertEquals(pieces.length, 2);
});

test('a stated result releases its call so a later id-less result cannot take it', () => {
  assertEquals(lastResult(assignCallIds([call('read', 'a'), call('read', 'b'), result(undefined, 'a'), result('read')], restoredCalls)).call_id, 'b');
});

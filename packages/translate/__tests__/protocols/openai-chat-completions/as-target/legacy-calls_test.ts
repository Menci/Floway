import { test } from 'vitest';

import type { RestoredAssistantTurn } from '../../../../src/composition/reading.ts';
import { assignCallIds } from '../../../../src/composition/request/call-ids.ts';
import type { IRInputTurn } from '../../../../src/ir/input/types.ts';
import { chatLegacyCallsOf } from '../../../../src/protocols/openai-chat-completions/as-target/legacy-calls.ts';
import type { InputAssistantTurnFor } from '../../../../src/round-trip/input-assistant-turn.ts';
import { TranslateInputException } from '../../../../src/shared/input-error.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

type LegacyTurn = InputAssistantTurnFor<'openaiChatCompletions'>;
const legacy = (
  name: string,
  sourceCallIds: readonly (string | undefined)[] = [undefined],
): RestoredAssistantTurn<LegacyTurn> => ({ kind: 'restored', turn: { role: 'assistant', function_call: { name, arguments: '{}' } }, sourceCallIds });
const mixed = (
  sourceCallIds: readonly (string | undefined)[] = [undefined, 'modern-id'],
): RestoredAssistantTurn<LegacyTurn> => ({
  kind: 'restored',
  turn: {
    role: 'assistant',
    function_call: { name: 'legacy', arguments: '{}' },
    tool_calls: [{ id: 'modern-id', type: 'function', function: { name: 'modern', arguments: '{}' } }],
  },
  sourceCallIds,
});
const message = (text: string): IRInputTurn => ({ kind: 'client', items: [{ type: 'message', role: 'user', content: [{ type: 'text', text }] }] });

test('two id-less answers naming the legacy function are refused as ambiguous', () => {
  const twoAnswers: IRInputTurn = { kind: 'client', items: [{ type: 'tool_result', name: 'lookup', output: '' }, { type: 'tool_result', name: 'lookup', output: '' }] };
  assertThrows(() => chatLegacyCallsOf([legacy('lookup'), twoAnswers]), TranslateInputException);
});

test('a non-tail legacy call without a matching result is refused', () => {
  assertThrows(() => chatLegacyCallsOf([legacy('lookup'), message('later')]), TranslateInputException);
});

test('legacy matching consumes its uniquely named id-less result before modern matching', () => {
  const native = mixed();
  const results: IRInputTurn = {
    kind: 'client',
    items: [
      { type: 'tool_result', name: 'modern', output: 'MODERN' },
      { type: 'tool_result', name: 'legacy', output: 'LEGACY' },
    ],
  };
  const legacy = chatLegacyCallsOf([native, results]);
  const assigned = assignCallIds([native, results], turn => [
    { callId: legacy.callIds.get(turn)!, name: 'legacy' },
    { callId: 'modern-id', name: 'modern' },
  ], { resultCallIds: legacy.results });
  const client = assigned[1];
  assertEquals(client.kind === 'client' ? client.items.map(item => item.type === 'tool_result' ? item.call_id : undefined) : [], ['modern-id', legacy.callIds.get(native.turn)]);
});

test('a different legacy function does not end the result search', () => {
  const first = legacy('first');
  const second = legacy('second');
  const answers: IRInputTurn = {
    kind: 'client',
    items: [
      { type: 'tool_result', name: 'first', output: 'FIRST' },
      { type: 'tool_result', name: 'second', output: 'SECOND' },
    ],
  };
  const legacyCalls = chatLegacyCallsOf([first, message('between'), second, answers]);
  assertEquals([...legacyCalls.names.values()], ['first', 'second']);
});

test('mixed restored turn extracts the legacy source call ID regardless of stream order', () => {
  for (const order of [['modern-id', 'synth-1'], ['synth-1', 'modern-id']] as const) {
    const native = mixed(order);
    const results: IRInputTurn = {
      kind: 'client',
      items: [
        { type: 'tool_result', call_id: 'modern-id', output: 'MODERN' },
        { type: 'tool_result', call_id: 'synth-1', output: 'LEGACY' },
      ],
    };
    const legacyCalls = chatLegacyCallsOf([native, results]);
    const legacyId = legacyCalls.callIds.get(native.turn);
    assertEquals(legacyCalls.names.get(legacyId!), 'legacy');
    assertEquals(legacyCalls.results.get(results.items[1] as Extract<IRInputTurn['items'][number], { type: 'tool_result' }>), legacyId);
  }
});

test('unanswered explicit-ID legacy call registers no dangling call ID', () => {
  const native = legacy('lookup', ['synth-1']);
  const idlessAnswer: IRInputTurn = { kind: 'client', items: [{ type: 'tool_result', name: 'lookup', output: 'UNRELATED' }] };
  const legacyCalls = chatLegacyCallsOf([native, idlessAnswer]);
  assertEquals(legacyCalls.callIds.size, 0);
  assertThrows(() => assignCallIds([native, idlessAnswer], () => [], { resultCallIds: legacyCalls.results }), TranslateInputException);
});

test('explicit-ID legacy matching consumes FIFO and leaves duplicate results unmapped', () => {
  const first = legacy('first', ['dup-id']);
  const second = legacy('second', ['dup-id']);
  const twoAnswers: IRInputTurn = {
    kind: 'client',
    items: [
      { type: 'tool_result', call_id: 'dup-id', output: 'ONE' },
      { type: 'tool_result', call_id: 'dup-id', output: 'TWO' },
    ],
  };
  const legacyCalls = chatLegacyCallsOf([first, second, twoAnswers]);
  const firstId = legacyCalls.callIds.get(first.turn)!;
  const secondId = legacyCalls.callIds.get(second.turn)!;
  assertEquals(legacyCalls.results.get(twoAnswers.items[0] as Extract<IRInputTurn['items'][number], { type: 'tool_result' }>), firstId);
  assertEquals(legacyCalls.results.get(twoAnswers.items[1] as Extract<IRInputTurn['items'][number], { type: 'tool_result' }>), secondId);

  const single = legacy('only', ['dup-id']);
  const duplicateCalls = chatLegacyCallsOf([single, twoAnswers]);
  assertThrows(() => assignCallIds([single, twoAnswers], turn => {
    const id = duplicateCalls.callIds.get(turn);
    return id === undefined ? [] : [{ callId: id, name: 'only' }];
  }, { resultCallIds: duplicateCalls.results }), TranslateInputException);
});

test('mismatched authenticated sourceCallIds fails fast', () => {
  assertThrows(() => chatLegacyCallsOf([mixed(['modern-id'])]), Error);
  assertThrows(() => chatLegacyCallsOf([mixed(['other-id', 'synth-1'])]), Error);
});

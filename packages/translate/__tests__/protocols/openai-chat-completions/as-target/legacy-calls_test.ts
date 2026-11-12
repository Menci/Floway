import { test } from 'vitest';

import type { RestoredAssistantTurn } from '../../../../src/composition/reading.ts';
import { assignCallIds } from '../../../../src/composition/request/call-ids.ts';
import type { IRInputTurn } from '../../../../src/ir/input/types.ts';
import { chatLegacyCallsOf } from '../../../../src/protocols/openai-chat-completions/as-target/legacy-calls.ts';
import type { InputAssistantTurnFor } from '../../../../src/round-trip/input-assistant-turn.ts';
import { TranslateInputException } from '../../../../src/shared/input-error.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

type LegacyTurn = InputAssistantTurnFor<'openaiChatCompletions'>;
const legacy = (name: string): RestoredAssistantTurn<LegacyTurn> => ({ kind: 'restored', turn: { role: 'assistant', function_call: { name, arguments: '{}' } } });
const modern = (callId: string): RestoredAssistantTurn<LegacyTurn> => ({ kind: 'restored', turn: { role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'lookup', arguments: '{}' } }] } });
const mixed = (): RestoredAssistantTurn<LegacyTurn> => ({
  kind: 'restored',
  turn: {
    role: 'assistant',
    function_call: { name: 'legacy', arguments: '{}' },
    tool_calls: [{ id: 'modern-id', type: 'function', function: { name: 'modern', arguments: '{}' } }],
  },
});
const message = (text: string): IRInputTurn => ({ kind: 'client', items: [{ type: 'message', role: 'user', content: [{ type: 'text', text }] }] });
const result = (callId: string): IRInputTurn => ({ kind: 'client', items: [{ type: 'tool_result', call_id: callId, output: '' }] });
const namedResult = (name: string): IRInputTurn => ({ kind: 'client', items: [{ type: 'tool_result', name, output: '' }] });

test('the unique id-less result naming the legacy function answers it', () => {
  const { callIds, names } = chatLegacyCallsOf([legacy('lookup'), namedResult('lookup')]);
  assertEquals([...names.values()], ['lookup']);
  assertEquals(callIds.size, 1);
});

test('an answer naming a call the conversation states is left alone', () => {
  assertEquals(chatLegacyCallsOf([modern('native-1'), result('native-1')]).names.size, 0);
});

test('two id-less answers naming the legacy function are refused as ambiguous', () => {
  const twoAnswers: IRInputTurn = { kind: 'client', items: [{ type: 'tool_result', name: 'lookup', output: '' }, { type: 'tool_result', name: 'lookup', output: '' }] };
  assertThrows(() => chatLegacyCallsOf([legacy('lookup'), twoAnswers]), TranslateInputException);
});

test('a legacy call the next turn does not answer is refused', () => {
  // A wire that states no id for the call cannot say which later answer means it.
  assertThrows(() => chatLegacyCallsOf([legacy('lookup'), message('later')]), TranslateInputException);
});

test('a later uniquely named id-less result answers the legacy call', () => {
  const turns = [legacy('lookup'), message('chatter'), namedResult('lookup')];
  assertEquals([...chatLegacyCallsOf(turns).names.values()], ['lookup']);
});

test('a legacy call still awaiting its answer at the end is accepted', () => {
  // The conversation has not moved past the call, so nothing is missing yet.
  assertEquals(chatLegacyCallsOf([legacy('lookup')]).names.size, 0);
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

test('legacy matching wins over an earlier pending modern call of the same name', () => {
  const legacyTurn = legacy('lookup');
  const answer = namedResult('lookup');
  const turns = [modern('modern-id'), legacyTurn, answer];
  const legacyCalls = chatLegacyCallsOf(turns);
  const assigned = assignCallIds(turns, turn => [
    ...(turn.tool_calls ?? []).map(call => ({ callId: call.id, name: call.type === 'function' ? call.function.name : call.custom.name })),
    ...(turn.function_call == null ? [] : [{ callId: legacyCalls.callIds.get(turn)!, name: turn.function_call.name }]),
  ], { resultCallIds: legacyCalls.results });
  const client = assigned[2];
  assertEquals(client.kind === 'client' && client.items[0].type === 'tool_result' ? client.items[0].call_id : undefined, legacyCalls.callIds.get(legacyTurn.turn));
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

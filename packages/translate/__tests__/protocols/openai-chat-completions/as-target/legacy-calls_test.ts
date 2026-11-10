import { test } from 'vitest';

import type { IRInputTurn } from '../../../../src/ir/input/types.ts';
import type { ResolvedTurn } from '../../../../src/protocols/composition/segments.ts';
import { chatLegacyCallsOf } from '../../../../src/protocols/openai-chat-completions/as-target/legacy-calls.ts';
import type { InputAssistantTurnFor } from '../../../../src/round-trip/assistant-turn.ts';
import { TranslatorInputError } from '../../../../src/types.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

type LegacyTurn = InputAssistantTurnFor<'openaiChatCompletions'>;
const legacy = (name: string): ResolvedTurn<LegacyTurn> => ({ kind: 'resolved', turn: { role: 'assistant', function_call: { name, arguments: '{}' } } });
const modern = (callId: string): ResolvedTurn<LegacyTurn> => ({ kind: 'resolved', turn: { role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'lookup', arguments: '{}' } }] } });
const message = (text: string): IRInputTurn => ({ kind: 'client', items: [{ type: 'message', content: [{ type: 'text', text }] }] });
const result = (callId: string): IRInputTurn => ({ kind: 'client', items: [{ type: 'tool_result', call_id: callId, output: '' }] });

test('an answer naming no stated call is the one the legacy call gets', () => {
  // The client invented this id because the wire stated none for the call.
  const { callIds, names } = chatLegacyCallsOf([legacy('lookup'), result('client-invented')]);
  assertEquals([...names.entries()], [['client-invented', 'lookup']]);
  assertEquals(callIds.size, 1);
});

test('an answer naming a call the conversation states is left alone', () => {
  // A modern call names its own id, so its answer needs nothing here.
  assertEquals(chatLegacyCallsOf([modern('native-1'), result('native-1')]).names.size, 0);
});

test('two answers naming no stated call is refused as ambiguous', () => {
  // Neither can be told apart, so nothing says which answers the legacy call.
  const twoAnswers: IRInputTurn = { kind: 'client', items: [{ type: 'tool_result', call_id: 'a', output: '' }, { type: 'tool_result', call_id: 'b', output: '' }] };
  assertThrows(() => chatLegacyCallsOf([legacy('lookup'), twoAnswers]), TranslatorInputError);
});

test('a legacy call the next turn does not answer is refused', () => {
  // A wire that states no id for the call cannot say which later answer means it.
  assertThrows(() => chatLegacyCallsOf([legacy('lookup'), message('later')]), TranslatorInputError);
});

test('a legacy call answered in the turn after it, after other client content, is accepted', () => {
  const turn: IRInputTurn = { kind: 'client', items: [{ type: 'message', content: [{ type: 'text', text: 'chatter' }] }, { type: 'tool_result', call_id: 'client-invented', output: '' }] };
  assertEquals([...chatLegacyCallsOf([legacy('lookup'), turn]).names.entries()], [['client-invented', 'lookup']]);
});

test('a legacy call still awaiting its answer at the end is accepted', () => {
  // The conversation has not moved past the call, so nothing is missing yet.
  assertEquals(chatLegacyCallsOf([legacy('lookup')]).names.size, 0);
});

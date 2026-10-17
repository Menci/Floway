import { expect, test } from 'vitest';

import { computeOpenAIResponsesReplayCheck, createOpenAIResponsesSidecarCarrier, inspectOpenAIResponsesAssistantTurn, verifyOpenAIResponsesReplayCheck } from '../../../../src/protocols/openai-responses/as-source/round-trip.ts';
import type { OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';

test.each([false, true].flatMap(attached => [false, true].map(custom => ({ attached, custom }))))('Responses replay locates a carrier before expanded hosted calls (attached: $attached, custom: $custom)', async ({ attached, custom }) => {
  const reasoning: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'thought' }] };
  const call: OpenAIResponsesOutputItemEx = custom
    ? { type: 'custom_tool_call', call_id: 'call', name: 'client', input: 'custom input', status: 'completed' }
    : { type: 'function_call', call_id: 'call', name: 'web_search', arguments: ' { "query": "value" }\n', status: 'completed' };
  const carrier = attached ? { ...reasoning, encrypted_content: 'sidecar' } : createOpenAIResponsesSidecarCarrier('carrier', 'sidecar');
  const input: OpenAIResponsesOutputItemEx[] = attached ? [carrier, call] : [reasoning, carrier, call];
  const before = structuredClone(input);
  const check = await computeOpenAIResponsesReplayCheck([call, reasoning]);
  const inspection = inspectOpenAIResponsesAssistantTurn(input);
  expect(inspection).toEqual({ sidecar: 'sidecar', turn: [reasoning, call] });
  expect(await verifyOpenAIResponsesReplayCheck(inspection.turn, check)).toBe(true);
  expect(input).toEqual(before);
});

test('Responses replay preserves earlier opaque reasoning when extracting a nonterminal carrier', () => {
  const opaque: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'native', summary: [], encrypted_content: 'upstream-owned' };
  const call: OpenAIResponsesOutputItemEx = { type: 'function_call', call_id: 'call', name: 'search', arguments: '{}', status: 'completed' };
  const input = [opaque, createOpenAIResponsesSidecarCarrier('carrier', 'sidecar'), call];
  expect(inspectOpenAIResponsesAssistantTurn(input)).toEqual({ sidecar: 'sidecar', turn: [opaque, call] });
  expect(opaque.encrypted_content).toBe('upstream-owned');
});

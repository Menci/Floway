import { expect, test } from 'vitest';

import { toOpenAIResponsesInputAssistantTurn } from '../../../../src/protocols/openai-responses/as-target/assistant-turn.ts';
import type { OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';

test('keeps Responses state aligned when output-only items are removed', () => {
  const message: Extract<OpenAIResponsesOutputItemEx, { type: 'message' }> = {
    type: 'message', id: 'msg', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'answer', annotations: [] }],
  };
  const call = {
    type: 'function_call', id: 'fn', call_id: 'call', name: 'lookup', arguments: '{}', status: 'completed', parsed_arguments: {}, provider_specific_fields: { native: true },
  } satisfies Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }> & { parsed_arguments: object; provider_specific_fields: { native: boolean } };
  const output: OpenAIResponsesOutputItemEx[] = [
    { type: 'computer_call_output', call_id: 'failed', output: { type: 'computer_screenshot', file_id: 'screenshot' }, status: 'failed' },
    message,
    call,
  ];
  const state = [undefined, { content: [{ text: 'message-state' }] }, { arguments: 'tool-state' }];
  const input = toOpenAIResponsesInputAssistantTurn(output, state);

  expect(input.turn).toHaveLength(2);
  expect(input.turn[0]).toBe(message);
  expect(input.turn[1]).toEqual({ type: 'function_call', id: 'fn', call_id: 'call', name: 'lookup', arguments: '{}', status: 'completed', provider_specific_fields: { native: true } });
  expect(input.state).toEqual([state[1], state[2]]);
  expect(input.state[0]).toBe(state[1]);
  expect(input.state[1]).not.toBe(state[2]);
});

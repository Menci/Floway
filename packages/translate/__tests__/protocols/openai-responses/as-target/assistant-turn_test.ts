import { expect, test } from 'vitest';

import { toOpenAIResponsesInputAssistantTurn } from '../../../../src/protocols/openai-responses/as-target/assistant-turn.ts';
import type { OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';

test('normalizes Responses output into native history while preserving replayable fields', () => {
  const imageCall: Extract<OpenAIResponsesOutputItemEx, { type: 'image_generation_call' }> = {
    type: 'image_generation_call', id: 'ig-data', result: 'image-base64', status: 'completed', action: 'generate', output_format: 'png',
  };
  const messageWithSDKFields = {
    type: 'message', id: 'message-a', role: 'assistant', status: 'completed', phase: 'final_answer', created_by: 'sdk',
    content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 6 }], logprobs: [], parsed: { answer: true } }],
  } satisfies Extract<OpenAIResponsesOutputItemEx, { type: 'message' }> & { created_by: string; content: (Extract<Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>['content'][number], { type: 'output_text' }> & { parsed: { answer: boolean } })[] };
  const functionCallWithSDKFields = {
    type: 'function_call', id: 'function-a', call_id: 'call-a', name: 'lookup', arguments: '{"q":"a"}', parsed_arguments: { q: 'a' }, status: 'completed', created_by: 'sdk',
  } satisfies Extract<OpenAIResponsesOutputItemEx, { type: 'function_call' }> & { parsed_arguments: { q: string }; created_by: string };
  const outputHistory: OpenAIResponsesOutputItemEx[] = [
    messageWithSDKFields,
    functionCallWithSDKFields,
    { type: 'shell_call_output', id: 'shell-output', call_id: 'shell-call', output: [{ stdout: 'ok', stderr: '', outcome: { type: 'exit', exit_code: 0 }, created_by: 'sdk' }], status: 'completed', created_by: 'sdk' },
    { type: 'computer_call_output', call_id: 'computer-call', output: { type: 'computer_screenshot', file_id: 'screenshot' }, status: 'failed', created_by: 'sdk' },
    { type: 'custom_tool_call_output', call_id: 'custom-incomplete', output: 'incomplete', status: 'incomplete' },
    { type: 'custom_tool_call_output', id: 'custom-completed', call_id: 'custom-completed-call', output: 'complete', status: 'completed' },
    { type: 'additional_tools', id: 'additional-tools-developer', role: 'developer', tools: [] },
    { type: 'image_generation_call', id: 'ig-null', result: null, status: 'completed' },
    imageCall,
  ];
  expect(toOpenAIResponsesInputAssistantTurn(outputHistory)).toEqual([
    { type: 'message', id: 'message-a', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 6 }], logprobs: [] }] },
    { type: 'function_call', id: 'function-a', call_id: 'call-a', name: 'lookup', arguments: '{"q":"a"}', status: 'completed' },
    { type: 'shell_call_output', id: 'shell-output', call_id: 'shell-call', output: [{ stdout: 'ok', stderr: '', outcome: { type: 'exit', exit_code: 0 } }], status: 'completed' },
    { type: 'custom_tool_call_output', id: 'custom-completed', call_id: 'custom-completed-call', output: 'complete' },
    { type: 'additional_tools', id: 'additional-tools-developer', role: 'developer', tools: [] },
    { type: 'image_generation_call', id: 'ig-null', result: null, status: 'completed' },
    imageCall,
  ]);
});

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

import { expect, test } from 'vitest';

import { toOpenAIResponsesInputItems, type OpenAIResponsesOutputItemEx } from '../../src/openai-responses/index.ts';

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
  expect(toOpenAIResponsesInputItems(outputHistory)).toEqual([
    { type: 'message', id: 'message-a', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 6 }], logprobs: [] }] },
    { type: 'function_call', id: 'function-a', call_id: 'call-a', name: 'lookup', arguments: '{"q":"a"}', status: 'completed' },
    { type: 'shell_call_output', id: 'shell-output', call_id: 'shell-call', output: [{ stdout: 'ok', stderr: '', outcome: { type: 'exit', exit_code: 0 } }], status: 'completed' },
    { type: 'custom_tool_call_output', id: 'custom-completed', call_id: 'custom-completed-call', output: 'complete' },
    { type: 'additional_tools', id: 'additional-tools-developer', role: 'developer', tools: [] },
    { type: 'image_generation_call', id: 'ig-null', result: null, status: 'completed' },
    imageCall,
  ]);
});

import { test } from 'vitest';

import { openAIResponsesStages } from '../../../src/stages/openai-responses/index.ts';
import { inspectRequestStage } from '../../pipeline-fixture.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

test('OpenAI Responses initiator is user for a final developer message', async () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ],
  };

  assertEquals((await inspectRequestStage(openAIResponsesStages, 'set-initiator-header', payload)).headers.get('x-initiator'), 'user');
});

test('OpenAI Responses initiator is agent when the last input item is a function_call_output', async () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'do the thing' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'do_thing',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'done',
      },
    ],
  };

  assertEquals((await inspectRequestStage(openAIResponsesStages, 'set-initiator-header', payload)).headers.get('x-initiator'), 'agent');
});

test('OpenAI Responses initiator is agent when the last input item is an assistant message replay', async () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'previous answer' }],
      },
    ],
  };

  assertEquals((await inspectRequestStage(openAIResponsesStages, 'set-initiator-header', payload)).headers.get('x-initiator'), 'agent');
});

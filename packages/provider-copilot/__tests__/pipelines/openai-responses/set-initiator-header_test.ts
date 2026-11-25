import { test } from 'vitest';

import { setInitiatorHeader } from '../../../src/pipelines/openai-responses/set-initiator-header.ts';
import { runStage, type StageRequest } from '../stage.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const requestFor = (payload: CanonicalOpenAIResponsesPayload): StageRequest<'openaiResponses'> => ({
  payload,
  headers: new Headers(),
});

test('OpenAI Responses initiator is user for a final developer message', async () => {
  const request = requestFor({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ],
  });

  const result = await runStage(setInitiatorHeader, 'openaiResponses', request);

  assertEquals(result.headers.get('x-initiator'), 'user');
});

test('OpenAI Responses initiator is agent when the last input item is a function_call_output', async () => {
  const request = requestFor({
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
  });

  const result = await runStage(setInitiatorHeader, 'openaiResponses', request);

  assertEquals(result.headers.get('x-initiator'), 'agent');
});

test('OpenAI Responses initiator is agent when the last input item is an assistant message replay', async () => {
  const request = requestFor({
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
  });

  const result = await runStage(setInitiatorHeader, 'openaiResponses', request);

  assertEquals(result.headers.get('x-initiator'), 'agent');
});

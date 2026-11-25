import { test } from 'vitest';

import { setInitiatorHeader } from '../../../src/pipelines/openai-responses/set-initiator-header.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const invocation = (payload: CanonicalOpenAIResponsesPayload): StageFixture<'openaiResponses'> => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiResponses: {} } }),
});

test('OpenAI Responses initiator is user for a final developer message', async () => {
  const fixture = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ],
  });

  const ctx = await inspectStages('openaiResponses', setInitiatorHeader('openaiResponses'), fixture);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
});

test('OpenAI Responses initiator is agent when the last input item is a function_call_output', async () => {
  const fixture = invocation({
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

  const ctx = await inspectStages('openaiResponses', setInitiatorHeader('openaiResponses'), fixture);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});

test('OpenAI Responses initiator is agent when the last input item is an assistant message replay', async () => {
  const fixture = invocation({
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

  const ctx = await inspectStages('openaiResponses', setInitiatorHeader('openaiResponses'), fixture);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});

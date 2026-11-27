import { test } from 'vitest';

import { withInitiatorHeaderSet } from '../../../src/interceptors/openai-responses/set-initiator-header.ts';
import type { OpenAIResponsesBoundaryCtx } from '../../../src/interceptors/openai-responses/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assertEquals, stubUpstreamModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { ExecuteResult } from '@floway-dev/upstream';
import { eventResult } from '@floway-dev/upstream';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {})(), testTelemetryModelIdentity));

const invocation = (payload: CanonicalOpenAIResponsesPayload): OpenAIResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubUpstreamModel({ endpoints: { openaiResponses: {} } }),
  action: 'generate',
});

test('OpenAI Responses initiator is user for a final developer message', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
});

test('OpenAI Responses initiator is agent when the last input item is a function_call_output', async () => {
  const ctx = invocation({
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

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});

test('OpenAI Responses initiator is agent when the last input item is an assistant message replay', async () => {
  const ctx = invocation({
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

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});

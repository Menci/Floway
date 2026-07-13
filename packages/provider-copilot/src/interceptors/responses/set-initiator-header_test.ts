import { test } from 'vitest';

import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: CanonicalResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

test.each(['user', 'system', 'developer'] as const)('Responses initiator is user for a final %s message', async role => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role,
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
});

test('Responses initiator is user when input is an empty array', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [] });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
});

test('Responses initiator is user for the role-bearing additional_tools item', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [{
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'function', name: 'lookup', parameters: {}, strict: false }],
    }],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'user');
});

test('Responses initiator is agent when the last input item is a function_call_output', async () => {
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

test('Responses initiator is agent when the last input item is a custom_tool_call_output', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'run the freeform tool' }],
      },
      {
        type: 'custom_tool_call',
        call_id: 'call_custom',
        name: 'lookup',
        input: 'Tokyo',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_custom',
        output: 'sunny',
      },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});

test('Responses initiator is agent when the last canonical item is reasoning', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'search the web' }],
      },
      { type: 'reasoning', id: 'rs_1', summary: [] },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-initiator'), 'agent');
});

test('Responses initiator is agent when the last input item is an assistant message replay', async () => {
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

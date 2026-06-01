import { test } from 'vitest';

import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { RequestContext, ResponsesInvocation } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesInputItem, ResponsesPayload, RawResponsesStreamEvent } from '@floway-dev/protocols/responses';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  statefulResponsesContext: { privatePayload: new Map(), newSyntheticIds: new Set() },  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<RawResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: ResponsesPayload): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: 'responses',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

test('Responses initiator is user when the last input item is a plain user message', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'user');
});

test('Responses initiator is user when input is a plain string', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: 'plain string input',
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'user');
});

test('Responses initiator is user when input is an empty array', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [] });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'user');
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

  assertEquals(ctx.headers['x-initiator'], 'agent');
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

  assertEquals(ctx.headers['x-initiator'], 'agent');
});

test('Responses initiator is agent when the last input item is a hosted-tool output without a role field', async () => {
  // Future / non-canonical hosted-tool output shapes (e.g. `tool_search_output`)
  // are not in our `ResponsesInputItem` union but they reach Copilot's wire shape
  // in the wild. They have no `role` field, which is exactly the discriminator
  // caozhiyuan/copilot-api uses to classify them as agent-initiated.
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'search the web' }],
      },
      { type: 'tool_search_output', output: 'result' } as unknown as ResponsesInputItem,
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'agent');
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

  assertEquals(ctx.headers['x-initiator'], 'agent');
});

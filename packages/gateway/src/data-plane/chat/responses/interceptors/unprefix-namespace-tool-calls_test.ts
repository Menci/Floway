import { test } from 'vitest';

import type { ResponsesInvocation } from './types.ts';
import { withUnprefixNamespaceToolCalls } from './unprefix-namespace-tool-calls.ts';
import { mockChatGatewayCtx } from '../../../../test-helpers/gateway-ctx.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputFunctionCall, ResponsesOutputCustomToolCall, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ExecuteResult, eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const stubCtx = mockChatGatewayCtx();

const invocation = (enabledFlags: ReadonlySet<FlagId> = new Set(['flatten-tool-search-family'])): ResponsesInvocation => ({
  payload: { model: 'gpt-test', input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }] } as CanonicalResponsesPayload,
  action: 'generate',
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'responses',
  headers: new Headers(),
});

const functionCall = (name: string): ResponsesOutputFunctionCall => ({
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name,
  arguments: '{}',
  status: 'completed',
});

const customToolCall = (name: string, namespace?: string): ResponsesOutputCustomToolCall => ({
  type: 'custom_tool_call',
  id: 'ctc_1',
  call_id: 'call_2',
  name,
  input: 'freeform',
  ...(namespace !== undefined ? { namespace } : {}),
});

const runStream = (events: readonly ResponsesStreamEvent[]) =>
  (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> =>
    Promise.resolve(eventResult(
      (async function* () {
        for (const event of events) yield eventFrame(event);
      })(),
      testTelemetryModelIdentity,
    ));

const collect = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>) => {
  const out: ResponsesStreamEvent[] = [];
  for await (const frame of events) if (frame.type === 'event') out.push(frame.event);
  return out;
};

test('strips <namespace>__ prefix on function_call output items (no namespace field on the schema)', async () => {
  const inputEvent: ResponsesStreamEvent = {
    type: 'response.output_item.done',
    output_index: 0,
    item: functionCall('collab__spawn_agent'),
  };
  const res = await withUnprefixNamespaceToolCalls(invocation(), stubCtx, runStream([inputEvent]));
  if (res.type !== 'events') throw new Error('expected events');
  const [event] = await collect(res.events);
  if (event.type !== 'response.output_item.done') throw new Error('expected output_item.done');
  const item = event.item as ResponsesOutputFunctionCall;
  assertEquals(item.name, 'spawn_agent');
  assertEquals((item as unknown as { namespace?: string }).namespace, undefined);
});

test('strips prefix and populates `namespace` on custom_tool_call output items', async () => {
  const inputEvent: ResponsesStreamEvent = {
    type: 'response.output_item.done',
    output_index: 0,
    item: customToolCall('collab__exec_custom'),
  };
  const res = await withUnprefixNamespaceToolCalls(invocation(), stubCtx, runStream([inputEvent]));
  if (res.type !== 'events') throw new Error('expected events');
  const [event] = await collect(res.events);
  if (event.type !== 'response.output_item.done') throw new Error('expected output_item.done');
  const item = event.item as ResponsesOutputCustomToolCall;
  assertEquals(item.name, 'exec_custom');
  assertEquals(item.namespace, 'collab');
});

test('leaves function_call names without `__` untouched', async () => {
  const inputEvent: ResponsesStreamEvent = {
    type: 'response.output_item.done',
    output_index: 0,
    item: functionCall('plain_tool'),
  };
  const res = await withUnprefixNamespaceToolCalls(invocation(), stubCtx, runStream([inputEvent]));
  if (res.type !== 'events') throw new Error('expected events');
  const [event] = await collect(res.events);
  if (event.type !== 'response.output_item.done') throw new Error('expected output_item.done');
  assertEquals((event.item as ResponsesOutputFunctionCall).name, 'plain_tool');
});

test('rewrites function_call inside response.completed envelope', async () => {
  const inputEvent: ResponsesStreamEvent = {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      object: 'response',
      model: 'gpt-test',
      status: 'completed',
      output: [
        functionCall('collab__spawn_agent'),
        customToolCall('sub__inner'),
      ],
      output_text: '',
      error: null,
      incomplete_details: null,
    },
  };
  const res = await withUnprefixNamespaceToolCalls(invocation(), stubCtx, runStream([inputEvent]));
  if (res.type !== 'events') throw new Error('expected events');
  const [event] = await collect(res.events);
  if (event.type !== 'response.completed') throw new Error('expected response.completed');
  const [fnItem, customItem] = event.response.output;
  assertEquals((fnItem as ResponsesOutputFunctionCall).name, 'spawn_agent');
  assertEquals((customItem as ResponsesOutputCustomToolCall).name, 'inner');
  assertEquals((customItem as ResponsesOutputCustomToolCall).namespace, 'sub');
});

test('flag off: passes events through untouched even when names carry `__`', async () => {
  const inputEvent: ResponsesStreamEvent = {
    type: 'response.output_item.done',
    output_index: 0,
    item: functionCall('collab__spawn_agent'),
  };
  const res = await withUnprefixNamespaceToolCalls(invocation(new Set()), stubCtx, runStream([inputEvent]));
  if (res.type !== 'events') throw new Error('expected events');
  const [event] = await collect(res.events);
  if (event.type !== 'response.output_item.done') throw new Error('expected output_item.done');
  assertEquals((event.item as ResponsesOutputFunctionCall).name, 'collab__spawn_agent');
});

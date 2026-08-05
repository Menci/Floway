import { expect, test } from 'vitest';

import { withPlaintextCollaboration } from '../../../../../src/data-plane/chat/responses/interceptors/plaintext-collaboration.ts';
import type { ResponsesInvocation } from '../../../../../src/data-plane/chat/responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputFunctionCall, ResponsesResult, ResponsesStreamEvent, ResponsesTool } from '@floway-dev/protocols/responses';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string' },
    message: { type: 'string', encrypted: true },
  },
  required: ['target', 'message'],
};

const collaborationTool = (): ResponsesTool => ({
  type: 'namespace',
  name: 'collaboration',
  tools: [
    { type: 'function', name: 'spawn_agent', parameters: MESSAGE_SCHEMA },
    { type: 'function', name: 'send_message', parameters: MESSAGE_SCHEMA },
    { type: 'function', name: 'followup_task', parameters: MESSAGE_SCHEMA },
    { type: 'function', name: 'list_agents', parameters: { type: 'object', properties: {} } },
  ],
} as ResponsesTool);

const invocation = (targetApi: ResponsesInvocation['targetApi'] = 'responses'): ResponsesInvocation => ({
  payload: {
    model: 'model',
    input: [{
      type: 'function_call',
      id: 'fc_history',
      call_id: 'call_history',
      namespace: 'collaboration',
      name: 'send_message',
      arguments: '{"target":"worker","message":"prior plaintext"}',
      encrypted_function_args: [],
      status: 'completed',
    }],
    tools: [collaborationTool()],
    tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'namespace', name: 'collaboration' }] },
  },
  candidate: stubModelCandidate(),
  targetApi,
  headers: new Headers(),
  action: 'generate',
});

const response = (output: ResponsesOutputFunctionCall[], tools: ResponsesTool[], namespace: string): ResponsesResult => ({
  id: 'resp_1',
  object: 'response',
  model: 'model',
  status: 'completed',
  output,
  tools,
  tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'namespace', name: namespace }] },
  error: null,
  incomplete_details: null,
});

test('projects reserved collaboration onto a plaintext upstream namespace and restores every response surface', async () => {
  const ctx = invocation();
  let upstreamPayload: ResponsesInvocation['payload'] | undefined;
  const result = await withPlaintextCollaboration(ctx, mockChatGatewayCtx(), async () => {
    upstreamPayload = structuredClone(ctx.payload);
    const namespace = (ctx.payload.tools?.[0] as { name: string }).name;
    const spawn: ResponsesOutputFunctionCall = {
      type: 'function_call',
      id: 'fc_spawn',
      call_id: 'call_spawn',
      namespace,
      name: 'spawn_agent',
      arguments: '{"task_name":"worker","message":"inspect affinity"}',
      status: 'completed',
    };
    const list: ResponsesOutputFunctionCall = {
      type: 'function_call',
      id: 'fc_list',
      call_id: 'call_list',
      namespace,
      name: 'list_agents',
      arguments: '{}',
      status: 'completed',
    };
    return eventResult((async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: { ...spawn, arguments: '', status: 'in_progress' } });
      yield eventFrame({ type: 'response.function_call_arguments.delta', item_id: 'fc_spawn', output_index: 0, delta: spawn.arguments });
      yield eventFrame({ type: 'response.function_call_arguments.done', item_id: 'fc_spawn', output_index: 0, arguments: spawn.arguments });
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: spawn });
      yield eventFrame({ type: 'response.output_item.done', output_index: 1, item: list });
      yield eventFrame({ type: 'response.completed', response: response([spawn, list], ctx.payload.tools ?? [], namespace) });
    })(), testTelemetryModelIdentity);
  });

  if (upstreamPayload === undefined) throw new Error('Expected upstream payload');
  const upstreamNamespace = (upstreamPayload.tools?.[0] as { name: string }).name;
  expect(upstreamNamespace).toMatch(/^floway_collaboration_[0-9a-f]{32}$/);
  const upstreamNamespaceTool = upstreamPayload.tools?.[0] as unknown as { tools: Array<{ name: string; parameters?: Record<string, unknown> }> };
  for (const tool of upstreamNamespaceTool.tools.filter(tool => ['spawn_agent', 'send_message', 'followup_task'].includes(tool.name))) {
    expect((tool.parameters?.properties as Record<string, Record<string, unknown>>).message).not.toHaveProperty('encrypted');
  }
  const history = upstreamPayload.input[0];
  if (history.type !== 'function_call') throw new Error('Expected function call history');
  expect(history.namespace).toBe(upstreamNamespace);
  expect(history).not.toHaveProperty('encrypted_function_args');
  expect(history.arguments).toContain('prior plaintext');

  if (result.type !== 'events') throw new Error('Expected events');
  const events: ResponsesStreamEvent[] = [];
  for await (const frame of result.events) {
    if (frame.type === 'event') events.push(frame.event);
  }
  const deltas = events.filter(event => event.type === 'response.function_call_arguments.delta');
  const doneArguments = events.filter(event => event.type === 'response.function_call_arguments.done');
  assertEquals(deltas[0]?.delta, '{"task_name":"worker","message":"inspect affinity"}');
  assertEquals(doneArguments[0]?.arguments, deltas[0]?.delta);

  const doneItems = events.flatMap(event => event.type === 'response.output_item.done' ? [event.item] : []);
  expect(doneItems[0]).toMatchObject({
    namespace: 'collaboration',
    name: 'spawn_agent',
    encrypted_function_args: [],
  });
  expect(doneItems[1]).toMatchObject({ namespace: 'collaboration', name: 'list_agents' });
  expect(doneItems[1]).not.toHaveProperty('encrypted_function_args');

  const terminal = events.at(-1);
  if (terminal?.type !== 'response.completed') throw new Error('Expected terminal response');
  expect(terminal.response.output[0]).toMatchObject({ namespace: 'collaboration', encrypted_function_args: [] });
  const restoredNamespace = terminal.response.tools?.[0] as unknown as { name: string; tools: Array<{ name: string; parameters?: Record<string, unknown> }> };
  expect(restoredNamespace.name).toBe('collaboration');
  expect((restoredNamespace.tools[0].parameters?.properties as Record<string, Record<string, unknown>>).message.encrypted).toBe(true);
  expect(terminal.response.tool_choice).toMatchObject({ tools: [{ type: 'namespace', name: 'collaboration' }] });
});

test('leaves translated targets unchanged', async () => {
  const ctx = invocation('messages');
  const original = structuredClone(ctx.payload);
  await withPlaintextCollaboration(ctx, mockChatGatewayCtx(), async () =>
    eventResult((async function* () {})(), testTelemetryModelIdentity));
  expect(ctx.payload).toEqual(original);
});

test('rejects ambiguous duplicate collaboration namespaces', async () => {
  const ctx = invocation();
  ctx.payload = { ...ctx.payload, tools: [collaborationTool(), collaborationTool()] };
  await expect(withPlaintextCollaboration(ctx, mockChatGatewayCtx(), async () =>
    eventResult((async function* () {})(), testTelemetryModelIdentity))).rejects.toThrow(
    'Responses request carries multiple collaboration namespaces in one tool inventory',
  );
});

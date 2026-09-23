import { expect, test } from 'vitest';

import { withOpenAIResponsesCollaborationShim } from '../../../../../src/data-plane/chat/openai-responses/interceptors/collaboration-shim.ts';
import { withOpenAIResponsesServerToolShim } from '../../../../../src/data-plane/chat/openai-responses/interceptors/server-tool-shim.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesOutputFunctionCall, OpenAIResponsesOutputItem, OpenAIResponsesResult, OpenAIResponsesStreamEvent, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
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

const collaborationTool = (): OpenAIResponsesTool => ({
  type: 'namespace',
  name: 'collaboration',
  description: '',
  tools: [
    { type: 'function', name: 'spawn_agent', parameters: MESSAGE_SCHEMA },
    { type: 'function', name: 'send_message', parameters: MESSAGE_SCHEMA },
    { type: 'function', name: 'followup_task', parameters: MESSAGE_SCHEMA },
    { type: 'function', name: 'list_agents', parameters: { type: 'object', properties: {} } },
  ],
} as OpenAIResponsesTool);

const invocation = (targetApi: OpenAIResponsesInvocation['targetApi'] = 'openaiResponses'): OpenAIResponsesInvocation => ({
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
    tool_choice: {
      type: 'allowed_tools',
      mode: 'auto',
      tools: [
        { type: 'namespace', name: 'collaboration' },
        { type: 'function', name: 'collaboration.spawn_agent' },
        { type: 'custom', name: 'collaboration.audit' },
        { type: 'namespace', name: 'collaboration.audit' },
      ],
    },
  },
  candidate: stubModelCandidate({ enabledFlags: new Set(['openai-responses-collaboration-shim']) }),
  targetApi,
  headers: new Headers(),
  action: 'generate',
});

const response = (output: OpenAIResponsesOutputItem[], tools: OpenAIResponsesTool[], namespace: string): OpenAIResponsesResult => ({
  id: 'resp_1',
  object: 'response',
  model: 'model',
  status: 'completed',
  output,
  tools,
  tool_choice: {
    type: 'allowed_tools',
    mode: 'auto',
    tools: [
      { type: 'namespace', name: namespace },
      { type: 'function', name: `${namespace}.spawn_agent` },
      { type: 'custom', name: 'collaboration.audit' },
      { type: 'namespace', name: 'collaboration.audit' },
    ],
  },
  error: null,
  incomplete_details: null,
});

test('projects reserved collaboration onto a plaintext upstream namespace and restores every response surface', async () => {
  const ctx = invocation();
  let upstreamPayload: OpenAIResponsesInvocation['payload'] | undefined;
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    upstreamPayload = structuredClone(ctx.payload);
    const namespace = (ctx.payload.tools?.[0] as { name: string }).name;
    const spawn: OpenAIResponsesOutputFunctionCall = {
      type: 'function_call',
      id: 'fc_spawn',
      call_id: 'call_spawn',
      namespace,
      name: 'spawn_agent',
      arguments: '{"task_name":"worker","message":"inspect affinity"}',
      status: 'completed',
    };
    const list: OpenAIResponsesOutputFunctionCall = {
      type: 'function_call',
      id: 'fc_list',
      call_id: 'call_list',
      namespace,
      name: 'list_agents',
      arguments: '{}',
      status: 'completed',
    };
    return eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
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
  expect(upstreamNamespace).toBe('collaboration-optimize');
  const upstreamNamespaceTool = upstreamPayload.tools?.[0] as unknown as { tools: Array<{ name: string; parameters?: Record<string, unknown> }> };
  for (const tool of upstreamNamespaceTool.tools.filter(tool => ['spawn_agent', 'send_message', 'followup_task'].includes(tool.name))) {
    expect((tool.parameters?.properties as Record<string, Record<string, unknown>>).message).not.toHaveProperty('encrypted');
  }
  const history = upstreamPayload.input[0];
  if (history.type !== 'function_call') throw new Error('Expected function call history');
  expect(history.namespace).toBe(upstreamNamespace);
  expect(history).not.toHaveProperty('encrypted_function_args');
  expect(history.arguments).toContain('prior plaintext');
  expect(upstreamPayload.tool_choice).toMatchObject({
    tools: [
      { type: 'namespace', name: 'collaboration-optimize' },
      { type: 'function', name: 'collaboration-optimize.spawn_agent' },
      { type: 'custom', name: 'collaboration.audit' },
      { type: 'namespace', name: 'collaboration.audit' },
    ],
  });

  if (result.type !== 'events') throw new Error('Expected events');
  const events: OpenAIResponsesStreamEvent[] = [];
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
  expect((restoredNamespace.tools[0].parameters?.properties as Record<string, Record<string, unknown>>).message).not.toHaveProperty('encrypted');
  expect(terminal.response.tool_choice).toMatchObject({
    tools: [
      { type: 'namespace', name: 'collaboration' },
      { type: 'function', name: 'collaboration.spawn_agent' },
      { type: 'custom', name: 'collaboration.audit' },
      { type: 'namespace', name: 'collaboration.audit' },
    ],
  });
  expect(ctx.payload).toEqual(upstreamPayload);
});

test('uses a deterministic collision suffix and leaves the projected context for downstream turns', async () => {
  const ctx = invocation();
  ctx.payload = {
    ...ctx.payload,
    tools: [
      ...(ctx.payload.tools ?? []),
      { type: 'namespace', name: 'collaboration-optimize', description: '', tools: [] } as OpenAIResponsesTool,
    ],
  };
  await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    expect((ctx.payload.tools?.[0] as { name: string }).name).toBe('collaboration-optimize-2');
    const choice = ctx.payload.tool_choice as unknown as { tools: Array<{ name: string }> };
    expect(choice.tools[1].name).toBe('collaboration-optimize-2.spawn_agent');
    return eventResult((async function* () {})(), testTelemetryModelIdentity);
  });
  expect((ctx.payload.tools?.[0] as { name: string }).name).toBe('collaboration-optimize-2');
});

test('projects Messages targets through the same plaintext namespace', async () => {
  const ctx = invocation('anthropicMessages');
  ctx.payload = { ...ctx.payload, tool_choice: 'auto' };
  await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    expect((ctx.payload.tools?.[0] as { name: string }).name).toBe('collaboration-optimize');
    const namespace = ctx.payload.tools?.[0] as unknown as { tools: Array<{ parameters: { properties: { message: Record<string, unknown> } } }> };
    expect(namespace.tools[0].parameters.properties.message).not.toHaveProperty('encrypted');
    return eventResult((async function* () {})(), testTelemetryModelIdentity);
  });
  expect((ctx.payload.tools?.[0] as { name: string }).name).toBe('collaboration-optimize');
});

test('projects Chat Completions targets through the same plaintext namespace', async () => {
  const ctx = invocation('openaiChatCompletions');
  ctx.payload = { ...ctx.payload, tool_choice: 'auto' };
  await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    expect((ctx.payload.tools?.[0] as { name: string }).name).toBe('collaboration-optimize');
    return eventResult((async function* () {})(), testTelemetryModelIdentity);
  });
});

test('projects history-only collaboration calls independently of target protocol', async () => {
  const ctx = invocation();
  ctx.payload = { ...ctx.payload, tools: undefined, tool_choice: undefined };
  await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    const item = ctx.payload.input[0];
    expect(item).toMatchObject({ type: 'function_call', namespace: 'collaboration-optimize' });
    expect(item).not.toHaveProperty('encrypted_function_args');
    return eventResult((async function* () {})(), testTelemetryModelIdentity);
  });
  expect(ctx.payload.input[0]).toMatchObject({ type: 'function_call', namespace: 'collaboration-optimize' });

  const chatCtx = invocation('openaiChatCompletions');
  chatCtx.payload = { ...chatCtx.payload, tools: undefined, tool_choice: undefined };
  await withOpenAIResponsesCollaborationShim(chatCtx, mockChatGatewayCtx(), async () => {
    expect(chatCtx.payload.input[0]).toMatchObject({ type: 'function_call', namespace: 'collaboration-optimize' });
    return eventResult((async function* () {})(), testTelemetryModelIdentity);
  });
});

test('keeps one plaintext projection across a multi-turn downstream loop', async () => {
  const ctx = invocation();
  const namespaces: string[] = [];
  const upstreamTurn = async (output?: OpenAIResponsesOutputFunctionCall) => {
    namespaces.push((ctx.payload.tools?.[0] as { name: string }).name);
    return eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      if (output !== undefined) yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: output });
    })(), testTelemetryModelIdentity);
  };
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    await upstreamTurn();
    ctx.payload = {
      ...ctx.payload,
      input: [
        ...ctx.payload.input,
        {
          type: 'function_call',
          call_id: 'call_next',
          namespace: 'collaboration-optimize',
          name: 'send_message',
          arguments: '{"target":"worker","message":"next turn"}',
          status: 'completed',
        },
      ],
    };
    const output: OpenAIResponsesOutputFunctionCall = {
      type: 'function_call',
      id: 'fc_next',
      call_id: 'call_next',
      namespace: 'collaboration-optimize',
      name: 'send_message',
      arguments: '{"target":"worker","message":"done"}',
      status: 'completed',
    };
    return await upstreamTurn(output);
  });

  expect(namespaces).toEqual(['collaboration-optimize', 'collaboration-optimize']);
  expect(ctx.payload.input[1]).toMatchObject({ namespace: 'collaboration-optimize' });
  if (result.type !== 'events') throw new Error('Expected events');
  for await (const frame of result.events) {
    if (frame.type !== 'event' || frame.event.type !== 'response.output_item.done') continue;
    expect(frame.event.item).toMatchObject({ namespace: 'collaboration', encrypted_function_args: [] });
  }
});

test('projects duplicate collaboration containers together and preserves their separate declarations', async () => {
  const ctx = invocation();
  const tool = collaborationTool();
  if (tool.type !== 'namespace') throw new Error('Expected namespace');
  ctx.payload.tools = [
    { ...tool, tools: tool.tools.slice(0, 2) },
    { ...tool, tools: tool.tools.slice(2) },
  ];
  const original = structuredClone(ctx.payload.tools);
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    expect(ctx.payload.tools?.map(tool => tool.type === 'namespace' ? tool.name : undefined)).toEqual(['collaboration-optimize', 'collaboration-optimize']);
    return eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.completed', response: response([], ctx.payload.tools ?? [], 'collaboration-optimize') });
    })(), testTelemetryModelIdentity);
  });
  if (result.type !== 'events') throw new Error('Expected events');
  for await (const frame of result.events) {
    if (frame.type !== 'event' || frame.event.type !== 'response.completed') continue;
    const tools = frame.event.response.tools;
    expect(tools).toHaveLength(2);
    expect(tools?.map(tool => tool.type === 'namespace' ? tool.name : undefined)).toEqual(['collaboration', 'collaboration']);
    expect(tools?.map(tool => tool.type === 'namespace' ? tool.tools.map(child => child.name) : [])).toEqual(
      original.map(tool => tool.type === 'namespace' ? tool.tools.map(child => child.name) : []),
    );
  }
});

test.each([null, ['message']] as const)('rejects explicitly encrypted history marker %j', async marker => {
  const ctx = invocation();
  const item = ctx.payload.input[0];
  if (item.type !== 'function_call') throw new Error('Expected function call');
  ctx.payload = {
    ...ctx.payload,
    input: [{ ...item, encrypted_function_args: marker === null ? null : [...marker] }],
  };
  await expect(withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () =>
    eventResult((async function* () {})(), testTelemetryModelIdentity))).rejects.toThrow(
    'Cannot project encrypted collaboration history',
  );
});

test('projects deferred tool-search inventories without a top-level tool list', async () => {
  const ctx = invocation();
  ctx.payload = {
    ...ctx.payload,
    tools: undefined,
    input: [{ type: 'tool_search_output', id: 'tso_1', tools: [collaborationTool()] }],
  };
  let upstreamItem: unknown;
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    upstreamItem = structuredClone(ctx.payload.input[0]);
    const item = ctx.payload.input[0];
    if (item.type !== 'tool_search_output') throw new Error('Expected tool-search output');
    return eventResult((async function* () {
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
      yield eventFrame({ type: 'response.completed', response: response([item], [], 'collaboration-optimize') });
    })(), testTelemetryModelIdentity);
  });

  expect(upstreamItem).toMatchObject({ tools: [{ name: 'collaboration-optimize' }] });
  if (result.type !== 'events') throw new Error('Expected events');
  const items: OpenAIResponsesOutputItem[] = [];
  for await (const frame of result.events) {
    if (frame.type === 'event' && frame.event.type === 'response.output_item.done') items.push(frame.event.item);
  }
  expect(items[0]).toMatchObject({ tools: [{ name: 'collaboration' }] });
});

test('rejects an upstream encrypted marker before labeling the call plaintext', async () => {
  const ctx = invocation();
  const output = {
    type: 'function_call' as const,
    id: 'fc_1',
    call_id: 'call_1',
    namespace: 'collaboration-optimize',
    name: 'spawn_agent',
    arguments: '{"message":"opaque"}',
    encrypted_function_args: ['message'],
    status: 'completed',
  };
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () =>
    eventResult((async function* () {
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: output });
    })(), testTelemetryModelIdentity));
  if (result.type !== 'events') throw new Error('Expected events');
  await expect(async () => {
    for await (const _frame of result.events) { /* consume */ }
  }).rejects.toThrow('Plaintext collaboration upstream returned encrypted arguments');
});

test('preserves explicit null tools in response snapshots', async () => {
  const ctx = invocation();
  const snapshot = {
    ...response([], [], 'collaboration-optimize'),
    tools: null,
  } as unknown as OpenAIResponsesResult;
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () =>
    eventResult((async function* () {
      yield eventFrame({ type: 'response.completed', response: snapshot });
    })(), testTelemetryModelIdentity));
  if (result.type !== 'events') throw new Error('Expected events');
  for await (const frame of result.events) {
    if (frame.type !== 'event' || frame.event.type !== 'response.completed') continue;
    expect(Object.hasOwn(frame.event.response, 'tools')).toBe(true);
    expect((frame.event.response as unknown as { tools: null }).tools).toBeNull();
  }
});

test('preserves the complete contract when the provider flag is disabled', async () => {
  const ctx = { ...invocation(), candidate: stubModelCandidate({ enabledFlags: new Set() }) };
  const before = ctx.payload;
  await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    expect(ctx.payload).toBe(before);
    return eventResult((async function* () {})(), testTelemetryModelIdentity);
  });
});

test('allocates against deferred inventories, qualified selectors and replay references', async () => {
  const ctx = invocation();
  ctx.payload.input.push(
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'collaboration-optimize.audit' }] },
    { type: 'function_call', call_id: 'foreign', namespace: 'collaboration-optimize-2', name: 'audit', arguments: '{}', status: 'completed' },
    { type: 'tool_search_output', id: 'search', tools: [{ type: 'namespace', name: 'collaboration-optimize-3', description: '', tools: [] }] },
  );
  ctx.payload.tool_choice = { type: 'function', name: 'collaboration-optimize-4.audit' };
  await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    expect(ctx.payload.tools?.[0]).toMatchObject({ name: 'collaboration-optimize-5' });
    return eventResult((async function* () {})(), testTelemetryModelIdentity);
  });
});

test('exhausts bounded alias allocation atomically', async () => {
  const ctx = invocation();
  ctx.payload.tools?.push(...Array.from({ length: 1000 }, (_, i): OpenAIResponsesTool => ({
    type: 'namespace', name: i === 0 ? 'collaboration-optimize' : `collaboration-optimize-${i + 1}`, description: '', tools: [],
  })));
  const before = ctx.payload;
  await expect(withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    throw new Error('Must not reach upstream');
  })).rejects.toThrow('within 1000 attempts');
  expect(ctx.payload).toBe(before);
});

test.each(['.', '__'])('restores qualified upstream calls using %s without touching opaque values', async separator => {
  const ctx = invocation();
  const opaque = JSON.stringify({ namespace: 'collaboration-optimize', name: 'spawn_agent' });
  const output: OpenAIResponsesOutputFunctionCall = {
    type: 'function_call', call_id: 'qualified', name: `collaboration-optimize${separator}spawn_agent`, arguments: opaque, status: 'completed',
  };
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () =>
    eventResult((async function* () {
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: output });
    })(), testTelemetryModelIdentity));
  if (result.type !== 'events') throw new Error('Expected events');
  for await (const frame of result.events) {
    if (frame.type === 'event' && frame.event.type === 'response.output_item.done') {
      expect(frame.event.item).toMatchObject({ namespace: 'collaboration', name: 'spawn_agent', arguments: opaque, encrypted_function_args: [] });
    }
  }
});

test.each([null, ['message'], 'message', false])('rejects encrypted sparse argument completion %j using earlier identity', async marker => {
  const ctx = invocation();
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () =>
    eventResult((async function* () {
      yield eventFrame({
        type: 'response.output_item.added', output_index: 0, item: {
          type: 'function_call', id: 'fc_sparse', call_id: 'sparse', namespace: 'collaboration-optimize', name: 'spawn_agent', arguments: '', status: 'in_progress',
        },
      });
      yield eventFrame({ type: 'response.function_call_arguments.done', item_id: 'fc_sparse', output_index: 0, arguments: '{}', encrypted_function_args: marker } as OpenAIResponsesStreamEvent);
    })(), testTelemetryModelIdentity));
  if (result.type !== 'events') throw new Error('Expected events');
  await expect(async () => { for await (const frame of result.events) void frame; }).rejects.toThrow('encrypted arguments');
});

test('rejects conflicting identities across call coordinates', async () => {
  const ctx = invocation();
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () =>
    eventResult((async function* () {
      yield eventFrame({
        type: 'response.output_item.added', output_index: 0, item: {
          type: 'function_call', id: 'fc_identity', call_id: 'identity', namespace: 'collaboration-optimize', name: 'spawn_agent', arguments: '', status: 'in_progress',
        },
      });
      yield eventFrame({
        type: 'response.output_item.done', output_index: 0, item: {
          type: 'function_call', call_id: 'identity', namespace: 'foreign', name: 'spawn_agent', arguments: '{}', status: 'completed',
        },
      });
    })(), testTelemetryModelIdentity));
  if (result.type !== 'events') throw new Error('Expected events');
  await expect(async () => { for await (const frame of result.events) void frame; }).rejects.toThrow('Conflicting');
});

test('preserves foreign namespaces and independently declared qualified-looking selectors', async () => {
  const ctx = invocation();
  const foreign = { type: 'function' as const, namespace: 'foreign', name: 'collaboration.spawn_agent' };
  ctx.payload.tools?.push({ type: 'function', name: 'collaboration.spawn_agent' });
  ctx.payload.tool_choice = { type: 'allowed_tools', mode: 'auto', tools: [foreign, { type: 'function', name: 'collaboration.spawn_agent' }] };
  const beforeChoice = ctx.payload.tool_choice;
  await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    expect(ctx.payload.tool_choice).toEqual(beforeChoice);
    return eventResult((async function* () {})(), testTelemetryModelIdentity);
  });
});

test('keeps the namespace across an actual hosted-tool loop and restores only the client stream', async () => {
  const ctx = invocation();
  ctx.payload.tools?.push({ type: 'web_search' });
  ctx.payload.tool_choice = 'auto';
  const gatewayCtx = mockChatGatewayCtx();
  let upstreamCalls = 0;
  const serverShim = withOpenAIResponsesServerToolShim([() => ({
    type: 'active', baseToolName: 'search', hosted: {
      hostedTypes: ['web_search'],
      canonicalize: tool => tool.type === 'web_search' ? tool : undefined,
      buildFunctionTool: (_tool, name) => ({ type: 'function', name, parameters: { type: 'object' } }),
      dispatcher: () => [{
        id: 'msg_search',
        startItem: { type: 'message', id: 'msg_search', role: 'assistant', status: 'in_progress', content: [] },
        startEvents: [],
        async *run() {
          return { item: { type: 'message', id: 'msg_search', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'search result', annotations: [] }] }, endEvents: [] };
        },
      }],
    },
  })]);
  const result = await withOpenAIResponsesCollaborationShim(ctx, gatewayCtx, () => serverShim(ctx, gatewayCtx, async () => {
    upstreamCalls++;
    expect(ctx.payload.tools?.[0]).toMatchObject({ name: 'collaboration-optimize' });
    expect(ctx.payload.input[0]).toMatchObject({ namespace: 'collaboration-optimize' });
    if (upstreamCalls === 2) expect(ctx.payload.input).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'msg_search' })]));
    const call: OpenAIResponsesOutputFunctionCall = {
      type: 'function_call', id: `fc_${upstreamCalls}`, call_id: `call_${upstreamCalls}`, arguments: '{}', status: 'completed',
      ...(upstreamCalls === 1 ? { name: 'search' } : { namespace: 'collaboration-optimize', name: 'spawn_agent' }),
    };
    return eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.created', response: { ...response([], ctx.payload.tools ?? [], 'collaboration-optimize'), status: 'in_progress' } });
      yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: { ...call, status: 'in_progress' } });
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: call });
      yield eventFrame({ type: 'response.completed', response: response([call], ctx.payload.tools ?? [], 'collaboration-optimize') });
    })(), testTelemetryModelIdentity);
  }));
  if (result.type !== 'events') throw new Error('Expected events');
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of result.events) if (frame.type === 'event') events.push(frame.event);
  expect(upstreamCalls).toBe(2);
  expect(events.at(-1)).toMatchObject({
    type: 'response.completed', response: {
      output: expect.arrayContaining([
        expect.objectContaining({ namespace: 'collaboration', name: 'spawn_agent', encrypted_function_args: [] }),
      ]),
    },
  });
  expect(JSON.stringify(events)).not.toContain('collaboration-optimize');
});

test('remembers encrypted evidence arriving before a sparse call identity', async () => {
  const ctx = invocation();
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () =>
    eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.function_call_arguments.delta', item_id: 'fc_late', output_index: 0, delta: '{}', encrypted_function_args: ['message'] } as OpenAIResponsesStreamEvent);
      yield eventFrame({
        type: 'response.output_item.done', output_index: 0, item: {
          type: 'function_call', id: 'fc_late', call_id: 'late', namespace: 'collaboration-optimize', name: 'spawn_agent', arguments: '{}', status: 'completed',
        },
      });
    })(), testTelemetryModelIdentity));
  if (result.type !== 'events') throw new Error('Expected events');
  await expect(async () => { for await (const frame of result.events) void frame; }).rejects.toThrow('encrypted arguments');
});

test.each(['.', '__'])('restores a standalone qualified argument event with %s', async separator => {
  const ctx = invocation();
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () =>
    eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.function_call_arguments.done', item_id: 'fc_direct', output_index: 0, name: `collaboration-optimize${separator}spawn_agent`, arguments: '{}' } as OpenAIResponsesStreamEvent);
    })(), testTelemetryModelIdentity));
  if (result.type !== 'events') throw new Error('Expected events');
  for await (const frame of result.events) {
    expect(frame).toMatchObject({ event: { namespace: 'collaboration', name: 'spawn_agent', encrypted_function_args: [] } });
    expect(JSON.stringify(frame)).not.toContain('collaboration-optimize');
  }
});

test.each([false, undefined])('preserves upstream schema echoes with differing client inventory marker %j', async encrypted => {
  const ctx = invocation();
  const deferred = collaborationTool();
  if (deferred.type !== 'namespace' || deferred.tools[0].type !== 'function') throw new Error('Expected namespace function');
  deferred.tools[0].parameters = { type: 'object', properties: { message: { type: 'string', ...(encrypted === undefined ? {} : { encrypted }) } } };
  ctx.payload.input.push({ type: 'additional_tools', role: 'developer', tools: [deferred] });
  let upstreamTools: OpenAIResponsesTool[] = [];
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () => {
    const input = ctx.payload.input[1];
    if (input.type !== 'additional_tools' || input.tools[0].type !== 'namespace') throw new Error('Expected deferred namespace');
    const child = input.tools[0].tools[0];
    if (child.type !== 'function') throw new Error('Expected function');
    expect((child.parameters?.properties as Record<string, Record<string, unknown>>).message).not.toHaveProperty('encrypted');
    upstreamTools = structuredClone(ctx.payload.tools ?? []);
    const tool = upstreamTools[0];
    if (tool.type !== 'namespace' || tool.tools[0].type !== 'function') throw new Error('Expected namespace function');
    tool.tools[0].parameters = { type: 'object', properties: { message: { type: 'string', encrypted: false, description: 'Upstream schema' } } };
    return eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: { type: 'tool_search_output', id: 'tso_echo', tools: upstreamTools } });
      yield eventFrame({ type: 'response.completed', response: response([], upstreamTools, 'collaboration-optimize') });
    })(), testTelemetryModelIdentity);
  });
  if (result.type !== 'events') throw new Error('Expected events');
  const expected = upstreamTools.map(tool => ({ ...tool, name: 'collaboration' }));
  for await (const frame of result.events) {
    if (frame.type !== 'event') continue;
    if (frame.event.type === 'response.completed') expect(frame.event.response.tools).toEqual(expected);
    if (frame.event.type === 'response.output_item.done') expect(frame.event.item).toMatchObject({ tools: expected });
  }
});

// Upstream may echo the same call with a flat `namespace__name` in an argument
// event's `name` while the preceding `output_item.added` used separated
// `namespace`/`name`. For a foreign-namespace call the flat echo is not
// rewritable, so binding the flat name against the split name would manufacture
// a false conflict and fail the turn. A delta is not an identity carrier at
// all; a `done` flat name normalizes back to the binding's separated identity.
// The namespace here is multi-segment (`mcp__cua_repl`) to pin the rightmost-
// separator split.
test.each(['delta', 'done'] as const)('does not manufacture a conflict from a flat argument %s echo', async argumentEvent => {
  const ctx = invocation();
  const argumentFrame = argumentEvent === 'delta'
    ? { type: 'response.function_call_arguments.delta' as const, delta: '{}' }
    : { type: 'response.function_call_arguments.done' as const, arguments: '{}' };
  const result = await withOpenAIResponsesCollaborationShim(ctx, mockChatGatewayCtx(), async () =>
    eventResult((async function* () {
      yield eventFrame({
        type: 'response.output_item.added', output_index: 0, item: {
          type: 'function_call', id: 'fc_flat', call_id: 'flat',
          namespace: 'mcp__cua_repl', name: 'js', arguments: '', status: 'in_progress',
        },
      });
      yield eventFrame({
        ...argumentFrame, item_id: 'fc_flat', output_index: 0,
        name: 'mcp__cua_repl__js', call_id: 'flat',
      } as unknown as OpenAIResponsesStreamEvent);
      yield eventFrame({
        type: 'response.output_item.done', output_index: 0, item: {
          type: 'function_call', id: 'fc_flat', call_id: 'flat',
          namespace: 'mcp__cua_repl', name: 'js', arguments: '{}', status: 'completed',
        },
      });
    })(), testTelemetryModelIdentity));
  if (result.type !== 'events') throw new Error('Expected events');
  for await (const frame of result.events) {
    if (frame.type === 'event' && frame.event.type === 'response.output_item.done') {
      expect(frame.event.item).toMatchObject({ namespace: 'mcp__cua_repl', name: 'js' });
    }
  }
});

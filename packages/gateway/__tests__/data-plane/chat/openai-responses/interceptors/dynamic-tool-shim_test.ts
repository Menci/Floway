import { expect, test } from 'vitest';

import { withOpenAIResponsesDynamicToolShim } from '../../../../../src/data-plane/chat/openai-responses/interceptors/dynamic-tool-shim.ts';
import { DYNAMIC_TOOL_DISPATCHER, prepareDynamicTools } from '../../../../../src/data-plane/chat/openai-responses/interceptors/dynamic-tools/catalog.ts';
import { projectDynamicToolEvents } from '../../../../../src/data-plane/chat/openai-responses/interceptors/dynamic-tools/projection.ts';
import { dynamicToolSearchServerTool } from '../../../../../src/data-plane/chat/openai-responses/interceptors/dynamic-tools/server-search.ts';
import { withOpenAIResponsesServerToolShim } from '../../../../../src/data-plane/chat/openai-responses/interceptors/server-tool-shim.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputItem, OpenAIResponsesOutputFunctionCall, OpenAIResponsesResult, OpenAIResponsesStreamEvent, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { eventResult } from '@floway-dev/provider';
import { stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import { translateOpenAIResponsesViaAnthropicMessages, translateOpenAIResponsesViaOpenAIChatCompletions } from '@floway-dev/translate';

const customer = {
  type: 'function' as const,
  name: 'get_customer',
  description: 'Look up a customer by ID.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

const payload = (input: CanonicalOpenAIResponsesPayload['input']): CanonicalOpenAIResponsesPayload => ({
  model: 'model',
  input,
  tools: [],
});

test('announces tools at their original history positions without changing the dispatcher schema', () => {
  const first = prepareDynamicTools(payload([
    { type: 'message', role: 'user', content: 'Find a customer.' },
    { type: 'additional_tools', role: 'developer', tools: [customer] },
    {
      type: 'function_call',
      id: 'fc_customer',
      call_id: 'call_customer',
      name: 'get_customer',
      arguments: '{"id":"42"}',
      status: 'completed',
    },
    { type: 'function_call_output', call_id: 'call_customer', output: '{"name":"Ada"}' },
    { type: 'message', role: 'user', content: 'Now audit the order.' },
  ]));
  const second = prepareDynamicTools(payload([
    { type: 'message', role: 'user', content: 'Find a customer.' },
    { type: 'additional_tools', role: 'developer', tools: [{ ...customer, description: 'Updated description.' }] },
  ]));

  expect(first.payload.tools).toEqual(second.payload.tools);
  expect(first.payload.tools?.map(tool => tool.type === 'function' ? tool.name : tool.type)).toEqual([DYNAMIC_TOOL_DISPATCHER]);
  expect(first.payload.input.map(item => item.type)).toEqual([
    'message', 'message', 'function_call', 'function_call_output', 'message',
  ]);
  const announcement = first.payload.input[1];
  expect(announcement.type).toBe('message');
  if (announcement.type !== 'message') throw new Error('Expected announcement');
  expect(announcement.role).toBe('system');
  expect(announcement.content).toContain('get_customer');
  expect(announcement.content).toContain('tool/function//get_customer');
  const customerCall = first.payload.input[2];
  expect(customerCall).toMatchObject({ type: 'function_call', name: DYNAMIC_TOOL_DISPATCHER, call_id: 'call_customer' });
  if (customerCall.type !== 'function_call') throw new Error('Expected rewritten call');
  expect(JSON.parse(customerCall.arguments)).toEqual({ handle: 'tool/function//get_customer', arguments: { id: '42' } });
});

test('replays client tool search and announces its loaded namespace tools after the result', () => {
  const prepared = prepareDynamicTools({
    ...payload([
      { type: 'message', role: 'user', content: 'Audit the order.' },
      { type: 'tool_search_call', id: 'tsc_1', call_id: 'call_search', execution: 'client', arguments: { goal: 'audit order' } },
      { type: 'tool_search_output', id: 'tso_1', call_id: 'call_search', execution: 'client', tools: [{ type: 'namespace', name: 'orders', description: 'Orders', tools: [{ type: 'function', name: 'audit', parameters: { type: 'object' } }] }] },
    ]),
    tools: [{ type: 'tool_search', execution: 'client', description: 'Find order tools.', parameters: { type: 'object', properties: { goal: { type: 'string' } } } }],
  });
  expect(prepared.payload.input.map(item => item.type)).toEqual(['message', 'message', 'function_call', 'function_call_output', 'message']);
  const searchCall = prepared.payload.input[2];
  expect(searchCall).toMatchObject({ type: 'function_call', name: DYNAMIC_TOOL_DISPATCHER, call_id: 'call_search' });
  const searched = prepared.payload.input[4];
  expect(searched.type).toBe('message');
  if (searched.type !== 'message') throw new Error('Expected searched tool announcement');
  expect(searched.content).toContain('tool/function/orders/audit');

  const continuation = prepareDynamicTools(payload([
    { type: 'tool_search_call', id: 'tsc_1', call_id: 'call_search', execution: 'client', arguments: { goal: 'audit order' } },
    { type: 'tool_search_output', id: 'tso_1', call_id: 'call_search', execution: 'client', tools: [{ type: 'function', name: 'audit', parameters: { type: 'object' } }] },
    { type: 'message', role: 'user', content: 'Use the loaded tool.' },
  ]));
  expect(continuation.payload.input.map(item => item.type)).toEqual(['function_call', 'function_call_output', 'message', 'message']);
});

test('preserves namespace and freeform custom call identity through history', () => {
  const prepared = prepareDynamicTools(payload([
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'editor', description: 'Editor tools', tools: [{ type: 'custom', name: 'patch', description: 'Apply a patch.' }] }] },
    { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_patch', namespace: 'editor', name: 'patch', input: '*** Begin Patch', status: 'completed' },
    { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'applied', status: 'completed' },
  ]));
  expect(prepared.payload.input.map(item => item.type)).toEqual(['message', 'function_call', 'function_call_output']);
  const call = prepared.payload.input[1];
  if (call.type !== 'function_call') throw new Error('Expected rewritten call');
  expect(JSON.parse(call.arguments)).toEqual({ handle: 'tool/custom/editor/patch', text: '*** Begin Patch' });
  expect(prepared.payload.input[2]).toMatchObject({ type: 'function_call_output', call_id: 'call_patch', output: 'applied' });
});

test('rejects a dynamic identity that would make static call history ambiguous', () => {
  expect(() => prepareDynamicTools({
    ...payload([{ type: 'additional_tools', role: 'developer', tools: [customer] }]),
    tools: [customer],
  })).toThrow("Dynamic tool 'get_customer' conflicts with a top-level callable tool.");
});

test('rejects ambiguous deferred search paths before sending a model request', () => {
  expect(() => prepareDynamicTools({
    ...payload([{ type: 'message', role: 'user', content: 'Search.' }]),
    tools: [
      { type: 'tool_search' },
      { ...customer, defer_loading: true },
      { type: 'namespace', name: 'get_customer', description: 'Conflicting namespace', tools: [{ type: 'function', name: 'other', defer_loading: true }] },
    ],
  })).toThrow("Deferred tool path 'get_customer' is ambiguous.");
});

test('exposes server-owned dynamic tools that have no execution adapter', () => {
  expect(() => prepareDynamicTools(payload([{
    type: 'additional_tools', role: 'developer',
    tools: [{ type: 'file_search', vector_store_ids: ['store_1'] }],
  }]))).toThrow('needs a native or gateway execution adapter');
  expect(() => prepareDynamicTools({
    ...payload([]),
    tools: [{ type: 'mcp', server_label: 'remote', defer_loading: true }],
  })).toThrow('Deferred MCP servers need a native connector or gateway execution adapter.');
});

test('required tool choice cannot force an empty dispatcher catalogue', () => {
  expect(() => prepareDynamicTools({ ...payload([{ type: 'message', role: 'user', content: 'Hello.' }]), tool_choice: 'required' }))
    .toThrow('tool_choice required has no callable client tool.');
});

test('structured shell and patch tools retain their native client calls and round-trip results', async () => {
  const cases: Array<{
    tool: OpenAIResponsesTool;
    call: OpenAIResponsesInputItem;
    output: OpenAIResponsesInputItem;
    handle: string;
    arguments: Record<string, unknown>;
    expectedType: string;
  }> = [
    {
      tool: { type: 'shell', environment: { type: 'local' } },
      call: { type: 'shell_call', id: 'sh_1', call_id: 'call_shell', action: { commands: ['pwd'] }, environment: { type: 'local' }, status: 'completed' },
      output: { type: 'shell_call_output', call_id: 'call_shell', output: [{ stdout: '/tmp', stderr: '', outcome: { type: 'exit', exit_code: 0 } }], status: 'completed' },
      handle: 'tool/shell//shell',
      arguments: { action: { commands: ['pwd'] }, environment: { type: 'local' } },
      expectedType: 'shell_call',
    },
    {
      tool: { type: 'local_shell' },
      call: { type: 'local_shell_call', id: 'lsh_1', call_id: 'call_local', action: { type: 'exec', command: ['pwd'], env: {} }, status: 'completed' },
      output: { type: 'local_shell_call_output', call_id: 'call_local', output: '/tmp', status: 'completed' },
      handle: 'tool/local_shell//local_shell',
      arguments: { action: { type: 'exec', command: ['pwd'], env: {} } },
      expectedType: 'local_shell_call',
    },
    {
      tool: { type: 'apply_patch' },
      call: { type: 'apply_patch_call', id: 'ap_1', call_id: 'call_patch', operation: { type: 'create_file', path: 'hello.txt', diff: '+hello' }, status: 'completed' },
      output: { type: 'apply_patch_call_output', call_id: 'call_patch', output: 'applied', status: 'completed' },
      handle: 'tool/apply_patch//apply_patch',
      arguments: { operation: { type: 'create_file', path: 'hello.txt', diff: '+hello' } },
      expectedType: 'apply_patch_call',
    },
  ];

  for (const scenario of cases) {
    const prepared = prepareDynamicTools(payload([
      { type: 'additional_tools', role: 'developer', tools: [scenario.tool] },
      scenario.call,
      scenario.output,
    ]));
    const modelCall = prepared.payload.input[1];
    if (modelCall.type !== 'function_call') throw new Error('Expected dispatcher history call');
    expect(JSON.parse(modelCall.arguments)).toEqual({ handle: scenario.handle, arguments: scenario.arguments });
    expect(prepared.payload.input[2]).toMatchObject({ type: 'function_call_output', output: JSON.stringify(scenario.output) });

    const call: OpenAIResponsesOutputFunctionCall = {
      type: 'function_call', id: 'fc_dispatch', call_id: 'call_next', name: DYNAMIC_TOOL_DISPATCHER,
      arguments: JSON.stringify({ handle: scenario.handle, arguments: scenario.arguments }), status: 'completed',
    };
    const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: call });
    })();
    const projected: OpenAIResponsesStreamEvent[] = [];
    for await (const frame of projectDynamicToolEvents(frames, prepared)) if (frame.type === 'event') projected.push(frame.event);
    expect(projected[0]).toMatchObject({ type: 'response.output_item.done', item: { type: scenario.expectedType, call_id: 'call_next' } });
  }
});

test('modern and preview computer calls preserve screenshots through the dispatcher', async () => {
  for (const preview of [false, true]) {
    const tool: OpenAIResponsesTool = preview
      ? { type: 'computer_use_preview', display_height: 800, display_width: 1200, environment: 'browser' }
      : { type: 'computer' };
    const handle = preview ? 'tool/computer_use_preview//computer_use_preview' : 'tool/computer//computer';
    const args = preview
      ? { action: { type: 'screenshot' }, pending_safety_checks: [] }
      : { actions: [{ type: 'screenshot' }] };
    const historyCall: OpenAIResponsesInputItem = preview
      ? { type: 'computer_call', id: 'cu_preview', call_id: 'call_computer', action: { type: 'screenshot' }, pending_safety_checks: [], status: 'completed' }
      : { type: 'computer_call', id: 'cu_modern', call_id: 'call_computer', actions: [{ type: 'screenshot' }], status: 'completed' };
    const prepared = prepareDynamicTools({
      ...payload([
        { type: 'additional_tools', role: 'developer', tools: [tool] },
        historyCall,
        { type: 'computer_call_output', call_id: 'call_computer', output: { type: 'computer_screenshot', image_url: 'data:image/png;base64,AA==' } },
      ]),
      tool_choice: { type: preview ? 'computer_use_preview' : 'computer' },
    });
    expect(prepared.payload.tool_choice).toEqual({ type: 'function', name: DYNAMIC_TOOL_DISPATCHER });
    const modelCall = prepared.payload.input[1];
    if (modelCall.type !== 'function_call') throw new Error('Expected dispatcher history call');
    expect(JSON.parse(modelCall.arguments)).toEqual({ handle, arguments: args });
    expect(prepared.payload.input[2]).toMatchObject({
      type: 'function_call_output', output: [
        { type: 'input_text' },
        { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
      ],
    });

    const call: OpenAIResponsesOutputFunctionCall = {
      type: 'function_call', id: 'fc_computer', call_id: 'call_next', name: DYNAMIC_TOOL_DISPATCHER,
      arguments: JSON.stringify({ handle, arguments: args }), status: 'completed',
    };
    const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: call });
    })();
    const projected: OpenAIResponsesStreamEvent[] = [];
    for await (const frame of projectDynamicToolEvents(frames, prepared)) if (frame.type === 'event') projected.push(frame.event);
    expect(projected[0]).toMatchObject({ type: 'response.output_item.done', item: { type: 'computer_call', call_id: 'call_next', ...args } });
  }
});

test('forces a selected dynamic tool through the dispatcher and rejects other handles', async () => {
  const prepared = prepareDynamicTools({
    ...payload([{ type: 'additional_tools', role: 'developer', tools: [customer, { type: 'function', name: 'other', parameters: { type: 'object' } }] }]),
    tool_choice: { type: 'function', name: 'get_customer' },
  });
  expect(prepared.payload.tool_choice).toEqual({ type: 'function', name: DYNAMIC_TOOL_DISPATCHER });
  expect(prepared.payload.input.at(-1)).toMatchObject({ type: 'message', role: 'system' });
  const wrong: OpenAIResponsesOutputFunctionCall = {
    type: 'function_call', id: 'fc_wrong', call_id: 'call_wrong', name: DYNAMIC_TOOL_DISPATCHER,
    arguments: '{"handle":"tool/function//other","arguments":{}}', status: 'completed',
  };
  const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: wrong });
  })();
  await expect(async () => {
    for await (const frame of projectDynamicToolEvents(frames, prepared)) expect(frame.type).toBe('event');
  }).rejects.toThrow('excluded by tool_choice');
});

test('activates automatically on translation and only by flag for a native Responses target', async () => {
  const makeInvocation = (targetApi: OpenAIResponsesInvocation['targetApi'], enabledFlags: ReadonlySet<'dynamic-tool-shim'>): OpenAIResponsesInvocation => ({
    payload: payload([{ type: 'additional_tools', role: 'developer', tools: [customer] }]),
    candidate: stubModelCandidate({ enabledFlags }),
    targetApi,
    headers: new Headers(),
    action: 'generate',
  });
  const run = async () => eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> { yield { type: 'done' }; })(), testTelemetryModelIdentity);
  const translated = makeInvocation('openaiChatCompletions', new Set());
  await withOpenAIResponsesDynamicToolShim(translated, mockChatGatewayCtx(), run);
  expect(translated.payload.tools?.at(-1)).toMatchObject({ type: 'function', name: DYNAMIC_TOOL_DISPATCHER });
  const native = makeInvocation('openaiResponses', new Set());
  await withOpenAIResponsesDynamicToolShim(native, mockChatGatewayCtx(), run);
  expect(native.payload.input[0].type).toBe('additional_tools');
  const forced = makeInvocation('openaiResponses', new Set(['dynamic-tool-shim']));
  await withOpenAIResponsesDynamicToolShim(forced, mockChatGatewayCtx(), run);
  expect(forced.payload.tools?.at(-1)).toMatchObject({ type: 'function', name: DYNAMIC_TOOL_DISPATCHER });
});

test('both translated targets receive only the stable dispatcher and the positional system announcement', async () => {
  const prepared = prepareDynamicTools(payload([
    { type: 'message', role: 'user', content: 'Before the tool exists.' },
    { type: 'additional_tools', role: 'developer', tools: [customer] },
    { type: 'message', role: 'user', content: 'Look up customer 42.' },
  ]));
  const chat = await translateOpenAIResponsesViaOpenAIChatCompletions(prepared.payload, { model: 'model' });
  const anthropic = await translateOpenAIResponsesViaAnthropicMessages(prepared.payload, { model: 'model', fallbackMaxOutputTokens: 1024, loadRemoteImage: async () => null });
  expect(chat.target.tools?.map(tool => tool.function.name)).toEqual([DYNAMIC_TOOL_DISPATCHER]);
  expect(chat.target.messages.map(message => message.role)).toEqual(['user', 'system', 'user']);
  expect(anthropic.target.tools?.map(tool => tool.name)).toEqual([DYNAMIC_TOOL_DISPATCHER]);
  expect(anthropic.target.messages.map(message => message.role)).toEqual(['user', 'system', 'user']);
});

test('buffers a dispatcher call until its real client-visible tool and arguments are known', async () => {
  const prepared = prepareDynamicTools(payload([{ type: 'additional_tools', role: 'developer', tools: [customer] }]));
  const rawArgs = '{"handle":"tool/function//get_customer","arguments":{"id":"42"}}';
  const call: OpenAIResponsesOutputFunctionCall = {
    type: 'function_call', id: 'fc_1', call_id: 'call_1', name: DYNAMIC_TOOL_DISPATCHER,
    arguments: rawArgs, status: 'completed',
  };
  const response = (output: OpenAIResponsesResult['output']): OpenAIResponsesResult => ({
    id: 'resp_1', object: 'response', model: 'model', status: 'completed', output,
    tools: prepared.payload.tools ?? undefined, tool_choice: 'auto', error: null, incomplete_details: null,
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.created', response: response([]) });
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } });
    yield eventFrame({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: rawArgs });
    await gate;
    yield eventFrame({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: rawArgs });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: call });
    yield eventFrame({ type: 'response.completed', response: response([call]) });
    yield { type: 'done' };
  })();
  const output = projectDynamicToolEvents(frames, prepared);
  const created = await output.next();
  expect(created.value?.type).toBe('event');
  let settled = false;
  const waiting = output.next().then(value => { settled = true; return value; });
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  const added = await waiting;
  expect(added.value).toMatchObject({ type: 'event', event: { type: 'response.output_item.added', item: { type: 'function_call', name: 'get_customer', call_id: 'call_1' } } });
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of output) if (frame.type === 'event') events.push(frame.event);
  expect(events.find(event => event.type === 'response.function_call_arguments.done')).toMatchObject({ arguments: '{"id":"42"}' });
  const completed = events.find(event => event.type === 'response.completed');
  if (completed?.type !== 'response.completed') throw new Error('Expected completed response');
  expect(completed.response.output[0]).toMatchObject({ type: 'function_call', name: 'get_customer', call_id: 'call_1' });
  expect(completed.response.tools).toEqual([]);
  expect(JSON.stringify(events)).not.toContain(DYNAMIC_TOOL_DISPATCHER);
});

test('server tool search loads a deferred namespace without adding its functions to upstream tools', async () => {
  const ctx: OpenAIResponsesInvocation = {
    payload: {
      ...payload([{ type: 'message', role: 'user', content: 'Find the customer tool, then use it.' }]),
      tools: [
        { type: 'tool_search' },
        { type: 'namespace', name: 'customers', description: 'Customer records', tools: [{ ...customer, defer_loading: true }] },
      ],
    },
    candidate: stubModelCandidate(),
    targetApi: 'openaiChatCompletions',
    headers: new Headers(),
    action: 'generate',
  };
  const upstream: CanonicalOpenAIResponsesPayload[] = [];
  const searchArgs = '{"paths":["customers"]}';
  const invokeArgs = '{"handle":"tool/function/customers/get_customer","arguments":{"id":"42"}}';
  const run = async () => {
    upstream.push(structuredClone(ctx.payload));
    const name = upstream.length === 1 ? 'search_additional_tools' : DYNAMIC_TOOL_DISPATCHER;
    const args = upstream.length === 1 ? searchArgs : invokeArgs;
    const call: OpenAIResponsesOutputFunctionCall = {
      type: 'function_call', id: `fc_${upstream.length}`, call_id: `call_${upstream.length}`,
      name, arguments: args, status: 'completed',
    };
    const response: OpenAIResponsesResult = {
      id: `resp_${upstream.length}`, object: 'response', model: 'model', status: 'completed',
      output: [call], tools: ctx.payload.tools ?? undefined, tool_choice: 'auto', error: null, incomplete_details: null,
    };
    return eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
      yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } });
      yield eventFrame({ type: 'response.function_call_arguments.done', output_index: 0, item_id: call.id!, arguments: args });
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: call });
      yield eventFrame({ type: 'response.completed', response });
      yield { type: 'done' };
    })(), testTelemetryModelIdentity);
  };
  const result = await runInterceptors(ctx, mockChatGatewayCtx(), [
    withOpenAIResponsesDynamicToolShim,
    withOpenAIResponsesServerToolShim([dynamicToolSearchServerTool]),
  ], run);
  if (result.type !== 'events') throw new Error('Expected events');
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of result.events) if (frame.type === 'event') events.push(frame.event);
  expect(upstream).toHaveLength(2);
  expect(upstream[0].tools?.map(tool => tool.type === 'function' ? tool.name : tool.type)).toEqual(['search_additional_tools', DYNAMIC_TOOL_DISPATCHER]);
  expect(upstream[1].tools).toEqual(upstream[0].tools);
  expect(JSON.stringify(upstream[1].input)).toContain('tool/function/customers/get_customer');
  expect(events.filter(event => event.type === 'response.output_item.done').map(event => event.item.type)).toEqual([
    'tool_search_call', 'tool_search_output', 'function_call',
  ]);
  const completed = events.find(event => event.type === 'response.completed');
  if (completed?.type !== 'response.completed') throw new Error('Expected completed response');
  expect(completed.response.output.at(-1)).toMatchObject({ type: 'function_call', namespace: 'customers', name: 'get_customer' });
});

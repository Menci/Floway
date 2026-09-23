import { expect, test } from 'vitest';

import { withOpenAIResponsesDynamicToolShim } from '../../../../../src/data-plane/chat/openai-responses/interceptors/dynamic-tool-shim.ts';
import { DYNAMIC_TOOL_DISPATCHER, prepareDynamicTools } from '../../../../../src/data-plane/chat/openai-responses/interceptors/dynamic-tools/catalog.ts';
import { projectDynamicToolEvents } from '../../../../../src/data-plane/chat/openai-responses/interceptors/dynamic-tools/projection.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesOutputFunctionCall, OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
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

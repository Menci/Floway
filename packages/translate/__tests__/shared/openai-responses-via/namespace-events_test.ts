import { expect, test, vi } from 'vitest';

import { flattenNamespaceTools, restoreNamespaceEvents } from '../../../src/shared/openai-responses-via/namespace-tools.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResult, OpenAIResponsesStreamEvent, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

const functionTool = (name: string): Extract<OpenAIResponsesTool, { type: 'function' }> => ({ type: 'function', name, parameters: { type: 'object' } });
const emptyResult = (): OpenAIResponsesResult => ({ id: 'resp', object: 'response', model: 'model', status: 'completed', output: [], output_text: '', error: null, incomplete_details: null });
const framesOf = async function* (events: OpenAIResponsesStreamEvent[]): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

test('callable projection restores item lifecycle, function/custom types, and resource echoes before outer readers', async () => {
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type: 'custom', name: 'edit' }, functionTool('read')] }], tool_choice: { type: 'custom', name: 'edit', namespace: 'files' } as CanonicalOpenAIResponsesPayload['tool_choice'] };
  const call = flattenNamespaceTools(request);
  const output = [
    { type: 'function_call' as const, name: 'files_edit', id: 'fc1', call_id: 'a', arguments: 'patch', status: 'completed' as const },
    { type: 'custom_tool_call' as const, name: 'files_read', id: 'fc2', call_id: 'b', input: '{}' },
  ];
  const upstream = { ...emptyResult(), output, tools: [functionTool('files_edit')], tool_choice: { type: 'function' as const, name: 'files_edit' }, extension: 'kept' };
  const response = restoreNamespaceEvents(framesOf([
    { type: 'response.output_item.added', output_index: 0, item: output[0]! },
    { type: 'response.output_item.done', output_index: 0, item: output[0]! },
    { type: 'response.completed', response: upstream },
  ]), call.names);
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of response) frames.push(frame);
  const expected = [
    { type: 'custom_tool_call', name: 'edit', namespace: 'files', id: 'fc1', call_id: 'a', input: 'patch', status: 'completed' },
    { type: 'function_call', name: 'read', namespace: 'files', id: 'fc2', call_id: 'b', arguments: '{}', status: 'completed' },
  ];
  assertEquals(frames[0], eventFrame({ type: 'response.output_item.added', output_index: 0, item: expected[0] } as OpenAIResponsesStreamEvent));
  assertEquals(frames[1], eventFrame({ type: 'response.output_item.done', output_index: 0, item: expected[0] } as OpenAIResponsesStreamEvent));
  assertEquals(frames[2], eventFrame({ type: 'response.completed', response: { ...upstream, output: expected, tools: request.tools, tool_choice: request.tool_choice } } as OpenAIResponsesStreamEvent));
  assertEquals(frames[3], doneFrame());
  assertEquals(upstream.output, output);
});

for (const type of ['function', 'custom'] as const) {
  test(`callable projection restores ${type} argument event types along with callable items`, async () => {
    const call = flattenNamespaceTools({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type, name: 'read' }] }] });
    const sourceIsFunction = type === 'function';
    const item = sourceIsFunction
      ? { type: 'custom_tool_call' as const, id: 'item', name: 'files_read', call_id: 'call', input: '{}' }
      : { type: 'function_call' as const, id: 'item', name: 'files_read', call_id: 'call', arguments: '{}', status: 'completed' as const };
    const unknown = { type: 'future.event', opaque: { retained: true } } as unknown as OpenAIResponsesStreamEvent;
    const response = restoreNamespaceEvents(framesOf([
      { type: 'response.output_item.added', output_index: 0, item },
      { type: sourceIsFunction ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', item_id: 'item', output_index: 0, delta: '{}' },
      sourceIsFunction
        ? { type: 'response.custom_tool_call_input.done', item_id: 'item', output_index: 0, input: '{}' }
        : { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, arguments: '{}', name: 'files_read' } as OpenAIResponsesStreamEvent,
      unknown,
    ]), call.names);
    const events: OpenAIResponsesStreamEvent[] = [];
    for await (const frame of response) if (frame.type === 'event') events.push(frame.event);
    assertEquals(events[1], { type: sourceIsFunction ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta', item_id: 'item', output_index: 0, delta: '{}' });
    assertEquals(events[2], { type: sourceIsFunction ? 'response.function_call_arguments.done' : 'response.custom_tool_call_input.done', item_id: 'item', output_index: 0, [sourceIsFunction ? 'arguments' : 'input']: '{}', ...(sourceIsFunction ? { name: 'read' } : {}) });
    assert(events[3] === unknown);
  });
}

test('callable projection restores function arguments.done names without adding a namespace field', async () => {
  const call = flattenNamespaceTools({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] });
  const response = restoreNamespaceEvents(framesOf([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'call', name: 'files_read', arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, name: 'files_read', arguments: '{}' } as OpenAIResponsesStreamEvent,
  ]), call.names);
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of response) if (frame.type === 'event') events.push(frame.event);
  assertEquals(events[1], { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, name: 'read', arguments: '{}' });
});

test('callable projection restores lifecycle-appropriate function status from custom items', async () => {
  const call = flattenNamespaceTools({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] });
  const item = { type: 'custom_tool_call' as const, id: 'item', call_id: 'call', name: 'files_read', input: '{}' };
  const response = restoreNamespaceEvents(framesOf([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.created', response: { ...emptyResult(), status: 'in_progress', output: [item] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...emptyResult(), output: [item] } },
  ]), call.names);
  const statuses: unknown[] = [];
  for await (const frame of response) {
    if (frame.type !== 'event') continue;
    if ('item' in frame.event) statuses.push((frame.event.item as { status?: string }).status);
    else if ('response' in frame.event) statuses.push((frame.event.response.output[0] as { status?: string }).status);
  }
  assertEquals(statuses, ['in_progress', 'in_progress', 'completed', 'completed']);
});

test('callable projection projects Standard carriers before namespace allocation without mutating history', async () => {
  const developer = { type: 'message' as const, role: 'developer' as const, content: 'Keep this ordinary developer instruction.' };
  const delayed = { type: 'tool_search_output' as const, tools: [functionTool('delayed')] };
  const request: CanonicalOpenAIResponsesPayload = {
    model: 'm', tools: [functionTool('files_edit')],
    input: [
      developer,
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type: 'custom', name: 'edit', description: 'Edit a file.' }] }] },
      { type: 'additional_tools', role: 'developer', tools: [functionTool('read')] },
      { type: 'custom_tool_call', namespace: 'files', name: 'edit', call_id: 'past', input: 'patch' },
      delayed,
    ],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', namespace: 'files', name: 'edit' }] },
  };
  const original = structuredClone(request);
  const call = flattenNamespaceTools(request);
  const response = restoreNamespaceEvents(framesOf([
    { type: 'response.completed', response: { ...emptyResult(), tools: call.payload.tools ?? undefined, tool_choice: call.payload.tool_choice, output: [{ type: 'function_call', name: 'files_edit_2', call_id: 'current', arguments: 'new patch', status: 'completed' }] } },
  ]), call.names);
  assertEquals(call.payload.tools?.map(tool => 'name' in tool ? tool.name : undefined), ['files_edit', 'files_edit_2', 'read', 'delayed']);
  assertEquals(call.payload.tools?.[1], { type: 'custom', name: 'files_edit_2', description: 'Edit a file.' });
  assertEquals(call.payload.input, [developer, { type: 'custom_tool_call', name: 'files_edit_2', call_id: 'past', input: 'patch' }]);
  assert(call.payload.input[0] === developer);
  assertEquals(call.payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', name: 'files_edit_2' }] });
  assertEquals(request, original);
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of response) frames.push(frame);
  const frame = frames[0];
  assert(frame.type === 'event' && frame.event.type === 'response.completed');
  assertEquals(frame.event.response.tools, request.tools);
  assertEquals(frame.event.response.tool_choice, request.tool_choice);
  assertEquals(frame.event.response.output, [{ type: 'custom_tool_call', name: 'edit', namespace: 'files', call_id: 'current', input: 'new patch', status: 'completed' }]);
});

for (const tools of [undefined, [], [functionTool('existing')]]) {
  for (const echo of [false, true]) {
    test(`carrier projection restores original tool echoes (${tools === undefined ? 'omitted' : tools.length} declarations, upstream echo ${echo})`, async () => {
      const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [{ type: 'additional_tools', role: 'developer', tools: [functionTool('read')] }], ...(tools === undefined ? {} : { tools }) };
      const call = flattenNamespaceTools(request);
      const response = restoreNamespaceEvents(framesOf([
        { type: 'response.completed', response: { ...emptyResult(), ...(echo ? { tools: call.payload.tools ?? undefined } : {}) } },
      ]), call.names);
      assertEquals(call.payload.input, []);
      assertEquals(call.payload.tools, [...(tools ?? []), functionTool('read')]);
      let completed = 0;
      for await (const frame of response) {
        if (frame.type !== 'event' || frame.event.type !== 'response.completed') continue;
        completed++;
        assertEquals(frame.event.response.tools, echo ? tools : undefined);
        assertEquals(Object.hasOwn(frame.event.response, 'tools'), echo && tools !== undefined);
      }
      assertEquals(completed, 1);
    });
  }
}

test('callable restoration retains only echo fields, not the source request or input', () => {
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [{ type: 'message', role: 'user', content: 'Long conversation' }], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] };
  const { names } = flattenNamespaceTools(request);
  const reachable = new Set<unknown>();
  const visit = (value: unknown) => {
    if (typeof value !== 'object' || value === null || reachable.has(value)) return;
    reachable.add(value);
    for (const child of value instanceof Map ? value.values() : Object.values(value)) visit(child);
  };
  visit(names);
  expect(reachable.has(request.tools)).toBe(true);
  expect(reachable.has(request)).toBe(false);
  expect(reachable.has(request.input)).toBe(false);
});

test.each(['forced', 'allowed_tools'] as const)('unchanged flat %s choices retain no echo sources and preserve response frames', async mode => {
  const selector = { type: 'function' as const, name: 'read' };
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [functionTool('read'), functionTool('write')], tool_choice: mode === 'forced' ? selector : { type: 'allowed_tools', mode: 'auto', tools: [selector] } };
  const { payload, names } = flattenNamespaceTools(request);
  expect(payload.tool_choice).toBe(request.tool_choice);
  expect(names.toolsChanged).toBe(false);
  expect(names.toolChoiceChanged).toBe(false);
  expect(names.sourceTools).toBeUndefined();
  expect(names.sourceToolChoice).toBeUndefined();
  const item = { type: 'function_call' as const, id: 'item', call_id: 'call', name: 'read', arguments: '{}', status: 'completed' as const };
  const source: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [
    eventFrame({ type: 'response.output_item.added', output_index: 0, item }),
    eventFrame({ type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, name: 'read', arguments: '{}' } as OpenAIResponsesStreamEvent),
    eventFrame({ type: 'response.output_item.done', output_index: 0, item }),
    eventFrame({ type: 'response.completed', response: { ...emptyResult(), output: [item], tools: request.tools ?? undefined, tool_choice: request.tool_choice } }),
    doneFrame(),
  ];
  const restored = [];
  for await (const frame of restoreNamespaceEvents((async function* () { yield* source; })(), names)) restored.push(frame);
  expect(restored).toHaveLength(source.length);
  restored.forEach((frame, index) => expect(frame).toBe(source[index]));
});

test('callable projection does not rescan unchanged flattened tool references', () => {
  const tools = Array.from({ length: 2000 }, (_, index) => functionTool(`tool_${index}`));
  const scans: Array<{ array: unknown[]; visits: number }> = [];
  const originalSome = Array.prototype.some;
  const spy = vi.spyOn(Array.prototype, 'some').mockImplementation(function (this: unknown[], predicate, thisArg) {
    const scan = { array: this, visits: 0 };
    scans.push(scan);
    return originalSome.call(this, (value, index, array) => {
      scan.visits++;
      return predicate.call(thisArg, value, index, array);
    });
  });
  const prepared = (() => {
    try {
      return flattenNamespaceTools({ model: 'm', input: [], tools });
    } finally {
      spy.mockRestore();
    }
  })();
  expect(prepared.payload.tools).toEqual(tools);
  expect(prepared.payload.tools?.every((tool, index) => tool === tools[index])).toBe(true);
  expect(scans.some(scan => scan.array === tools && scan.visits === tools.length)).toBe(true);
  expect(scans.filter(scan => scan.array === prepared.payload.tools).reduce((total, scan) => total + scan.visits, 0)).toBe(0);
});

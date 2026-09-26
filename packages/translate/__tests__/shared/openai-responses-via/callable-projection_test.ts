import { expect, test, vi } from 'vitest';

import { flattenNamespaceTools, restoreNamespaceEvents } from '../../../src/shared/openai-responses-via/namespace-tools.ts';
import { TranslatorInputError } from '../../../src/translator-input-error.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResult, OpenAIResponsesStreamEvent, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const invocation = (payload: CanonicalOpenAIResponsesPayload) => ({ payload });
const functionTool = (name: string): Extract<OpenAIResponsesTool, { type: 'function' }> => ({ type: 'function', name, parameters: { type: 'object' } });
const emptyResult = (): OpenAIResponsesResult => ({ id: 'resp', object: 'response', model: 'model', status: 'completed', output: [], output_text: '', error: null, incomplete_details: null });
const result = (events: OpenAIResponsesStreamEvent[] = []) => ({
  type: 'events' as const, events: (async function* () {
    for (const event of events) yield eventFrame(event);
    yield doneFrame();
  })(),
});
const project = async (call: { payload: CanonicalOpenAIResponsesPayload }, dispatch: () => Promise<ReturnType<typeof result>>) => {
  const projected = flattenNamespaceTools(call.payload);
  call.payload = projected.payload;
  const response = await dispatch();
  return { ...response, events: restoreNamespaceEvents(response.events, projected.names) };
};
const run = async (call: { payload: CanonicalOpenAIResponsesPayload }) => await project(call, async () => result());

test('callable projection maps declarations, custom history, choices and duplicate declarations without mutation', async () => {
  const custom = { type: 'custom' as const, name: 'edit', format: { type: 'text' as const }, description: 'custom tool' };
  const request: CanonicalOpenAIResponsesPayload = {
    model: 'm', tools: [functionTool('files_read'), { type: 'namespace', name: 'files', description: '', tools: [functionTool('read'), custom, functionTool('read')] }],
    input: [
      { type: 'function_call', name: 'read', namespace: 'files', call_id: 'a', arguments: '{}', status: 'completed' },
      { type: 'custom_tool_call', name: 'edit', namespace: 'files', call_id: 'b', input: 'patch' },
      { type: 'function_call_output', call_id: 'a', output: 'result' },
      { type: 'custom_tool_call_output', call_id: 'b', output: 'done' },
    ],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read', namespace: 'files' }, { type: 'custom', name: 'edit', namespace: 'files' }, { type: 'future', extra: true }] },
  };
  const original = structuredClone(request);
  const call = invocation(request);
  await run(call);
  assertEquals(call.payload.tools?.map(tool => 'name' in tool ? tool.name : null), ['files_read', 'files_read_2', 'files_edit', 'files_read_2']);
  assertEquals(call.payload.input.slice(0, 2).map(item => item.type === 'function_call' || item.type === 'custom_tool_call' ? [item.name, item.namespace] : null), [['files_read_2', undefined], ['files_edit', undefined]]);
  assertEquals(call.payload.input.slice(2), request.input.slice(2));
  assertEquals(call.payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'files_read_2' }, { type: 'custom', name: 'files_edit' }, { type: 'future', extra: true }] });
  assertEquals(request, original);
  const forced = invocation({ ...request, tool_choice: { type: 'custom', name: 'edit', namespace: 'files' } } as CanonicalOpenAIResponsesPayload);
  await run(forced);
  assertEquals(forced.payload.tool_choice, { type: 'custom', name: 'files_edit' });
});

test('callable projection allocates replay-only identities against the current flat collision set', async () => {
  const call = invocation({
    model: 'm', tools: [functionTool('files_read'), functionTool('files_read_2')],
    input: [{ type: 'function_call', name: 'read', namespace: 'files', call_id: 'past', arguments: '{}', status: 'completed' }],
  });
  await run(call);
  assertEquals(call.payload.input, [{ type: 'function_call', name: 'files_read_3', call_id: 'past', arguments: '{}', status: 'completed' }]);
  assertEquals(call.payload.tools, [functionTool('files_read'), functionTool('files_read_2')]);
});

for (const kind of ['function', 'custom'] as const) {
  test.each(['.', '__'])(`callable projection preserves literal ${kind} history and selectors containing %s`, async separator => {
    const name = `files${separator}read`;
    const item = kind === 'function'
      ? { type: 'function_call' as const, name, call_id: 'past', arguments: '{}', status: 'completed' as const }
      : { type: 'custom_tool_call' as const, name, call_id: 'past', input: 'patch' };
    const namespace: OpenAIResponsesTool = { type: 'namespace', name: 'files', description: '', tools: [{ type: kind, name: 'read' }] };
    const selector = { type: kind, name };
    for (const declared of [false, true]) {
      const tools: OpenAIResponsesTool[] = declared ? [namespace, { type: kind, name }] : [namespace];
      for (const tool_choice of [selector, { type: 'allowed_tools' as const, mode: 'auto' as const, tools: [selector] }]) {
        const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [item], tools, tool_choice };
        const { payload, names } = flattenNamespaceTools(request);
        assertEquals(payload.input, [item]);
        assertEquals(payload.tool_choice, tool_choice);
        expect(names.targetToSource.has(name)).toBe(false);
        assertEquals(payload.tools?.map(tool => 'name' in tool ? tool.name : null), declared ? ['files_read', name] : ['files_read']);
        const frame = eventFrame<OpenAIResponsesStreamEvent>({ type: 'response.output_item.done', output_index: 0, item });
        const restored = [];
        for await (const event of restoreNamespaceEvents((async function* () { yield frame; })(), names)) restored.push(event);
        expect(restored).toHaveLength(1);
        expect(restored[0]).toBe(frame);
      }
    }
  });
}

test('callable projection never applies a vendor default namespace to Standard history or tool choice', async () => {
  const call = invocation({
    model: 'm', tools: [{ type: 'namespace', name: 'functions', description: '', tools: [functionTool('read')] }],
    input: [{ type: 'function_call', name: 'read', call_id: 'flat', arguments: '{}', status: 'completed' }],
    tool_choice: { type: 'function', name: 'read' },
  });
  await run(call);
  assertEquals(call.payload.input[0], { type: 'function_call', name: 'read', call_id: 'flat', arguments: '{}', status: 'completed' });
  assertEquals(call.payload.tool_choice, { type: 'function', name: 'read' });
});

for (const [namespace, reservePreferred] of [['n'.repeat(64), false], ['n'.repeat(59), true]] as const) {
  test(`callable projection bounds collision lookups for ${namespace.length}-character namespaces`, async () => {
    const count = 1000;
    const children = Array.from({ length: count }, (_, index) => functionTool(String(index).padStart(4, '0')));
    const reserved = reservePreferred ? children.map(child => functionTool(`${namespace}_${'name' in child ? child.name : ''}`)) : [];
    const call = invocation({ model: 'm', input: [], tools: [...reserved, { type: 'namespace', name: namespace, description: '', tools: children }] });
    const has = vi.spyOn(Set.prototype, 'has');
    let checks = 0;
    try {
      await project(call, async () => {
        checks = has.mock.calls.length;
        has.mockRestore();
        return result();
      });
    } finally { has.mockRestore(); }
    const names = call.payload.tools!.slice(reserved.length).map(tool => 'name' in tool ? tool.name : '');
    assertEquals(names.length, count);
    assertEquals(new Set(names).size, count);
    assert(names.every(name => typeof name === 'string' && name.length <= 64));
    assert(checks >= count, 'instrument must observe collision membership checks');
    assert(checks <= 2 * count + reserved.length, `expected bounded lookup count, observed ${checks}`);
  });
}

test('callable projection preserves suffix ordering across digit widths, invalid characters and duplicates', async () => {
  const namespace = 'n'.repeat(59);
  const prefix = `${namespace}_`;
  const children = ['aaaa', 'aaab', 'aaac', 'a', 'aa', 'aaaa'];
  const reserved = [...children.slice(0, -1).map(name => `${prefix}${name}`), ...Array.from({ length: 8 }, (_, i) => `${prefix}aa_${i + 2}`), `${prefix}a_10`, `${prefix}a_12`];
  const call = invocation({ model: 'm', input: [], tools: [...reserved.map(functionTool), { type: 'namespace', name: namespace, description: '', tools: children.map(functionTool) }, { type: 'namespace', name: 'bad.ns', description: '', tools: [functionTool('bad/name')] }] });
  await run(call);
  assertEquals(call.payload.tools?.slice(reserved.length).map(tool => 'name' in tool ? tool.name : null), [`${prefix}a_11`, `${prefix}a_13`, `${prefix}a_14`, `${prefix}a_2`, `${prefix}a_15`, `${prefix}a_11`, 'bad_ns_bad_name']);
});

test('callable projection restores item lifecycle, function/custom types, and resource echoes before outer readers', async () => {
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type: 'custom', name: 'edit' }, functionTool('read')] }], tool_choice: { type: 'custom', name: 'edit', namespace: 'files' } as CanonicalOpenAIResponsesPayload['tool_choice'] };
  const call = invocation(request);
  const output = [
    { type: 'function_call' as const, name: 'files_edit', id: 'fc1', call_id: 'a', arguments: 'patch', status: 'completed' as const },
    { type: 'custom_tool_call' as const, name: 'files_read', id: 'fc2', call_id: 'b', input: '{}' },
  ];
  const upstream = { ...emptyResult(), output, tools: [functionTool('files_edit')], tool_choice: { type: 'function' as const, name: 'files_edit' }, extension: 'kept' };
  const response = await project(call, async () => result([
    { type: 'response.output_item.added', output_index: 0, item: output[0]! },
    { type: 'response.output_item.done', output_index: 0, item: output[0]! },
    { type: 'response.completed', response: upstream },
  ]));
  assert(response.type === 'events');
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of response.events) frames.push(frame);
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
    const call = invocation({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type, name: 'read' }] }] });
    const sourceIsFunction = type === 'function';
    const item = sourceIsFunction
      ? { type: 'custom_tool_call' as const, id: 'item', name: 'files_read', call_id: 'call', input: '{}' }
      : { type: 'function_call' as const, id: 'item', name: 'files_read', call_id: 'call', arguments: '{}', status: 'completed' as const };
    const unknown = { type: 'future.event', opaque: { retained: true } } as unknown as OpenAIResponsesStreamEvent;
    const response = await project(call, async () => result([
      { type: 'response.output_item.added', output_index: 0, item },
      { type: sourceIsFunction ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', item_id: 'item', output_index: 0, delta: '{}' },
      sourceIsFunction
        ? { type: 'response.custom_tool_call_input.done', item_id: 'item', output_index: 0, input: '{}' }
        : { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, arguments: '{}', name: 'files_read' } as OpenAIResponsesStreamEvent,
      unknown,
    ]));
    assert(response.type === 'events');
    const events: OpenAIResponsesStreamEvent[] = [];
    for await (const frame of response.events) if (frame.type === 'event') events.push(frame.event);
    assertEquals(events[1], { type: sourceIsFunction ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta', item_id: 'item', output_index: 0, delta: '{}' });
    assertEquals(events[2], { type: sourceIsFunction ? 'response.function_call_arguments.done' : 'response.custom_tool_call_input.done', item_id: 'item', output_index: 0, [sourceIsFunction ? 'arguments' : 'input']: '{}', ...(sourceIsFunction ? { name: 'read' } : {}) });
    assert(events[3] === unknown);
  });
}

test('callable projection restores function arguments.done names without adding a namespace field', async () => {
  const call = invocation({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] });
  const response = await project(call, async () => result([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'call', name: 'files_read', arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, name: 'files_read', arguments: '{}' } as OpenAIResponsesStreamEvent,
  ]));
  assert(response.type === 'events');
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of response.events) if (frame.type === 'event') events.push(frame.event);
  assertEquals(events[1], { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, name: 'read', arguments: '{}' });
});

test('callable projection preserves named MCP and future selectors', async () => {
  const selectors = [{ type: 'mcp', server_label: 'remote', name: 'functions.search' }, { type: 'future', name: 'functions.search' }];
  const call = invocation({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'functions', description: '', tools: [functionTool('search')] }], tool_choice: { type: 'allowed_tools', mode: 'required', tools: [...selectors, { type: 'function', name: 'search', namespace: 'functions' }] } });
  await run(call);
  assertEquals(call.payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [...selectors, { type: 'function', name: 'functions_search' }] });
});

test('callable projection bounds scanned prefixes and identity-key storage for a shared long namespace', async () => {
  const namespace = 'n'.repeat(4096);
  const count = 32;
  const call = invocation({ model: 'm', input: [], tools: [{ type: 'namespace', name: namespace, description: '', tools: Array.from({ length: count }, (_, index) => functionTool(`tool${index}`)) }] });
  const replacements = vi.spyOn(String.prototype, 'replaceAll');
  const keys = vi.spyOn(Map.prototype, 'set');
  let lengths: number[] = [];
  let keyBytes = 0;
  try {
    await project(call, async () => {
      lengths = replacements.mock.contexts.map(context => String(context).length);
      keyBytes = keys.mock.calls.reduce((total, [key]) => total + (typeof key === 'string' ? key.length : 0), 0);
      replacements.mockRestore();
      keys.mockRestore();
      return result();
    });
  } finally {
    replacements.mockRestore();
    keys.mockRestore();
  }
  assert(lengths.length > 0, 'instrument must observe the allocator sanitizing names');
  assert(Math.max(...lengths) <= 64, `allocator scanned an unbounded prefix: ${Math.max(...lengths)}`);
  assert(keyBytes > namespace.length, 'instrument must observe the actual identity registry');
  assert(keyBytes <= namespace.length + count * 300, `identity map repeated the full namespace: ${keyBytes} key bytes`);
  assertEquals(new Set(call.payload.tools!.map(tool => 'name' in tool ? tool.name : null)).size, count);
});

test('callable projection restores lifecycle-appropriate function status from custom items', async () => {
  const call = invocation({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] });
  const item = { type: 'custom_tool_call' as const, id: 'item', call_id: 'call', name: 'files_read', input: '{}' };
  const response = await project(call, async () => result([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.created', response: { ...emptyResult(), status: 'in_progress', output: [item] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...emptyResult(), output: [item] } },
  ]));
  assert(response.type === 'events');
  const statuses: unknown[] = [];
  for await (const frame of response.events) {
    if (frame.type !== 'event') continue;
    if ('item' in frame.event) statuses.push((frame.event.item as { status?: string }).status);
    else if ('response' in frame.event) statuses.push((frame.event.response.output[0] as { status?: string }).status);
  }
  assertEquals(statuses, ['in_progress', 'in_progress', 'completed', 'completed']);
});

test('callable projection rejects mixed kinds in one namespace and preserves dotted flat selectors', async () => {
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] };
  const distinct = invocation({ ...request, tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read'), { type: 'custom', name: 'read' }] }] });
  await assertRejects(() => run(distinct), TranslatorInputError, "ambiguous namespace tool 'files.read'");
  const replay = invocation({ ...request, input: [{ type: 'custom_tool_call', namespace: 'files', name: 'read', call_id: 'past', input: 'patch' }] });
  await assertRejects(() => run(replay), TranslatorInputError, "ambiguous namespace tool 'files.read'");
  const flat = invocation({ ...request, tools: [{ type: 'namespace', name: 'a.b', description: '', tools: [functionTool('c')] }, { type: 'namespace', name: 'a', description: '', tools: [functionTool('b.c')] }], tool_choice: { type: 'function', name: 'a.b.c' } });
  await run(flat);
  assertEquals(flat.payload.tool_choice, { type: 'function', name: 'a.b.c' });
  assertEquals(flat.payload.tools?.map(tool => 'name' in tool ? tool.name : null), ['a_b_c', 'a_b_c_2']);
});

test('callable projection retains parent and child descriptions for translated targets', async () => {
  const request: CanonicalOpenAIResponsesPayload = {
    model: 'm', input: [], tools: [
      { type: 'namespace', name: 'files', description: 'Read-only access. Never modify files.', tools: [{ ...functionTool('read'), description: 'Read a file.' }, { type: 'custom', name: 'inspect' }] },
      { type: 'namespace', name: 'empty', description: '', tools: [{ ...functionTool('read'), description: 'Child-only description.' }] },
    ],
  };
  const original = structuredClone(request);
  const call = invocation(request);
  await run(call);
  assertEquals(call.payload.tools?.map(tool => 'description' in tool ? tool.description : undefined), ['Read-only access. Never modify files.\n\nRead a file.', 'Read-only access. Never modify files.', 'Child-only description.']);
  assertEquals(request, original);
});

for (const tools of [null, [null], [{ type: 'function', name: 123 }]]) {
  test(`callable projection uses typed input errors for malformed translated targets namespace children ${JSON.stringify(tools)}`, async () => {
    const call = invocation({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'invalid', description: '', tools }] } as unknown as CanonicalOpenAIResponsesPayload);
    let reachedTarget = false;
    await assertRejects(() => project(call, async () => {
      reachedTarget = true;
      return result();
    }), TranslatorInputError, 'Cannot flatten');
    assertEquals(reachedTarget, false);
  });
}

test('callable projection projects Standard carriers before namespace allocation without mutating history', async () => {
  const developer = { type: 'message' as const, role: 'developer' as const, content: 'Keep this ordinary developer instruction.' };
  const delayed = { type: 'tool_search_output' as const, tools: [functionTool('delayed')] };
  const request: CanonicalOpenAIResponsesPayload = {
    model: 'm', tools: [functionTool('files_edit')],
    input: [
      developer,
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'files', description: 'File policy.', tools: [{ type: 'custom', name: 'edit', description: 'Edit a file.' }] }] },
      { type: 'additional_tools', role: 'developer', tools: [functionTool('read')] },
      { type: 'custom_tool_call', namespace: 'files', name: 'edit', call_id: 'past', input: 'patch' },
      delayed,
    ],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', namespace: 'files', name: 'edit' }] },
  };
  const original = structuredClone(request);
  const call = invocation(request);
  const response = await project(call, async () => result([
    { type: 'response.completed', response: { ...emptyResult(), tools: call.payload.tools ?? undefined, tool_choice: call.payload.tool_choice, output: [{ type: 'function_call', name: 'files_edit_2', call_id: 'current', arguments: 'new patch', status: 'completed' }] } },
  ]));
  assertEquals(call.payload.tools?.map(tool => 'name' in tool ? tool.name : undefined), ['files_edit', 'files_edit_2', 'read', 'delayed']);
  assertEquals(call.payload.tools?.[1], { type: 'custom', name: 'files_edit_2', description: 'File policy.\n\nEdit a file.' });
  assertEquals(call.payload.input, [developer, { type: 'custom_tool_call', name: 'files_edit_2', call_id: 'past', input: 'patch' }]);
  assert(call.payload.input[0] === developer);
  assertEquals(call.payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', name: 'files_edit_2' }] });
  assertEquals(request, original);
  assert(response.type === 'events');
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of response.events) frames.push(frame);
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
      const call = invocation(request);
      const response = await project(call, async () => result([
        { type: 'response.completed', response: { ...emptyResult(), ...(echo ? { tools: call.payload.tools ?? undefined } : {}) } },
      ]));
      assertEquals(call.payload.input, []);
      assertEquals(call.payload.tools, [...(tools ?? []), functionTool('read')]);
      assert(response.type === 'events');
      let completed = 0;
      for await (const frame of response.events) {
        if (frame.type !== 'event' || frame.event.type !== 'response.completed') continue;
        completed++;
        assertEquals(frame.event.response.tools, echo ? tools : undefined);
        assertEquals(Object.hasOwn(frame.event.response, 'tools'), echo && tools !== undefined);
      }
      assertEquals(completed, 1);
    });
  }
}

for (const carrier of [
  { type: 'additional_tools', role: 'user', tools: [] },
  { type: 'additional_tools', role: 'developer', tools: null },
  { type: 'additional_tools', role: 'developer', tools: [null] },
  { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 42 }] },
]) {
  test(`callable projection typed-rejects malformed Standard carrier ${JSON.stringify(carrier)}`, async () => {
    const request = { model: 'm', input: [carrier] } as unknown as CanonicalOpenAIResponsesPayload;
    const call = invocation(request);
    let reachedTarget = false;
    await assertRejects(() => project(call, async () => {
      reachedTarget = true;
      return result();
    }), TranslatorInputError, 'additional_tools');
    assertEquals(reachedTarget, false);
    assert(call.payload === request);
  });
}

test('callable projection preserves long dotted flat names without inferring a namespace', () => {
  const namespace = `${'seg.'.repeat(4096)}end`;
  const name = `${namespace}.read`;
  const request: CanonicalOpenAIResponsesPayload = {
    model: 'm', tools: [{ type: 'namespace', name: namespace, description: '', tools: [functionTool('read')] }],
    input: [{ type: 'function_call', call_id: 'old', name, arguments: '{}', status: 'completed' }],
    tool_choice: { type: 'function', name },
  };
  const { payload } = flattenNamespaceTools(request);
  expect(payload.input).toEqual(request.input);
  expect(payload.tool_choice).toBe(request.tool_choice);
});

test.each(['.', '__', '_'])('flat and explicit namespace replay remain distinct in either history order (%s)', separator => {
  const explicit = { type: 'function_call' as const, namespace: 'files', name: 'read', call_id: 'explicit', arguments: '{}', status: 'completed' as const };
  const flat = { ...explicit, namespace: undefined, name: `files${separator}read`, call_id: 'flat' };
  for (const input of [[explicit, flat], [flat, explicit]]) {
    const { payload, names } = flattenNamespaceTools({ model: 'm', input });
    const explicitName = separator === '_' ? 'files_read_2' : 'files_read';
    expect(payload.input.map(item => item.type === 'function_call' ? [item.call_id, item.name, item.namespace] : [])).toEqual(input.map(item => [item.call_id, item.call_id === 'flat' ? flat.name : explicitName, undefined]));
    expect(names.targetToSource.get(explicitName)).toEqual({ namespace: 'files', name: 'read', type: 'function_call' });
    expect(names.targetToSource.has(flat.name)).toBe(false);
  }
});

test('dotted flat replay stays literal when multiple namespace splits would match', () => {
  const call = { type: 'function_call' as const, call_id: 'past', arguments: '{}', status: 'completed' as const };
  const input = [{ ...call, name: 'a.b.c' }, { ...call, namespace: 'a.b', name: 'c' }, { ...call, namespace: 'a', name: 'b.c' }];
  for (const history of [input, [...input].reverse()]) {
    const { payload } = flattenNamespaceTools({ model: 'm', input: history });
    expect(payload.input.find(item => item.type === 'function_call' && item.name === 'a.b.c')).toEqual(input[0]);
  }
});

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

test.each(['forced', 'allowed_tools'] as const)('unchanged flat %s choices and response frames keep their references', async mode => {
  const selector = { type: 'function' as const, name: 'read' };
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [functionTool('read')], tool_choice: mode === 'forced' ? selector : { type: 'allowed_tools', mode: 'auto', tools: [selector] } };
  const { payload, names } = flattenNamespaceTools(request);
  expect(payload.tool_choice).toBe(request.tool_choice);
  expect(names.toolChoiceChanged).toBe(false);
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

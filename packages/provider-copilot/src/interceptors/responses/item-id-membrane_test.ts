import { expect, test } from 'vitest';

import { unwrapCopilotItemId, wrapCopilotItemId } from './item-id-carrier.ts';
import { withCopilotResponsesItemIdMembrane } from './item-id-membrane.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesInputItem, type ResponsesOutputItem, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderResponsesResult } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const invocation = (input: ResponsesInputItem[] = []): ResponsesBoundaryCtx => ({
  payload: {
    model: 'test-model',
    input,
    instructions: null,
    temperature: 1,
    top_p: null,
    max_output_tokens: 32,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: true,
    store: false,
    parallel_tool_calls: true,
  },
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

const response = (output: ResponsesOutputItem[]): ResponsesResult => ({
  id: 'resp_test',
  object: 'response',
  model: 'test-model',
  output,
  status: 'completed',
  incomplete_details: null,
  error: null,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});

const collect = async (result: ProviderResponsesResult): Promise<ProtocolFrame<ResponsesStreamEvent>[]> => {
  if (result.action !== 'generate' || !result.ok) throw new Error('expected generate/ok result');
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = [];
  for await (const frame of result.events) frames.push(frame);
  return frames;
};

const runStream = async (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> | ProtocolFrame<ResponsesStreamEvent>[],
  ctx = invocation(),
): Promise<{ result: ProviderResponsesResult; ctx: ResponsesBoundaryCtx }> => {
  const iterable = Symbol.asyncIterator in frames
    ? frames as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>
    : (async function* () { yield* frames as ProtocolFrame<ResponsesStreamEvent>[]; })();
  const result = await withCopilotResponsesItemIdMembrane(ctx, {}, () => Promise.resolve({
    action: 'generate',
    ok: true,
    events: iterable,
    modelKey: 'test-model',
  }));
  return { result, ctx };
};

const outputItemEvent = (
  kind: 'added' | 'done',
  outputIndex: number,
  item: ResponsesOutputItem,
): ResponsesStreamEvent => ({
  type: kind === 'added' ? 'response.output_item.added' : 'response.output_item.done',
  output_index: outputIndex,
  item,
});

const eventAt = <TType extends ResponsesStreamEvent['type']>(
  frames: ProtocolFrame<ResponsesStreamEvent>[],
  type: TType,
): Extract<ResponsesStreamEvent, { type: TType }> => {
  const frame = frames.find(candidate => candidate.type === 'event' && candidate.event.type === type);
  if (frame?.type !== 'event') throw new Error(`expected ${type}`);
  return frame.event as Extract<ResponsesStreamEvent, { type: TType }>;
};

test('normalizes queued output and reuses its public id when the item is added', async () => {
  const item: ResponsesOutputItem = { type: 'reasoning', id: 'rs_queued', summary: [], encrypted_content: 'queued state' };
  const { result } = await runStream([
    eventFrame({ type: 'response.queued', response: { ...response([item]), status: 'queued' } }),
    eventFrame(outputItemEvent('added', 0, item)),
    eventFrame(outputItemEvent('done', 0, item)),
  ]);
  const frames = await collect(result);
  const queued = eventAt(frames, 'response.queued');
  const added = eventAt(frames, 'response.output_item.added');
  const done = eventAt(frames, 'response.output_item.done');

  expect(queued.response.output[0].id).toMatch(/^rs_[0-9a-f]{32}$/);
  if (queued.response.output[0].type !== 'reasoning') throw new Error('expected reasoning item');
  expect(unwrapCopilotItemId(queued.response.output[0].encrypted_content!)).toMatchObject({
    kind: 'owned',
    value: 'queued state',
    id: 'rs_queued',
  });
  expect(added.item.id).toBe(queued.response.output[0].id);
  expect(done.item.id).toBe(queued.response.output[0].id);
});

test('normalizes each reasoning lifecycle observation with its own upstream id and state', async () => {
  const added: ResponsesOutputItem = { type: 'reasoning', id: 'rs_added', summary: [], encrypted_content: 'opaque added' };
  const done: ResponsesOutputItem = { type: 'reasoning', id: 'rs_done', summary: [], encrypted_content: 'opaque done' };
  const terminal: ResponsesOutputItem = { type: 'reasoning', id: 'rs_terminal', summary: [], encrypted_content: 'opaque terminal' };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const upstream = (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame(outputItemEvent('added', 0, added));
    await gate;
    yield eventFrame({
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_mid',
      output_index: 0,
      summary_index: 0,
      delta: 'trace',
    });
    yield eventFrame(outputItemEvent('done', 0, done));
    yield eventFrame({ type: 'response.completed', response: response([terminal]) });
    yield doneFrame();
  })();

  const { result } = await runStream(upstream);
  if (result.action !== 'generate' || !result.ok) throw new Error('expected generate/ok result');
  const iterator = result.events[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.done).toBe(false);
  if (first.value?.type !== 'event' || first.value.event.type !== 'response.output_item.added') {
    throw new Error('expected output_item.added');
  }
  const publicId = first.value.event.item.id;
  expect(publicId).toMatch(/^rs_[0-9a-f]{32}$/);
  if (first.value.event.item.type !== 'reasoning') throw new Error('expected reasoning item');
  expect(unwrapCopilotItemId(first.value.event.item.encrypted_content!)).toMatchObject({
    kind: 'owned',
    value: 'opaque added',
    id: 'rs_added',
  });

  release();
  const rest: ProtocolFrame<ResponsesStreamEvent>[] = [];
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) rest.push(next.value);
  const delta = eventAt(rest, 'response.reasoning_summary_text.delta');
  const doneEvent = eventAt(rest, 'response.output_item.done');
  const completed = eventAt(rest, 'response.completed');
  expect(delta.item_id).toBe(publicId);
  expect(doneEvent.item.id).toBe(publicId);
  if (doneEvent.item.type !== 'reasoning') throw new Error('expected reasoning item');
  expect(unwrapCopilotItemId(doneEvent.item.encrypted_content!)).toEqual({
    kind: 'owned',
    value: 'opaque done',
    version: 1,
    origin: 'raw',
    id: 'rs_done',
  });
  const completedItem = completed.response.output[0];
  expect(completedItem.id).toBe(publicId);
  if (completedItem.type !== 'reasoning') throw new Error('expected terminal reasoning item');
  expect(unwrapCopilotItemId(completedItem.encrypted_content!)).toMatchObject({
    kind: 'owned',
    value: 'opaque terminal',
    id: 'rs_terminal',
  });
});

test.each([
  ['program', { type: 'program', id: 'cm_raw', call_id: 'call_program', code: 'return 1', fingerprint: 'program state' }],
  ['agent_message', {
    type: 'agent_message',
    id: 'amsg_raw',
    author: 'a',
    recipient: 'b',
    content: [{ type: 'encrypted_content', encrypted_content: 'agent state' }],
  }],
  ['compaction', { type: 'compaction', id: 'cmp_raw', encrypted_content: 'compaction state' }],
] as const)('normalizes carrier state on generic fast-path %s added frames', async (_type, fixture) => {
  const { result } = await runStream(responsesResultToEvents(response([fixture as ResponsesOutputItem])));
  const frames = await collect(result);
  const added = eventAt(frames, 'response.output_item.added').item;
  const done = eventAt(frames, 'response.output_item.done').item;
  const terminal = eventAt(frames, 'response.completed').response.output[0];

  expect(done.id).toBe(added.id);
  expect(terminal.id).toBe(added.id);
  if (added.type === 'program' && done.type === 'program' && terminal.type === 'program') {
    expect([added, done, terminal].map(item => unwrapCopilotItemId(item.fingerprint))).toEqual([
      expect.objectContaining({ kind: 'owned', value: 'program state', id: 'cm_raw' }),
      expect.objectContaining({ kind: 'owned', value: 'program state', id: 'cm_raw' }),
      expect.objectContaining({ kind: 'owned', value: 'program state', id: 'cm_raw' }),
    ]);
    return;
  }
  if (added.type === 'agent_message' && done.type === 'agent_message' && terminal.type === 'agent_message') {
    const carried = [added, done, terminal].map(item => item.content[0]);
    expect(carried.map(content => content.type === 'encrypted_content' && typeof content.encrypted_content === 'string'
      ? unwrapCopilotItemId(content.encrypted_content)
      : null)).toEqual([
      expect.objectContaining({ kind: 'owned', value: 'agent state', id: 'amsg_raw' }),
      expect.objectContaining({ kind: 'owned', value: 'agent state', id: 'amsg_raw' }),
      expect.objectContaining({ kind: 'owned', value: 'agent state', id: 'amsg_raw' }),
    ]);
    return;
  }
  if (added.type === 'compaction' && done.type === 'compaction' && terminal.type === 'compaction') {
    expect([added, done, terminal].map(item => unwrapCopilotItemId(item.encrypted_content))).toEqual([
      expect.objectContaining({ kind: 'owned', value: 'compaction state', id: 'cmp_raw' }),
      expect.objectContaining({ kind: 'owned', value: 'compaction state', id: 'cmp_raw' }),
      expect.objectContaining({ kind: 'owned', value: 'compaction state', id: 'cmp_raw' }),
    ]);
    return;
  }
  throw new Error('expected matching carrier item types');
});

const uncarriedOutputItems = [
  ['msg', { type: 'message', id: 'raw', role: 'assistant', content: [] }],
  ['fc', { type: 'function_call', id: 'raw', call_id: 'call', name: 'f', arguments: '{}', status: 'completed' }],
  ['ctc', { type: 'custom_tool_call', id: 'raw', call_id: 'call', name: 'tool', input: 'x' }],
  ['ws', { type: 'web_search_call', id: 'raw', status: 'completed', action: { type: 'search', queries: ['x'] } }],
  ['tsc', { type: 'tool_search_call', id: 'raw', arguments: {}, call_id: 'call', execution: 'server', status: 'completed' }],
  ['tso', { type: 'tool_search_output', id: 'raw', tools: [], call_id: 'call', execution: 'server', status: 'completed' }],
  ['cmo', { type: 'program_output', id: 'raw', call_id: 'call', result: 'ok', status: 'completed' }],
  ['sh', { type: 'shell_call', id: 'raw', call_id: 'call', action: { commands: ['pwd'] }, status: 'completed' }],
  ['sho', { type: 'shell_call_output', id: 'raw', call_id: 'call', output: [{ stdout: '', stderr: '', outcome: { type: 'exit', exit_code: 0 } }], status: 'completed' }],
  ['apc', { type: 'apply_patch_call', id: 'raw', call_id: 'call', operation: { type: 'delete_file', path: 'x' }, status: 'completed' }],
] as const;

test.each(uncarriedOutputItems)('randomizes a Copilot %s item without exposing its raw id', async (prefix, fixture) => {
  const item = fixture as ResponsesOutputItem;
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, item)),
    eventFrame(outputItemEvent('done', 0, item)),
    eventFrame({ type: 'response.completed', response: response([item]) }),
    doneFrame(),
  ]);
  const frames = await collect(result);
  const added = eventAt(frames, 'response.output_item.added');
  const done = eventAt(frames, 'response.output_item.done');
  const completed = eventAt(frames, 'response.completed');

  expect(added.item.id).toMatch(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
  expect(done.item.id).toBe(added.item.id);
  expect(completed.response.output[0].id).toBe(added.item.id);
  expect(JSON.stringify(frames)).not.toContain('"raw"');
});

test('preserves shell command events that carry no item id', async () => {
  const addedItem: ResponsesOutputItem = {
    type: 'shell_call',
    id: 'sh_raw',
    call_id: 'call_shell',
    action: { commands: [] },
    status: 'in_progress',
  };
  const doneItem: ResponsesOutputItem = {
    ...addedItem,
    action: { commands: ['ls -a ~/Desktop'] },
    status: 'completed',
  };
  const commandEvents: ResponsesStreamEvent[] = [
    { type: 'response.shell_call_command.added', output_index: 0, command_index: 0, command: '' },
    { type: 'response.shell_call_command.delta', output_index: 0, command_index: 0, delta: 'ls -a ~/Desktop', obfuscation: 'padding' },
    { type: 'response.shell_call_command.done', output_index: 0, command_index: 0, command: 'ls -a ~/Desktop' },
  ];
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, addedItem)),
    ...commandEvents.map(event => eventFrame(event)),
    eventFrame(outputItemEvent('done', 0, doneItem)),
  ]);
  const frames = await collect(result);
  const events = frames.flatMap(frame => frame.type === 'event' ? [frame.event] : []);
  const added = eventAt(frames, 'response.output_item.added');
  const done = eventAt(frames, 'response.output_item.done');

  expect(added.item.id).toMatch(/^sh_[0-9a-f]{32}$/);
  expect(done.item.id).toBe(added.item.id);
  expect(events.slice(1, 4)).toEqual(commandEvents);
});

test('rewrites a future item_id extension on a shell command event', async () => {
  const item: ResponsesOutputItem = {
    type: 'shell_call',
    id: 'sh_raw',
    call_id: 'call_shell',
    action: { commands: ['pwd'] },
    status: 'completed',
  };
  const extended = {
    type: 'response.shell_call_command.delta',
    output_index: 0,
    command_index: 0,
    delta: 'pwd',
    item_id: 'sh_raw',
  } as unknown as ResponsesStreamEvent;
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, item)),
    eventFrame(extended),
    eventFrame(outputItemEvent('done', 0, item)),
  ]);
  const frames = await collect(result);
  const added = eventAt(frames, 'response.output_item.added');
  const command = eventAt(frames, 'response.shell_call_command.delta') as typeof extended & { item_id: string };

  expect(command.item_id).toBe(added.item.id);
});

test('rewrites apply-patch diff item ids', async () => {
  const item: ResponsesOutputItem = {
    type: 'apply_patch_call',
    id: 'apc_raw',
    call_id: 'call_patch',
    operation: { type: 'create_file', path: 'x', diff: '+x' },
    status: 'completed',
  };
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, item)),
    eventFrame({ type: 'response.apply_patch_call_operation_diff.delta', item_id: 'apc_raw', output_index: 0, delta: '+x' }),
    eventFrame({ type: 'response.apply_patch_call_operation_diff.done', item_id: 'apc_raw', output_index: 0, diff: '+x' }),
    eventFrame(outputItemEvent('done', 0, item)),
  ]);
  const frames = await collect(result);
  const added = eventAt(frames, 'response.output_item.added');

  expect(eventAt(frames, 'response.apply_patch_call_operation_diff.delta').item_id).toBe(added.item.id);
  expect(eventAt(frames, 'response.apply_patch_call_operation_diff.done').item_id).toBe(added.item.id);
});

test('rewrites reasoning-text item ids', async () => {
  const item: ResponsesOutputItem = { type: 'reasoning', id: 'rs_raw', summary: [] };
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, item)),
    eventFrame({ type: 'response.reasoning_text.delta', item_id: 'rs_raw', output_index: 0, content_index: 0, delta: 'trace' }),
    eventFrame({ type: 'response.reasoning_text.done', item_id: 'rs_raw', output_index: 0, content_index: 0, text: 'trace' }),
    eventFrame(outputItemEvent('done', 0, item)),
  ]);
  const frames = await collect(result);
  const added = eventAt(frames, 'response.output_item.added');

  expect(eventAt(frames, 'response.reasoning_text.delta').item_id).toBe(added.item.id);
  expect(eventAt(frames, 'response.reasoning_text.done').item_id).toBe(added.item.id);
});

test('carries program and nested agent-message ids in every available blob', async () => {
  const items: ResponsesOutputItem[] = [
    { type: 'program', id: 'cm_raw', call_id: 'call_program', code: 'return 1', fingerprint: 'program state' },
    {
      type: 'agent_message',
      id: 'amsg_raw',
      author: 'a',
      recipient: 'b',
      content: [
        { type: 'encrypted_content', encrypted_content: 'agent state one' },
        { type: 'input_text', text: 'visible' },
        { type: 'encrypted_content', encrypted_content: 'agent state two' },
      ],
    },
  ];
  const { result } = await runStream(items.flatMap((item, index) => [
    eventFrame(outputItemEvent('added', index, item)),
    eventFrame(outputItemEvent('done', index, item)),
  ]));
  const frames = await collect(result);
  const doneItems = frames.flatMap(frame =>
    frame.type === 'event' && frame.event.type === 'response.output_item.done' ? [frame.event.item] : []);

  const [program, agent] = doneItems;
  expect(program.id).toMatch(/^cm_[0-9a-f]{32}$/);
  if (program.type !== 'program') throw new Error('expected program');
  expect(unwrapCopilotItemId(program.fingerprint)).toMatchObject({ kind: 'owned', value: 'program state', id: 'cm_raw' });
  expect(agent.id).toMatch(/^amsg_[0-9a-f]{32}$/);
  if (agent.type !== 'agent_message') throw new Error('expected agent_message');
  const encrypted = agent.content.flatMap(part =>
    part.type === 'encrypted_content' && typeof part.encrypted_content === 'string'
      ? [part.encrypted_content]
      : []);
  expect(encrypted.map(unwrapCopilotItemId)).toEqual([
    expect.objectContaining({ kind: 'owned', value: 'agent state one', id: 'amsg_raw' }),
    expect.objectContaining({ kind: 'owned', value: 'agent state two', id: 'amsg_raw' }),
  ]);
});

test('restores owned blob ids for Copilot input and leaves foreign items unchanged', async () => {
  const input: ResponsesInputItem[] = [
    { type: 'reasoning', id: 'rs_public', summary: [], encrypted_content: wrapCopilotItemId('reasoning state', 'rs_raw') },
    { type: 'program', id: 'cm_public', call_id: 'call_program', code: 'return 1', fingerprint: wrapCopilotItemId('program state', 'cm_raw') },
    {
      type: 'agent_message',
      id: 'amsg_public',
      author: 'a',
      recipient: 'b',
      content: [
        { type: 'encrypted_content', encrypted_content: wrapCopilotItemId('one', 'amsg_raw') },
        { type: 'encrypted_content', encrypted_content: wrapCopilotItemId('two', 'amsg_raw') },
      ],
    },
    { type: 'compaction', id: 'cmp_public', encrypted_content: wrapCopilotItemId('compact state', 'cmp_raw') },
    { type: 'reasoning', id: 'rs_foreign', summary: [], encrypted_content: 'foreign state' },
    { type: 'message', id: 'msg_foreign', role: 'user', content: 'hello' },
  ];
  const ctx = invocation(input);
  let wireInput: ResponsesInputItem[] | undefined;
  await withCopilotResponsesItemIdMembrane(ctx, {}, () => {
    wireInput = structuredClone(ctx.payload.input);
    return Promise.resolve({
      action: 'generate',
      ok: true,
      events: (async function* () { yield doneFrame(); })(),
      modelKey: 'test-model',
    });
  });

  expect(wireInput).toEqual([
    { type: 'reasoning', id: 'rs_raw', summary: [], encrypted_content: 'reasoning state' },
    { type: 'program', id: 'cm_raw', call_id: 'call_program', code: 'return 1', fingerprint: 'program state' },
    {
      type: 'agent_message',
      id: 'amsg_raw',
      author: 'a',
      recipient: 'b',
      content: [
        { type: 'encrypted_content', encrypted_content: 'one' },
        { type: 'encrypted_content', encrypted_content: 'two' },
      ],
    },
    { type: 'compaction', id: 'cmp_raw', encrypted_content: 'compact state' },
    { type: 'reasoning', id: 'rs_foreign', summary: [], encrypted_content: 'foreign state' },
    { type: 'message', id: 'msg_foreign', role: 'user', content: 'hello' },
  ]);
});

test('rejects conflicting ids carried by one input item', async () => {
  const ctx = invocation([{
    type: 'agent_message',
    id: 'amsg_public',
    author: 'a',
    recipient: 'b',
    content: [
      { type: 'encrypted_content', encrypted_content: wrapCopilotItemId('one', 'amsg_one') },
      { type: 'encrypted_content', encrypted_content: wrapCopilotItemId('two', 'amsg_two') },
    ],
  }]);

  await expect(withCopilotResponsesItemIdMembrane(ctx, {}, () => {
    throw new Error('must not reach upstream');
  })).rejects.toThrow(/conflicting upstream ids/);
});

test('normalizes the generated compaction item without touching retained compact messages', async () => {
  const compactResult = response([
    { type: 'message', id: 'msg_retained', role: 'assistant', content: [] },
    { type: 'compaction', id: 'cmp_raw', encrypted_content: 'compact state' },
  ]);
  const result = await withCopilotResponsesItemIdMembrane(invocation(), {}, () => Promise.resolve({
    action: 'compact',
    ok: true,
    result: compactResult,
    modelKey: 'test-model',
  }));
  if (result.action !== 'compact' || !result.ok) throw new Error('expected compact/ok result');

  expect(result.result.output[0].id).toBe('msg_retained');
  const compaction = result.result.output[1];
  expect(compaction.id).toMatch(/^cmp_[0-9a-f]{32}$/);
  if (compaction.type !== 'compaction') throw new Error('expected compaction');
  expect(unwrapCopilotItemId(compaction.encrypted_content)).toMatchObject({
    kind: 'owned',
    value: 'compact state',
    id: 'cmp_raw',
  });
});

test('fails closed on unknown output types before yielding a raw id', async () => {
  const unknown = { type: 'future_call', id: 'raw_future' } as unknown as ResponsesOutputItem;
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, unknown)),
    doneFrame(),
  ]);

  await expect(collect(result)).rejects.toThrow("Unsupported Copilot Responses output item type 'future_call'");
});

test('rejects a repeated output_item.added observation', async () => {
  const item: ResponsesOutputItem = { type: 'message', id: 'msg_raw', role: 'assistant', content: [] };
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, item)),
    eventFrame(outputItemEvent('added', 0, item)),
  ]);

  await expect(collect(result)).rejects.toThrow(/output_item\.added twice/);
});

test('rejects an output index whose observed item type changes', async () => {
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, { type: 'message', id: 'msg_raw', role: 'assistant', content: [] })),
    eventFrame(outputItemEvent('done', 0, { type: 'reasoning', id: 'rs_raw', summary: [] })),
  ]);

  await expect(collect(result)).rejects.toThrow(/changed type from message to reasoning/);
});

test('rejects replay state without the upstream id that authenticates it', async () => {
  const item = { type: 'reasoning', summary: [], encrypted_content: 'opaque state' } as unknown as ResponsesOutputItem;
  const { result } = await runStream([eventFrame(outputItemEvent('added', 0, item))]);

  await expect(collect(result)).rejects.toThrow(/has replay state but no upstream id/);
});

test.each(['toString', 'constructor', '__proto__'])('does not accept Object prototype key %s as an output item type', async type => {
  const unknown = { type, id: 'raw_future' } as unknown as ResponsesOutputItem;
  const { result } = await runStream([eventFrame(outputItemEvent('added', 0, unknown))]);

  await expect(collect(result)).rejects.toThrow(`Unsupported Copilot Responses output item type '${type}'`);
});

test('fails closed on unknown event envelopes that could hide an item id', async () => {
  const future = {
    type: 'response.future',
    item: { type: 'message', id: 'raw_future' },
  } as unknown as ResponsesStreamEvent;
  const { result } = await runStream([eventFrame(future)]);

  await expect(collect(result)).rejects.toThrow("Unsupported Copilot Responses stream event type 'response.future'");
});

test('passes through an unknown scalar event without item identity', async () => {
  const future = {
    type: 'response.future_progress',
    progress: 0.5,
  } as unknown as ResponsesStreamEvent;
  const { result } = await runStream([eventFrame(future)]);
  const frames = await collect(result);

  expect(frames).toEqual([eventFrame(future)]);
});

test('rewrites an item id extension on an unknown scalar event', async () => {
  const item: ResponsesOutputItem = { type: 'message', id: 'msg_raw', role: 'assistant', content: [] };
  const future = {
    type: 'response.future_delta',
    item_id: 'msg_raw',
    output_index: 0,
    delta: 'future',
  } as unknown as ResponsesStreamEvent;
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, item)),
    eventFrame(future),
  ]);
  const frames = await collect(result);
  const added = eventAt(frames, 'response.output_item.added');
  const normalized = frames[1];

  if (normalized.type !== 'event') throw new Error('expected future event');
  expect((normalized.event as unknown as { item_id: string }).item_id).toBe(added.item.id);
});

test('rejects an invalid item id extension on an unknown event', async () => {
  const future = {
    type: 'response.future_delta',
    item_id: 42,
    output_index: 0,
  } as unknown as ResponsesStreamEvent;
  const { result } = await runStream([eventFrame(future)]);

  await expect(collect(result)).rejects.toThrow(/carries an invalid item_id extension/);
});

test('forwards repeated done frames with stable public identity and each frame own content', async () => {
  const first: ResponsesOutputItem = { type: 'reasoning', id: 'rs_first', summary: [], encrypted_content: 'first' };
  const second: ResponsesOutputItem = { type: 'reasoning', id: 'rs_second', summary: [], encrypted_content: 'second' };
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, { type: 'reasoning', id: 'rs_added', summary: [] })),
    eventFrame(outputItemEvent('done', 0, first)),
    eventFrame(outputItemEvent('done', 0, second)),
  ]);
  const frames = await collect(result);
  const doneItems = frames.flatMap(frame =>
    frame.type === 'event' && frame.event.type === 'response.output_item.done' ? [frame.event.item] : []);

  expect(doneItems).toHaveLength(2);
  expect(doneItems[1].id).toBe(doneItems[0].id);
  if (doneItems[0].type !== 'reasoning' || doneItems[1].type !== 'reasoning') throw new Error('expected reasoning items');
  expect(unwrapCopilotItemId(doneItems[0].encrypted_content!)).toMatchObject({ value: 'first', id: 'rs_first' });
  expect(unwrapCopilotItemId(doneItems[1].encrypted_content!)).toMatchObject({ value: 'second', id: 'rs_second' });
});

test('normalizes a failed response with an open item instead of suppressing the failure', async () => {
  const partial: ResponsesOutputItem = { type: 'message', id: 'msg_failed', role: 'assistant', content: [] };
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, partial)),
    eventFrame({ type: 'response.failed', response: { ...response([partial]), status: 'failed' } }),
  ]);
  const frames = await collect(result);
  const added = eventAt(frames, 'response.output_item.added');
  const failed = eventAt(frames, 'response.failed');

  expect(failed.response.output[0].id).toBe(added.item.id);
  expect(failed.response.output[0]).toMatchObject({ type: 'message', role: 'assistant', content: [] });
});

test('rejects an id-bearing child event before its output item opens', async () => {
  const { result } = await runStream([
    eventFrame({
      type: 'response.output_text.delta',
      item_id: 'raw_message',
      output_index: 0,
      content_index: 0,
      delta: 'hello',
    }),
  ]);

  await expect(collect(result)).rejects.toThrow(/before output_item.added/);
});

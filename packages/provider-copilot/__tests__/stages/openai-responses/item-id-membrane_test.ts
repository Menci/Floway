import { expect, test } from 'vitest';

import { unwrapCopilotItemId, wrapCopilotItemId } from '../../../src/opaque-item-id.ts';
import { copilotOpenAIResponsesItemIdMembrane } from '../../../src/stages/openai-responses/item-id-membrane.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { isOpenAIResponsesCompactionItem, openaiResponsesResultToEvents, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesOutputItemEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { applyProviderStage, type OpenAIResponsesProbe, type ProviderOpenAIResponsesResult } from '@floway-dev/test-utils';
import { stubProviderModel } from '@floway-dev/test-utils';

const invocation = (input: CanonicalOpenAIResponsesInputItem[] = []): OpenAIResponsesProbe => ({
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
  model: stubProviderModel({ endpoints: { openaiResponses: {} } }),
  action: 'generate',
});

const response = (output: OpenAIResponsesOutputItemEx[]): OpenAIResponsesResultEx => ({
  id: 'resp_test',
  object: 'response',
  model: 'test-model',
  output,
  status: 'completed',
  incomplete_details: null,
  error: null,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});

const collect = async (result: ProviderOpenAIResponsesResult): Promise<ProtocolFrame<OpenAIResponsesStreamEventEx>[]> => {
  if (result.action !== 'generate' || !result.ok) throw new Error('expected generate/ok result');
  const frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[] = [];
  for await (const frame of result.events) frames.push(frame);
  return frames;
};

const runStream = async (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> | ProtocolFrame<OpenAIResponsesStreamEventEx>[],
  ctx = invocation(),
): Promise<{ result: ProviderOpenAIResponsesResult; ctx: OpenAIResponsesProbe }> => {
  const iterable = Symbol.asyncIterator in frames
    ? frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>
    : (async function* () { yield* frames as ProtocolFrame<OpenAIResponsesStreamEventEx>[]; })();
  const result = await applyProviderStage(copilotOpenAIResponsesItemIdMembrane, ctx, () => Promise.resolve({
    action: 'generate' as const,
    ok: true as const,
    events: iterable,
    modelKey: 'test-model',
  }));
  return { result, ctx };
};

const outputItemEvent = (
  kind: 'added' | 'done',
  outputIndex: number,
  item: OpenAIResponsesOutputItemEx,
): OpenAIResponsesStreamEventEx => ({
  type: kind === 'added' ? 'response.output_item.added' : 'response.output_item.done',
  output_index: outputIndex,
  item,
});

const eventAt = <TType extends OpenAIResponsesStreamEventEx['type']>(
  frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[],
  type: TType,
): Extract<OpenAIResponsesStreamEventEx, { type: TType }> => {
  const frame = frames.find(candidate => candidate.type === 'event' && candidate.event.type === type);
  if (frame?.type !== 'event') throw new Error(`expected ${type}`);
  return frame.event as Extract<OpenAIResponsesStreamEventEx, { type: TType }>;
};

test('normalizes queued output and reuses its public id when the item is added', async () => {
  const item: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'rs_queued', summary: [], encrypted_content: 'queued state' };
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
  const added: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'rs_added', summary: [], encrypted_content: 'opaque added' };
  const done: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'rs_done', summary: [], encrypted_content: 'opaque done' };
  const terminal: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'rs_terminal', summary: [], encrypted_content: 'opaque terminal' };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const upstream = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
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
  const rest: ProtocolFrame<OpenAIResponsesStreamEventEx>[] = [];
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
  const { result } = await runStream(openaiResponsesResultToEvents(response([fixture as OpenAIResponsesOutputItemEx])));
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
  if (isOpenAIResponsesCompactionItem(added) && isOpenAIResponsesCompactionItem(done) && isOpenAIResponsesCompactionItem(terminal)) {
    expect([added, done, terminal].map(item => {
      if (typeof item.encrypted_content !== 'string') throw new Error('expected compaction ciphertext');
      return unwrapCopilotItemId(item.encrypted_content);
    })).toEqual([
      expect.objectContaining({ kind: 'owned', value: 'compaction state', id: 'cmp_raw' }),
      expect.objectContaining({ kind: 'owned', value: 'compaction state', id: 'cmp_raw' }),
      expect.objectContaining({ kind: 'owned', value: 'compaction state', id: 'cmp_raw' }),
    ]);
    return;
  }
  throw new Error('expected matching carrier item types');
});

test('randomizes an uncarried Copilot item without exposing its raw id', async () => {
  const item: OpenAIResponsesOutputItemEx = { type: 'function_call', id: 'raw', call_id: 'call', name: 'f', arguments: '{}', status: 'completed' };
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

  expect(added.item.id).toMatch(/^fc_[0-9a-f]{32}$/);
  expect(done.item.id).toBe(added.item.id);
  expect(completed.response.output[0].id).toBe(added.item.id);
  expect(JSON.stringify(frames)).not.toContain('"raw"');
});

test('preserves shell command events that carry no item id', async () => {
  const addedItem: OpenAIResponsesOutputItemEx = {
    type: 'shell_call',
    id: 'sh_raw',
    call_id: 'call_shell',
    action: { commands: [] },
    status: 'in_progress',
  };
  const doneItem: OpenAIResponsesOutputItemEx = {
    ...addedItem,
    action: { commands: ['ls -a ~/Desktop'] },
    status: 'completed',
  };
  const commandEvents: OpenAIResponsesStreamEventEx[] = [
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

test('restores owned blob ids for Copilot input and leaves foreign items unchanged', async () => {
  const input: CanonicalOpenAIResponsesInputItem[] = [
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
  let wireInput: CanonicalOpenAIResponsesInputItem[] | undefined;
  await applyProviderStage(copilotOpenAIResponsesItemIdMembrane, ctx, () => {
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

  await expect(applyProviderStage(copilotOpenAIResponsesItemIdMembrane, ctx, () => {
    throw new Error('must not reach upstream');
  })).rejects.toThrow();
});

test('normalizes a generated compaction without touching retained compact messages', async () => {
  const type = 'context_compaction';
  const compactResult = response([
    { type: 'message', id: 'msg_retained', status: 'completed', role: 'assistant', content: [] },
    { type, id: 'cmp_raw', encrypted_content: 'compact state' },
  ]);
  const result = await applyProviderStage(copilotOpenAIResponsesItemIdMembrane, invocation(), () => Promise.resolve({
    action: 'compact',
    ok: true,
    result: compactResult,
    modelKey: 'test-model', http: { status: 200, headers: new Headers() },
  }));
  if (result.action !== 'compact' || !result.ok) throw new Error('expected compact/ok result');

  expect('id' in result.result.output[0] ? result.result.output[0].id : undefined).toBe('msg_retained');
  const compaction = result.result.output[1];
  if (!isOpenAIResponsesCompactionItem(compaction) || typeof compaction.encrypted_content !== 'string') throw new Error('expected compaction ciphertext');
  expect(compaction.type).toBe(type);
  expect(compaction.id).toMatch(/^cmp_[0-9a-f]{32}$/);
  expect(unwrapCopilotItemId(compaction.encrypted_content)).toMatchObject({
    kind: 'owned',
    value: 'compact state',
    id: 'cmp_raw',
  });
});

test('fails closed on unknown output types before yielding a raw id', async () => {
  const unknown = { type: 'future_call', id: 'raw_future' } as unknown as OpenAIResponsesOutputItemEx;
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, unknown)),
    doneFrame(),
  ]);

  await expect(collect(result)).rejects.toThrow();
});

test('rejects an output index whose observed item type changes', async () => {
  const { result } = await runStream([
    eventFrame(outputItemEvent('added', 0, { type: 'message', id: 'msg_raw', status: 'in_progress', role: 'assistant', content: [] })),
    eventFrame(outputItemEvent('done', 0, { type: 'reasoning', id: 'rs_raw', summary: [] })),
  ]);

  await expect(collect(result)).rejects.toThrow();
});

test('rejects replay state without the upstream id that authenticates it', async () => {
  const item = { type: 'reasoning', summary: [], encrypted_content: 'opaque state' } as unknown as OpenAIResponsesOutputItemEx;
  const { result } = await runStream([eventFrame(outputItemEvent('added', 0, item))]);

  await expect(collect(result)).rejects.toThrow();
});

test('fails closed on unknown event envelopes that could hide an item id', async () => {
  const future = {
    type: 'response.future',
    item: { type: 'message', id: 'raw_future' },
  } as unknown as OpenAIResponsesStreamEventEx;
  const { result } = await runStream([eventFrame(future)]);

  await expect(collect(result)).rejects.toThrow();
});

test('rewrites an item id extension on an unknown scalar event', async () => {
  const item: OpenAIResponsesOutputItemEx = { type: 'message', id: 'msg_raw', status: 'in_progress', role: 'assistant', content: [] };
  const future = {
    type: 'response.future_delta',
    item_id: 'msg_raw',
    output_index: 0,
    delta: 'future',
  } as unknown as OpenAIResponsesStreamEventEx;
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

test('normalizes a failed response with an open item instead of suppressing the failure', async () => {
  const partial: OpenAIResponsesOutputItemEx = { type: 'message', id: 'msg_failed', status: 'in_progress', role: 'assistant', content: [] };
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

  await expect(collect(result)).rejects.toThrow();
});

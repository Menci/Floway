import { expect, test } from 'vitest';

import { restoreCodexResponsesOutput } from '../src/responses-output.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesOutputItem, OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

const reasoning: OpenAIResponsesOutputItem = { type: 'reasoning', id: 'rs_0', summary: [], encrypted_content: 'reasoning' };
const message: OpenAIResponsesOutputItem = {
  type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'answer', annotations: [] }],
};
const compaction: OpenAIResponsesOutputItem = { type: 'compaction', id: 'cmp_2', encrypted_content: 'compaction' };

const response = (output: OpenAIResponsesOutputItem[], status: OpenAIResponsesResult['status'] = 'completed'): OpenAIResponsesResult => ({
  id: 'resp_1', object: 'response', model: 'test-model', status, output, error: null, incomplete_details: null,
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
});

const restore = async (events: OpenAIResponsesStreamEvent[]): Promise<ProtocolFrame<OpenAIResponsesStreamEvent>[]> => {
  const source = async function* () {
    for (const event of events) yield eventFrame(event);
    yield doneFrame();
  };
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of restoreCodexResponsesOutput(source())) frames.push(frame);
  return frames;
};

test('restores an empty Codex terminal in output_index order without changing item events or response metadata', async () => {
  const terminal = response([]);
  const events: OpenAIResponsesStreamEvent[] = [
    { type: 'response.created', response: { ...terminal, status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.completed', sequence_number: 12, response: terminal },
  ];
  const frames = await restore(events);
  expect(frames.slice(0, 3)).toEqual(events.slice(0, 3).map(eventFrame));
  expect(frames[3]).toEqual(eventFrame({ ...events[3], response: { ...terminal, output: [reasoning, message] } } as OpenAIResponsesStreamEvent));
  expect(terminal.output).toEqual([]);
  expect(frames[4]).toEqual(doneFrame());
});

test('restores omitted items by stream index when terminal positions have shifted', async () => {
  const frames = await restore([
    { type: 'response.output_item.done', output_index: 2, item: compaction },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.completed', response: response([message]) },
  ]);
  expect(frames[3]).toEqual(eventFrame({ type: 'response.completed', response: response([reasoning, message, compaction]) }));
});

test.each([
  ['response.incomplete', 'incomplete'],
  ['response.failed', 'failed'],
] as const)('preserves an unfinished snapshot item at its added index while repairing %s', async (type, status) => {
  const pending = { ...message, status: 'in_progress' };
  const terminalItem = { ...message, status: status === 'incomplete' ? 'incomplete' : 'in_progress' };
  const terminal = {
    ...response([terminalItem], status),
    ...(status === 'incomplete'
      ? { incomplete_details: { reason: 'max_output_tokens' } }
      : { error: { type: 'server_error', message: 'upstream failed' } }),
  };
  const frames = await restore([
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: pending },
    { type, response: terminal } as OpenAIResponsesStreamEvent,
  ]);
  expect(frames[2]).toEqual(eventFrame({ type, response: { ...terminal, output: [reasoning, terminalItem] } } as OpenAIResponsesStreamEvent));
});

test('preserves terminal item fields when another closed item was omitted', async () => {
  const snapshotReasoning = { ...reasoning, encrypted_content: 'snapshot-reasoning' };
  const frames = await restore([
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.completed', response: response([snapshotReasoning]) },
  ]);
  expect(frames[2]).toEqual(eventFrame({ type: 'response.completed', response: response([snapshotReasoning, message]) }));
});

test('keeps a complete snapshot including terminal-only items when nothing needs recovery', async () => {
  const terminal = response([reasoning, message]);
  const frames = await restore([
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.completed', response: terminal },
  ]);
  expect(frames[1]).toEqual(eventFrame({ type: 'response.completed', response: terminal }));
  if (frames[1].type !== 'event' || frames[1].event.type !== 'response.completed') throw new Error('expected completed response');
  expect(frames[1].event.response).toBe(terminal);
});

test('rejects a terminal-only item whose position cannot be determined during omission repair', async () => {
  await expect(restore([
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.completed', response: response([message]) },
  ])).rejects.toThrow('msg_1 has no observed output_index');
});

test('rejects gaps instead of collapsing observed output indices', async () => {
  await expect(restore([
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.completed', response: response([]) },
  ])).rejects.toThrow('missing output_index 0');
});

test('rejects an item ID observed at conflicting output indices', async () => {
  await expect(restore([
    { type: 'response.output_item.added', output_index: 0, item: reasoning },
    { type: 'response.output_item.done', output_index: 1, item: reasoning },
    { type: 'response.completed', response: response([]) },
  ])).rejects.toThrow('conflicting output_index values 0 and 1');
});

test('rejects duplicate snapshot identities when restoring an omitted item', async () => {
  await expect(restore([
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.completed', response: response([message, message]) },
  ])).rejects.toThrow('repeats output_index 1');
});

test('rejects different item identities at the same output index', async () => {
  await expect(restore([
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: response([]) },
  ])).rejects.toThrow('output_index 0 has conflicting item IDs');
});

test('restores an ID-less compaction item when the terminal is empty', async () => {
  const item: OpenAIResponsesOutputItem = { type: 'compaction', encrypted_content: 'opaque' };
  const frames = await restore([
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: response([]) },
  ]);
  expect(frames[1]).toEqual(eventFrame({ type: 'response.completed', response: response([item]) }));
});

test('leaves error events and terminal snapshots without closed items untouched', async () => {
  const terminal: OpenAIResponsesStreamEvent = { type: 'response.failed', response: response([message], 'failed') };
  const frames = await restore([terminal]);
  expect(frames).toEqual([eventFrame(terminal), doneFrame()]);
  const error: OpenAIResponsesStreamEvent = { type: 'error', message: 'upstream error' };
  expect(await restore([error])).toEqual([eventFrame(error), doneFrame()]);
});

import { expect, test } from 'vitest';

import { collect, collectIR, irFromOpenAIResponses, iterate } from './helpers.ts';
import { createRoundTripReaderCapture } from '../round-trip/test-helpers.ts';
import { eventFrame } from '@floway-dev/protocols/common';

const response = (output: any[] = []) => ({ id: 'resp', model: 'served', created_at: 1, status: 'completed', output, usage: null, error: null, incomplete_details: null });
const read = async (events: any[]) => await collectIR(irFromOpenAIResponses(iterate(events.map(event => eventFrame(event as any)))));

test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('output indexes must be nonnegative safe integers: %s', async outputIndex => {
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: outputIndex, item: { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] } },
  ])).rejects.toThrow('output_index must be a nonnegative safe integer');
});

test('empty output_item.done content does not erase streamed text', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const done = { ...added, status: 'completed', content: [] };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'visible' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'visible' }] });
});

test('output_item.done supplies a reasoning summary omitted from deltas', async () => {
  const added = { type: 'reasoning', id: 'rs', summary: [], status: 'in_progress' };
  const done = { ...added, summary: [{ type: 'summary_text', text: 'summary' }], status: 'completed' };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'reasoning', summary: ['summary'] });
});

test('done snapshots append a missing suffix', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const part = { type: 'output_text', text: 'hello', annotations: [] };
  const done = { ...added, status: 'completed', content: [part] };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hel' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'hello' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'message', content: [{ text: 'hello' }] });
});

test('non-prefix done snapshots throw', async () => {
  const added = { type: 'reasoning', id: 'rs', summary: [], status: 'in_progress' };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'tail' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'headtail' },
  ])).rejects.toThrow('cannot replace streamed text');
});

test('text done does not close the field and later deltas remain valid', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const part = { type: 'output_text', text: 'codex', annotations: [] };
  const done = { ...added, status: 'completed', content: [part] };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'cod' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'cod' },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'ex' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'message', content: [{ text: 'codex' }] });
});

test('terminal response closes an item without output_item.done', async () => {
  const added = { type: 'function_call', id: 'fc', call_id: 'call', name: 'tool', arguments: '', status: 'in_progress' };
  const done = { ...added, arguments: '{}', status: 'completed' };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'function_call', arguments: '{}' });
});

test.each([
  ['type', { type: 'reasoning', id: 'msg', summary: [] }, 'type changed'],
  ['id', { type: 'message', id: 'other', role: 'assistant', status: 'completed', content: [] }, 'id changed'],
] as const)('output_item.done rejects a snapshot %s mismatch', async (_name, done, message) => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
  ])).rejects.toThrow(message);
});

test('output_item.done initializes snapshot-only content and logprobs', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const token = { token: 'x', logprob: -1, bytes: [120], top_logprobs: [] };
  const done = { ...added, status: 'completed', content: [{ type: 'output_text', text: 'x', annotations: [], logprobs: [token] }] };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'message', content: [{ text: 'x' }] });
  expect(result.choices[0].logprobs?.[0].tokens).toEqual([token]);
});

test('logprob deltas append tokens before reconciling the complete snapshot', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const first = { token: 'a', logprob: -1, bytes: [97], top_logprobs: [] };
  const second = { token: 'b', logprob: -2, bytes: [98], top_logprobs: [] };
  const part = { type: 'output_text', text: 'ab', annotations: [], logprobs: [first, second] };
  const done = { ...added, status: 'completed', content: [part] };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...part, text: '', logprobs: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'a', logprobs: [first] },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'b', logprobs: [second] },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'ab', logprobs: [first, second] },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].logprobs?.[0].tokens).toEqual([first, second]);
});

test('nullable annotation indexes map into a compact IR annotation array', async () => {
  const citation = { type: 'url_citation', url: 'https://example.test', title: 'source', start_index: 0, end_index: 6 };
  const part = { type: 'output_text', text: 'answer', annotations: [citation], logprobs: [] };
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const done = { ...added, status: 'completed', content: [part] };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { ...part, text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'answer' },
    { type: 'response.output_text.annotation.added', output_index: 0, content_index: 0, annotation_index: 0, annotation: null },
    { type: 'response.output_text.annotation.added', output_index: 0, content_index: 0, annotation_index: 1, annotation: citation },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({
    type: 'message',
    content: [{ annotations: [{ type: 'source_citation', source: citation.url }] }],
  });
});

test('empty final reasoning summary preserves streamed content', async () => {
  const added = { type: 'reasoning', id: 'rs', summary: [], status: 'in_progress' };
  const done = { ...added, status: 'completed' };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'visible' },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([done]) },
  ]);
  expect(result.choices[0].items[0]).toMatchObject({ type: 'reasoning', summary: ['visible'] });
});

test('a second output_item.added at an announced index throws', async () => {
  const item = { type: 'reasoning', id: 'rs', summary: [] };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.added', output_index: 0, item },
  ])).rejects.toThrow('Duplicate Responses output_item.added');
});

test.each([
  ['message content', { type: 'message', id: 'msg', role: 'assistant', status: 'completed' }, 'message snapshot requires content'],
  ['reasoning summary', { type: 'reasoning', id: 'rs', status: 'completed' }, 'reasoning snapshot requires summary'],
] as const)('output_item.done requires %s', async (_name, done, error) => {
  const added = done.type === 'message'
    ? { ...done, status: 'in_progress', content: [] }
    : { ...done, status: 'in_progress', summary: [] };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
  ])).rejects.toThrow(error);
});

test('terminal Responses envelope may omit an empty output snapshot', async () => {
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.completed', response: { ...response(), output: undefined } },
  ]);
  expect(result.choices[0].items).toEqual([]);
});

test.each([
  ['output text done', { type: 'response.output_text.done', output_index: 0, content_index: 0 }],
  ['reasoning text done', { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0 }],
] as const)('%s requires its final text snapshot', async (_name, done) => {
  const message = _name === 'output text done';
  const added = message
    ? { type: 'message', id: 'item', role: 'assistant', status: 'in_progress', content: [] }
    : { type: 'reasoning', id: 'item', status: 'in_progress', summary: [] };
  const part = message
    ? { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }
    : { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    part,
    done,
  ])).rejects.toThrow('text snapshot must be a string');
});

test('output item snapshots require text in every declared part', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: { ...added, status: 'completed', content: [{ type: 'output_text', annotations: [] }] } },
  ])).rejects.toThrow('text snapshot must be a string');
});

test('Responses retains the initial response id when later envelopes rotate it', async () => {
  const records = await collect(irFromOpenAIResponses(iterate([
    eventFrame({ type: 'response.created', response: response([]) } as any),
    eventFrame({ type: 'response.in_progress', response: { ...response([]), id: 'resp_rotated' } } as any),
    eventFrame({ type: 'response.completed', response: { ...response([]), id: 'resp_terminal' } } as any),
  ])));
  expect(records.find(record => record.type === 'start')).toEqual({ type: 'start', id: 'resp', created: 1 });
});

test('Responses rejects a changed response model', async () => {
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.in_progress', response: { ...response([]), model: 'other-model' } },
  ])).rejects.toThrow('response model changed');
});

test('terminal Responses output cannot omit an open item', async () => {
  const added = { type: 'reasoning', id: 'rs', summary: [], status: 'in_progress' };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.completed', response: response([]) },
  ])).rejects.toThrow('omitted output indexes');
});

test('an empty terminal Responses output preserves closed items', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const done = { ...added, status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [], logprobs: [] }] };
  const empty = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([]) },
  ]);
  expect(empty.choices[0].items[0]).toMatchObject({ type: 'message', content: [{ text: 'answer' }] });

  const absent = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: { ...response(), output: undefined } },
  ]);
  expect(absent.choices[0].items[0]).toMatchObject({ type: 'message', content: [{ text: 'answer' }] });
});

test('an empty terminal Responses output captures closed snapshots for round trip', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const done = { ...added, status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [], logprobs: [] }] };
  const capture = createRoundTripReaderCapture<'openaiResponses'>();
  await collectIR(irFromOpenAIResponses(iterate([
    eventFrame({ type: 'response.created', response: response([]) } as any),
    eventFrame({ type: 'response.output_item.added', output_index: 0, item: added } as any),
    eventFrame({ type: 'response.output_item.done', output_index: 0, item: done } as any),
    eventFrame({ type: 'response.completed', response: response([]) } as any),
  ]), capture.roundTrip));
  expect(capture.turns.get(0)?.turn).toEqual([{ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: done.content }]);
});

test('a non-empty terminal Responses output cannot change a closed item', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  const done = { ...added, status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [], logprobs: [] }] };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([{ ...done, content: [{ type: 'output_text', text: 'changed', annotations: [], logprobs: [] }] }]) },
  ])).rejects.toThrow('conflicts with closed output item');
});

test('terminal Responses reasoning may rotate encrypted content after output_item.done', async () => {
  const added = { type: 'reasoning', id: 'rs', summary: [], content: [], status: 'in_progress' };
  const done = { ...added, status: 'completed', encrypted_content: 'completed-carrier' };
  const result = await read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([{ ...done, encrypted_content: 'terminal-carrier' }]) },
  ]);
  expect(result.choices[0].items).toEqual([]);
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: response([{ ...done, summary: [{ type: 'summary_text', text: 'changed' }] }]) },
  ])).rejects.toThrow('conflicts with closed output item');
});

test('output-text annotations require an output-text owner', async () => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'refusal', refusal: '' } },
    { type: 'response.output_text.annotation.added', output_index: 0, content_index: 0, annotation_index: 0, annotation: { type: 'file_citation', file_id: 'file_1', filename: 'file' } },
  ])).rejects.toThrow('requires an output-text part');
});

test.each([
  ['output_text', { type: 'output_text', text: '', annotations: [] }, { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'refused' }, 'refusal'],
  ['refusal', { type: 'refusal', refusal: '' }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'answer' }, 'output_text'],
] as const)('Responses content part type cannot change from %s at an existing index', async (initialType, part, event, nextType) => {
  const added = { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part },
    event,
  ])).rejects.toThrow(`content part type changed from ${initialType} to ${nextType}`);
});

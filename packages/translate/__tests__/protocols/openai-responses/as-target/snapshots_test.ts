import { expect, test } from 'vitest';

import { collectIR } from '../../../ir/output/helpers.ts';
import { collect, iterate } from '../../../shared/iterables.ts';
import { readOpenAIResponsesEvents } from '../../helpers.ts';
import { eventFrame } from '@floway-dev/protocols/common';

const response = (output: any[] = []) => ({ id: 'resp', model: 'served', created_at: 1, status: 'completed', output, usage: null, error: null, incomplete_details: null });
const read = async (events: any[]) => await collectIR(readOpenAIResponsesEvents(iterate(events.map(event => eventFrame(event as any)))));

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
  ])).rejects.toThrow();
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

test('Responses retains the initial response id when later envelopes rotate it', async () => {
  const records = await collect(readOpenAIResponsesEvents(iterate([
    eventFrame({ type: 'response.created', response: response([]) } as any),
    eventFrame({ type: 'response.in_progress', response: { ...response([]), id: 'resp_rotated' } } as any),
    eventFrame({ type: 'response.completed', response: { ...response([]), id: 'resp_terminal' } } as any),
  ])));
  expect(records.find(record => record.type === 'start')).toEqual({ type: 'start', id: 'resp', created: 1 });
});

test('terminal Responses output cannot omit an open item', async () => {
  const added = { type: 'reasoning', id: 'rs', summary: [], status: 'in_progress' };
  await expect(read([
    { type: 'response.created', response: response([]) },
    { type: 'response.output_item.added', output_index: 0, item: added },
    { type: 'response.completed', response: response([]) },
  ])).rejects.toThrow();
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
  ])).rejects.toThrow();
});

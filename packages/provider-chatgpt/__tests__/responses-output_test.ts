import { assert, expect, test } from 'vitest';

import { createChatGPTResponsesOutputRestore } from '../src/responses-output.ts';
import type { OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const reasoning: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'rs_0', summary: [], encrypted_content: 'reasoning' };
const message: OpenAIResponsesOutputItemEx = {
  type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'answer', annotations: [] }],
};

const response = (output: OpenAIResponsesOutputItemEx[], status: OpenAIResponsesResultEx['status'] = 'completed'): OpenAIResponsesResultEx => ({
  id: 'resp_1', object: 'response', model: 'test-model', status, output, error: null, incomplete_details: null,
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
});

const restore = (events: OpenAIResponsesStreamEventEx[]): OpenAIResponsesStreamEventEx[] =>
  events.map(createChatGPTResponsesOutputRestore()).map(result => {
    assert(result.ok);
    return result.value;
  });

test('restores an empty Codex terminal in output_index order without changing item events or response metadata', () => {
  const terminal = response([]);
  const events: OpenAIResponsesStreamEventEx[] = [
    { type: 'response.created', response: { ...terminal, status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.completed', sequence_number: 12, response: terminal },
  ];
  const projected = restore(events);
  expect(projected.slice(0, 3)).toEqual(events.slice(0, 3));
  expect(projected[3]).toEqual({ ...events[3], response: { ...terminal, output: [reasoning, message] } });
  expect(terminal.output).toEqual([]);
});

test.each([
  ['response.incomplete', 'incomplete'],
  ['response.failed', 'failed'],
] as const)('preserves an unfinished snapshot item at its added index while repairing %s', (type, status) => {
  const pending = { ...message, status: 'in_progress' };
  const terminalItem = { ...message, status: status === 'incomplete' ? 'incomplete' : 'in_progress' };
  const terminal = {
    ...response([terminalItem], status),
    ...(status === 'incomplete'
      ? { incomplete_details: { reason: 'max_output_tokens' } }
      : { error: { type: 'server_error', message: 'upstream failed' } }),
  };
  const projected = restore([
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: pending },
    { type, response: terminal } as OpenAIResponsesStreamEventEx,
  ]);
  expect(projected[2]).toEqual({ type, response: { ...terminal, output: [reasoning, terminalItem] } });
});

test('rejects a terminal-only item whose position cannot be determined during omission repair', () => {
  const restore = createChatGPTResponsesOutputRestore();
  expect(restore({ type: 'response.output_item.done', output_index: 0, item: reasoning }).ok).toBe(true);
  expect(restore({ type: 'response.completed', response: response([message]) })).toMatchObject({
    ok: false, error: { kind: 'protocol', cause: expect.objectContaining({ message: expect.stringContaining('has no observed output_index') }) },
  });
});

test('rejects an item ID observed at conflicting output indices', () => {
  const restore = createChatGPTResponsesOutputRestore();
  expect(restore({ type: 'response.output_item.added', output_index: 0, item: reasoning }).ok).toBe(true);
  expect(restore({ type: 'response.output_item.done', output_index: 1, item: reasoning })).toMatchObject({
    ok: false, error: { kind: 'protocol', cause: expect.objectContaining({ message: expect.stringContaining('has conflicting output_index values') }) },
  });
});

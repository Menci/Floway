import { expect, test } from 'vitest';

import type { OpenAIResponsesOutputItem, OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '../../src/openai-responses/index.ts';
import { reassembleOpenAIResponsesEvents } from '../../src/openai-responses/reassemble.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

type OpenAIResponsesReassembleEvent =
  | OpenAIResponsesStreamEvent
  | {
    type: 'error';
    message?: string;
  };

function makeEvents<T = OpenAIResponsesReassembleEvent>(chunks: Array<{ event?: string; data: unknown }>): AsyncIterable<T> {
  return (async function* () {
    for (const chunk of chunks) {
      if (typeof chunk.data === 'string') continue;

      const data = chunk.data as Record<string, unknown>;
      yield (chunk.event && typeof data.type !== 'string' ? { ...data, type: chunk.event } : data) as T;
    }
  })();
}

test('reassembleOpenAIResponsesEvents extracts response from completed event', async () => {
  const expected: OpenAIResponsesResult = {
    id: 'resp_1',
    object: 'response',
    model: 'gpt-test',
    status: 'completed',
    output_text: 'Hello',
    output: [
      {
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
      },
    ],
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };

  const body = makeEvents([
    {
      event: 'response.created',
      data: {
        type: 'response.created',
        response: { ...expected, status: 'in_progress' },
      },
    },
    {
      event: 'response.in_progress',
      data: {
        type: 'response.in_progress',
        response: { ...expected, status: 'in_progress' },
      },
    },
    {
      event: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: 'Hello' },
    },
    {
      event: 'response.completed',
      data: { type: 'response.completed', response: expected },
    },
  ]);

  const result = await reassembleOpenAIResponsesEvents(body);

  assertEquals(result.id, 'resp_1');
  assertEquals(result.status, 'completed');
  assertEquals(result.output_text, 'Hello');
});

test('reassembleOpenAIResponsesEvents handles incomplete event', async () => {
  const incomplete: OpenAIResponsesResult = {
    id: 'resp_2',
    object: 'response',
    model: 'gpt-test',
    status: 'incomplete',
    output_text: '',
    output: [],
    error: null,
    incomplete_details: { reason: 'max_tokens' },
  };

  const body = makeEvents([
    {
      event: 'response.incomplete',
      data: { type: 'response.incomplete', response: incomplete },
    },
  ]);

  const result = await reassembleOpenAIResponsesEvents(body);
  assertEquals(result.status, 'incomplete');
});

test('reassembleOpenAIResponsesEvents throws on error event', async () => {
  const body = makeEvents([{ event: 'error', data: { type: 'error', message: 'bad request' } }]);

  await assertRejects(() => reassembleOpenAIResponsesEvents(body), Error, 'bad request');
});

test('reassembleOpenAIResponsesEvents throws when stream ends without terminal event', async () => {
  const body = makeEvents([
    {
      event: 'response.created',
      data: { type: 'response.created', response: {} },
    },
  ]);

  await assertRejects(() => reassembleOpenAIResponsesEvents(body), Error, 'terminal');
});

test.each([
  ['response.completed', 'completed'],
  ['response.incomplete', 'incomplete'],
  ['response.failed', 'failed'],
] as const)('reassembleOpenAIResponsesEvents preserves the %s snapshot despite different closed items', async (type, status) => {
  const closed: OpenAIResponsesOutputItem = { type: 'reasoning', id: 'rs_closed', summary: [] };
  const snapshotOnly: OpenAIResponsesOutputItem = {
    type: 'message', id: 'msg_snapshot', status: status === 'completed' ? 'completed' : 'incomplete', role: 'assistant',
    content: [{ type: 'output_text', text: 'Snapshot content', annotations: [] }],
  };
  for (const output of [[], [closed, snapshotOnly]]) {
    const terminal: OpenAIResponsesResult = {
      id: 'resp_snapshot', object: 'response', model: 'test-model', status,
      output, error: null, incomplete_details: null,
    };
    const result = await reassembleOpenAIResponsesEvents(makeEvents([
      { data: { type: 'response.output_item.done', output_index: 0, item: closed } },
      { data: { type, response: terminal } },
    ]));
    expect(result).toBe(terminal);
    expect(result.output).toEqual(output);
  }
});

test('reassembleOpenAIResponsesEvents preserves terminal snapshot when no closed items observed', async () => {
  const fallbackItem: OpenAIResponsesOutputItem = {
    type: 'message',
    id: 'msg_snap',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Snapshot only', annotations: [] }],
  };

  const body = makeEvents([
    {
      event: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: 'Snapshot only' },
    },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: { id: 'resp_snap', object: 'response', model: 'gpt-test', status: 'completed', output: [fallbackItem], error: null, incomplete_details: null },
      },
    },
  ]);

  const result = await reassembleOpenAIResponsesEvents(body);
  assertEquals(result.output, [fallbackItem]);
});

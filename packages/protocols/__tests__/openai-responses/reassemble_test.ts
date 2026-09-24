import { test } from 'vitest';

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

test('reassembleOpenAIResponsesEvents reconstructs output in index order when terminal output is empty', async () => {
  const item0: OpenAIResponsesOutputItem = {
    type: 'message',
    id: 'msg_0',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'First item', annotations: [] }],
  };
  const item1: OpenAIResponsesOutputItem = {
    type: 'compaction',
    id: 'cmp_1',
    encrypted_content: 'BLOB_1',
  };

  const body = makeEvents([
    {
      event: 'response.created',
      data: {
        type: 'response.created',
        response: { id: 'resp_empty_term', object: 'response', model: 'gpt-test', status: 'in_progress', output: [], error: null, incomplete_details: null },
      },
    },
    // Emit out of order to verify sorting by output_index
    {
      event: 'response.output_item.done',
      data: { type: 'response.output_item.done', output_index: 1, item: item1 },
    },
    {
      event: 'response.output_item.done',
      data: { type: 'response.output_item.done', output_index: 0, item: item0 },
    },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: { id: 'resp_empty_term', object: 'response', model: 'gpt-test', status: 'completed', output: [], error: null, incomplete_details: null },
      },
    },
  ]);

  const result = await reassembleOpenAIResponsesEvents(body);
  assertEquals(result.output, [item0, item1]);
});

test('reassembleOpenAIResponsesEvents prefers closed items over a terminal that omits one', async () => {
  const reasoning: OpenAIResponsesOutputItem = { type: 'reasoning', id: 'rs_0', summary: [], encrypted_content: 'BLOB_0' };
  const message: OpenAIResponsesOutputItem = {
    type: 'message',
    id: 'msg_1',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Closed but unstated', annotations: [] }],
  };

  // A Codex upstream states a terminal `output` that omits the message it just closed.
  const body = makeEvents([
    {
      event: 'response.output_item.done',
      data: { type: 'response.output_item.done', output_index: 0, item: reasoning },
    },
    {
      event: 'response.output_item.done',
      data: { type: 'response.output_item.done', output_index: 1, item: message },
    },
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: { id: 'resp_partial', object: 'response', model: 'gpt-test', status: 'completed', output: [reasoning], error: null, incomplete_details: null },
      },
    },
  ]);

  const result = await reassembleOpenAIResponsesEvents(body);
  assertEquals(result.output, [reasoning, message]);
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

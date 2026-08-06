import { test } from 'vitest';

import type { ResponsesResult, ResponsesStreamEvent } from '../../src/responses/index.ts';
import { reassembleResponsesEvents } from '../../src/responses/reassemble.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

type ResponsesReassembleEvent =
  | ResponsesStreamEvent
  | {
    type: 'error';
    message?: string;
  };

function makeEvents<T = ResponsesReassembleEvent>(chunks: Array<{ event?: string; data: unknown }>): AsyncIterable<T> {
  return (async function* () {
    for (const chunk of chunks) {
      if (typeof chunk.data === 'string') continue;

      const data = chunk.data as Record<string, unknown>;
      yield (chunk.event && typeof data.type !== 'string' ? { ...data, type: chunk.event } : data) as T;
    }
  })();
}

test('reassembleResponsesEvents extracts response from completed event', async () => {
  const expected: ResponsesResult = {
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

  const result = await reassembleResponsesEvents(body);

  assertEquals(result.id, 'resp_1');
  assertEquals(result.status, 'completed');
  assertEquals(result.output_text, 'Hello');
});

test('reassembleResponsesEvents handles incomplete event', async () => {
  const incomplete: ResponsesResult = {
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

  const result = await reassembleResponsesEvents(body);
  assertEquals(result.status, 'incomplete');
});

test('reassembleResponsesEvents throws on error event', async () => {
  const body = makeEvents([{ event: 'error', data: { type: 'error', message: 'bad request' } }]);

  await assertRejects(() => reassembleResponsesEvents(body), Error, 'bad request');
});

test('reassembleResponsesEvents returns a response.failed that follows an error event', async () => {
  const failed: ResponsesResult = {
    id: 'resp_failed', object: 'response', model: 'gpt-test', status: 'failed',
    output: [], error: { code: 'overloaded', message: 'try later' }, incomplete_details: null,
  };
  const result = await reassembleResponsesEvents(makeEvents([
    { data: { type: 'error', message: 'try later' } },
    { data: { type: 'response.failed', response: failed } },
  ]));

  assertEquals(result, failed);
});

test('reassembleResponsesEvents rejects a success terminal after an error event', async () => {
  await assertRejects(() => reassembleResponsesEvents(makeEvents([
    { data: { type: 'error', message: 'try later' } },
    { data: {
      type: 'response.completed',
      response: {
        id: 'resp_bad', object: 'response', model: 'gpt-test', status: 'completed',
        output: [], error: null, incomplete_details: null,
      },
    } },
  ])), Error, 'try later');
});

test('reassembleResponsesEvents throws when stream ends without terminal event', async () => {
  const body = makeEvents([
    {
      event: 'response.created',
      data: { type: 'response.created', response: {} },
    },
  ]);

  await assertRejects(() => reassembleResponsesEvents(body), Error, 'terminal');
});

test('reassembleResponsesEvents rejects malformed and contradictory terminal events', async () => {
  await assertRejects(
    () => reassembleResponsesEvents(makeEvents([{ data: { type: 'response.completed' } }])),
    TypeError,
    'must carry a response object',
  );
  await assertRejects(
    () => reassembleResponsesEvents(makeEvents([{
      data: {
        type: 'response.completed',
        response: {
          id: 'resp_bad', object: 'response', model: 'gpt-test', status: 'failed', output: [], error: null, incomplete_details: null,
        },
      },
    }])),
    TypeError,
    'cannot carry Responses status "failed"',
  );
});

test('reassembleResponsesEvents accepts a completed compaction resource with no status field', async () => {
  const compaction = {
    id: 'cmp_1',
    object: 'response.compaction',
    output: [],
    created_at: 1,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const result = await reassembleResponsesEvents(makeEvents([{
    data: { type: 'response.completed', response: compaction },
  }]));

  assertEquals(result, compaction);
});

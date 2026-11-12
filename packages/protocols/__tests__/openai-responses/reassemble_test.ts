import { expect, test } from 'vitest';

import type { OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '../../src/openai-responses/index.ts';
import { reassembleOpenAIResponsesEvents } from '../../src/openai-responses/reassemble.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

function makeEvents<T = OpenAIResponsesStreamEventEx>(chunks: Array<{ event?: string; data: unknown }>): AsyncIterable<T> {
  return (async function* () {
    for (const chunk of chunks) {
      if (typeof chunk.data === 'string') continue;

      const data = chunk.data as Record<string, unknown>;
      yield (chunk.event && typeof data.type !== 'string' ? { ...data, type: chunk.event } : data) as T;
    }
  })();
}

test('reassembleOpenAIResponsesEvents extracts response from completed event', async () => {
  const expected: OpenAIResponsesResultEx = {
    id: 'resp_1',
    object: 'response',
    model: 'gpt-test',
    status: 'completed',
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
  assertEquals(Object.hasOwn(result, 'output_text'), false);
});

test('reassembleOpenAIResponsesEvents handles incomplete event', async () => {
  const incomplete: OpenAIResponsesResultEx = {
    id: 'resp_2',
    object: 'response',
    model: 'gpt-test',
    status: 'incomplete',
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

test.each([
  { type: 'error', code: null, param: 'model', message: 'bad request', sequence_number: 1, request_id: 'req_flat' },
  { type: 'error', code: null, param: null, message: 'bad request', error: null, sequence_number: 1, request_id: 'req_extension' },
  { type: 'error', error: { code: 'rate_limit_exceeded', param: null, message: 'bad request', request_id: 'req_nested' }, sequence_number: 1 },
] as const)('reassembleOpenAIResponsesEvents preserves standalone errors as the original cause', async error => {
  const body = makeEvents([{ data: error }]);
  const caught: unknown = await reassembleOpenAIResponsesEvents(body).catch((caught: unknown) => caught);

  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ message: 'bad request' });
  expect((caught as Error).cause).toBe(error);
});

test('reassembleOpenAIResponsesEvents drains through response.failed before returning the original error', async () => {
  const failed: OpenAIResponsesResultEx = {
    id: 'resp_failed', object: 'response', model: 'gpt-test', status: 'failed',
    output: [{ type: 'reasoning', id: 'rs_complete', summary: [{ type: 'summary_text', text: 'Work before failure' }] }],
    error: { code: 'rate_limit_exceeded', message: 'Limit reached' },
    incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
  const error = { type: 'error', code: null, param: 'model', message: 'Limit reached', sequence_number: 1 } satisfies OpenAIResponsesStreamEventEx;
  let emittedFailed = false;
  const events = async function* (): AsyncIterable<OpenAIResponsesStreamEventEx> {
    yield { type: 'response.created', sequence_number: 0, response: { ...failed, status: 'in_progress', output: [], error: null, usage: null } };
    yield error;
    emittedFailed = true;
    yield { type: 'response.failed', sequence_number: 2, response: failed };
  };
  const caught: unknown = await reassembleOpenAIResponsesEvents(events()).catch((caught: unknown) => caught);

  expect(emittedFailed).toBe(true);
  expect(caught).toMatchObject({ message: error.message, cause: error });
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
  const closed: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'rs_closed', summary: [] };
  const snapshotOnly: OpenAIResponsesOutputItemEx = {
    type: 'message', id: 'msg_snapshot', status: status === 'completed' ? 'completed' : 'incomplete', role: 'assistant',
    content: [{ type: 'output_text', text: 'Snapshot content', annotations: [] }],
  };
  for (const output of [[], [closed, snapshotOnly]]) {
    const terminal: OpenAIResponsesResultEx = {
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
  const fallbackItem: OpenAIResponsesOutputItemEx = {
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

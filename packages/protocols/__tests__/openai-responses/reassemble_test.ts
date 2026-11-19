import { expect, test } from 'vitest';

import type { OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '../../src/openai-responses/index.ts';
import { reassembleOpenAIResponsesEvents } from '../../src/openai-responses/reassemble.ts';
import { assertRejects } from '@floway-dev/test-utils';

function makeEvents<T = OpenAIResponsesStreamEventEx>(chunks: Array<{ event?: string; data: unknown }>): AsyncIterable<T> {
  return (async function* () {
    for (const chunk of chunks) {
      if (typeof chunk.data === 'string') continue;

      const data = chunk.data as Record<string, unknown>;
      yield (chunk.event && typeof data.type !== 'string' ? { ...data, type: chunk.event } : data) as T;
    }
  })();
}

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

test('reassembleOpenAIResponsesEvents throws when stream ends without terminal event', async () => {
  const body = makeEvents([
    {
      event: 'response.created',
      data: { type: 'response.created', response: {} },
    },
  ]);

  await assertRejects(() => reassembleOpenAIResponsesEvents(body), Error);
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

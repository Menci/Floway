import { test } from 'vitest';

import { collectResponsesProtocolEventsToResult } from './reassemble.ts';
import { assertEquals, assertRejects } from '../../../../../test-assert.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

test('collectResponsesProtocolEventsToResult reassembles synthetic Responses events', async () => {
  const expected: ResponsesResult = {
    id: 'resp_1',
    object: 'response',
    model: 'gpt-test',
    status: 'completed',
    output_text: 'Hello',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello' }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  };

  async function* events() {
    yield* responsesResultToEvents(expected);
  }

  assertEquals(await collectResponsesProtocolEventsToResult(events()), expected);
});

test('collectResponsesProtocolEventsToResult rejects streams without terminal events', async () => {
  async function* events() {
    yield eventFrame({
      type: 'response.created',
      sequence_number: 0,
      response: {
        id: 'resp_truncated',
        object: 'response',
        model: 'gpt-test',
        status: 'in_progress',
        output: [],
      },
    } satisfies ResponsesStreamEvent);
  }

  await assertRejects(async () => await collectResponsesProtocolEventsToResult(events()), Error, 'Responses stream ended without a terminal event.');
});

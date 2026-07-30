import { test } from 'vitest';

import { eventFrame } from '../../src/common/index.ts';
import { responsesResultToEvents, type ResponsesResult, type ResponsesStreamEvent } from '../../src/responses/index.ts';
import { collectResponsesProtocolEventsToResult } from '../../src/responses/to-result.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

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
        id: 'msg_1',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
      },
    ],
    error: null,
    incomplete_details: null,
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
        error: null,
        incomplete_details: null,
      },
    } satisfies ResponsesStreamEvent);
  }

  await assertRejects(async () => await collectResponsesProtocolEventsToResult(events()), Error, 'Responses stream ended without a terminal event.');
});

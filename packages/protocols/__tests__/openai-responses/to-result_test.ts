import { test } from 'vitest';

import { eventFrame } from '../../src/common/index.ts';
import { openaiResponsesResultToEvents, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '../../src/openai-responses/index.ts';
import { collectOpenAIResponsesProtocolEventsToResult } from '../../src/openai-responses/to-result.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('collectOpenAIResponsesProtocolEventsToResult reassembles synthetic OpenAI Responses events', async () => {
  const expected: OpenAIResponsesResult = {
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
    yield* openaiResponsesResultToEvents(expected);
  }

  assertEquals(await collectOpenAIResponsesProtocolEventsToResult(events()), expected);
});

test('collectOpenAIResponsesProtocolEventsToResult rejects streams without terminal events', async () => {
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
    } satisfies OpenAIResponsesStreamEvent);
  }

  await assertRejects(async () => await collectOpenAIResponsesProtocolEventsToResult(events()), Error, 'OpenAI Responses stream ended without a terminal event.');
});

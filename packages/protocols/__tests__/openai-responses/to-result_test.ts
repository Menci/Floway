import { expect, test } from 'vitest';

import { doneFrame, eventFrame } from '../../src/common/index.ts';
import { openaiResponsesResultToEvents, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '../../src/openai-responses/index.ts';
import { collectOpenAIResponsesProtocolEventsToResult } from '../../src/openai-responses/to-result.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('collectOpenAIResponsesProtocolEventsToResult reassembles synthetic OpenAI Responses events', async () => {
  const expected: OpenAIResponsesResultEx = {
    id: 'resp_1',
    object: 'response',
    model: 'gpt-test',
    status: 'completed',
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
    } satisfies OpenAIResponsesStreamEventEx);
  }

  await assertRejects(async () => await collectOpenAIResponsesProtocolEventsToResult(events()), Error, 'OpenAI Responses stream ended without a terminal event.');
});

test('collectOpenAIResponsesProtocolEventsToResult drains response.failed and returns the original error', async () => {
  const failed: OpenAIResponsesResultEx = {
    id: 'resp_failed', object: 'response', model: 'gpt-test', status: 'failed',
    output: [{ type: 'reasoning', id: 'rs_complete', summary: [{ type: 'summary_text', text: 'Work before failure' }] }],
    error: { code: 'rate_limit_exceeded', message: 'Limit reached' },
    incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
  let emittedFailed = false;
  async function* events() {
    yield eventFrame({ type: 'response.created', sequence_number: 0, response: { ...failed, status: 'in_progress', output: [], error: null, usage: null } } satisfies OpenAIResponsesStreamEventEx);
    yield eventFrame({ type: 'error', code: null, param: 'model', message: 'Limit reached', sequence_number: 1 } satisfies OpenAIResponsesStreamEventEx);
    emittedFailed = true;
    yield eventFrame({ type: 'response.failed', sequence_number: 2, response: failed } satisfies OpenAIResponsesStreamEventEx);
    throw new Error('Read beyond the failed response');
  }

  const caught: unknown = await collectOpenAIResponsesProtocolEventsToResult(events()).catch((caught: unknown) => caught);
  expect(emittedFailed).toBe(true);
  expect(caught).toMatchObject({
    message: 'Limit reached',
    cause: { type: 'error', code: null, param: 'model', message: 'Limit reached', sequence_number: 1 },
  });
});

test('collectOpenAIResponsesProtocolEventsToResult preserves an error notification when its stream ends', async () => {
  const error = { type: 'error', code: null, param: 'model', message: 'Limit reached', sequence_number: 1, request_id: 'req_only' } as const;
  async function* events() {
    yield eventFrame(error);
    yield doneFrame();
  }

  await expect(collectOpenAIResponsesProtocolEventsToResult(events())).rejects.toMatchObject({ message: error.message, cause: error });
});

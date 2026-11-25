import { expect, test } from 'vitest';

import { doneFrame, eventFrame } from '../../src/common/index.ts';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '../../src/openai-responses/index.ts';
import { collectOpenAIResponsesProtocolEventsToResult } from '../../src/openai-responses/to-result.ts';

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

  const result = await collectOpenAIResponsesProtocolEventsToResult(events());
  expect(emittedFailed).toBe(true);
  expect(result).toMatchObject({
    ok: false,
    error: {
      type: 'error', cause: {
        message: 'Limit reached',
        cause: { type: 'error', code: null, param: 'model', message: 'Limit reached', sequence_number: 1 },
      },
    },
  });
});

test('collectOpenAIResponsesProtocolEventsToResult preserves an error notification when its stream ends', async () => {
  const error = { type: 'error', code: null, param: 'model', message: 'Limit reached', sequence_number: 1, request_id: 'req_only' } as const;
  async function* events() {
    yield eventFrame(error);
    yield doneFrame();
  }

  expect(await collectOpenAIResponsesProtocolEventsToResult(events())).toMatchObject({
    ok: false, error: { type: 'error', cause: { message: error.message, cause: error } },
  });
});

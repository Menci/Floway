import { expect, test } from 'vitest';

import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import {
  routeOpenAIChatCompletionsViaAnthropicMessages,
  routeOpenAIChatCompletionsViaOpenAIResponses,
  routeOpenAIResponsesViaOpenAIChatCompletions,
} from '@floway-dev/translate';

const options = { sidecarCodec: createTestSidecarCodec('public-boundary') };

test('public translators return ordinary input-failure data before preparing a trip', async () => {
  const failure = await routeOpenAIChatCompletionsViaOpenAIResponses({
    model: 'source-model', stream: true, messages: [],
    response_format: { type: 'json_schema', json_schema: { name: 'shape' } },
  }, options);
  expect(failure).toEqual({ type: 'input-error', message: expect.stringContaining('without a schema') });
  expect(Object.getPrototypeOf(failure)).toBe(Object.prototype);

  const canonicalFailure = await routeOpenAIResponsesViaOpenAIChatCompletions({ model: '', input: [] }, options);
  expect(canonicalFailure).toEqual({
    type: 'input-error', message: "Missing required parameter: 'model'.", param: 'model', code: 'missing_required_parameter',
  });
});

test('public operations preserve unexpected errors and their causes', async () => {
  const cause = new Error('transport');
  const failure = new Error('request read', { cause });
  await expect(routeOpenAIChatCompletionsViaAnthropicMessages({
    model: 'source-model', get messages(): never { throw failure; },
  }, { ...options, fallbackMaxOutputTokens: 32 })).rejects.toBe(failure);

  expect(failure.cause).toBe(cause);
});

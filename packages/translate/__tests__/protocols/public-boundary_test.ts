import { expect, test } from 'vitest';

import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import {
  canonicalizeOpenAIResponsesPayload,
  routeGeminiGenerateContentViaOpenAIChatCompletions,
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

  expect(() => canonicalizeOpenAIResponsesPayload({ get model() { throw failure; } })).toThrow(failure);
  expect(failure.cause).toBe(cause);
});

test('Messages translation preserves URL media in its native request', async () => {
  const trip = await routeOpenAIChatCompletionsViaAnthropicMessages({
    model: 'source-model', stream: true, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }],
  }, {
    ...options, fallbackMaxOutputTokens: 32,
  });
  expect(trip.type).toBe('trip');
  if (trip.type !== 'trip') throw new Error(trip.message);
  expect(trip.target.messages[0].content).toEqual([{ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' }, cache_control: { type: 'ephemeral' } }]);
  expect(trip.target.max_tokens).toBe(32);
  expect(trip.error(418, new Headers(), new Uint8Array())).toBeUndefined();
});

test('Gemini translation retains the model in the formal source request', async () => {
  const trip = await routeGeminiGenerateContentViaOpenAIChatCompletions({ model: 'resolved-model', contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }, options);
  expect(trip.type).toBe('trip');
  if (trip.type !== 'trip') throw new Error(trip.message);
  expect(trip.target.model).toBe('resolved-model');
});

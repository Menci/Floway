import { expect, test } from 'vitest';

import {
  routeOpenAIChatCompletionsViaAnthropicMessages,
  routeOpenAIChatCompletionsViaOpenAIResponses,
  routeOpenAIResponsesViaOpenAIChatCompletions,
} from '../../../src/index.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';

const options = { sidecarCodec: createTestSidecarCodec(), fallbackMaxOutputTokens: 16 };

test.each([
  'data:image/png;charset=utf-8;base64,AAAA',
  'data:image/svg+xml,%3Csvg%2F%3E',
])('image URL %s remains exact between OpenAI request protocols', async url => {
  const responses = await routeOpenAIChatCompletionsViaOpenAIResponses({
    model: 'm', stream: true, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
  }, options);
  if (responses.type !== 'trip') throw new Error(responses.message);
  expect(responses.target.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: url }] }]);

  const chat = await routeOpenAIResponsesViaOpenAIChatCompletions({
    model: 'm', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: url }] }],
  }, options);
  if (chat.type !== 'trip') throw new Error(chat.message);
  expect(chat.target.messages).toEqual([{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }]);
});

test('raw file_data remains exact between OpenAI request protocols', async () => {
  const data = 'JVBERi0xLjQ=';
  const responses = await routeOpenAIChatCompletionsViaOpenAIResponses({
    model: 'm', stream: true, messages: [{ role: 'user', content: [{ type: 'file', file: { file_data: data } }] }],
  }, options);
  if (responses.type !== 'trip') throw new Error(responses.message);
  expect(responses.target.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_file', file_data: data }] }]);

  const chat = await routeOpenAIResponsesViaOpenAIChatCompletions({
    model: 'm', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_data: data }] }],
  }, options);
  if (chat.type !== 'trip') throw new Error(chat.message);
  expect(chat.target.messages).toEqual([{ role: 'user', content: [{ type: 'file', file: { file_data: data } }] }]);
});

test('Messages decodes a data URL only at its target boundary', async () => {
  const result = await routeOpenAIChatCompletionsViaAnthropicMessages({
    model: 'm', stream: true, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;charset=utf-8;base64,AAAA' } }] }],
  }, options);
  if (result.type !== 'trip') throw new Error(result.message);
  expect(result.target.messages).toEqual([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png;charset=utf-8', data: 'AAAA' }, cache_control: { type: 'ephemeral' } }] }]);
});

test.each([
  ['data:;charset=utf-8,hi', 'text/plain;charset=utf-8', 'aGk='],
  ['data:text/plain;base64,SGk%3D', 'text/plain', 'SGk='],
] as const)('Messages decodes target-boundary data URL %s', async (url, mediaType, data) => {
  const result = await routeOpenAIChatCompletionsViaAnthropicMessages({
    model: 'm', stream: true, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
  }, options);
  if (result.type !== 'trip') throw new Error(result.message);
  expect(result.target.messages).toEqual([{
    role: 'user',
    content: [{
      type: 'image', source: { type: 'base64', media_type: mediaType, data }, cache_control: { type: 'ephemeral' },
    }],
  }]);
});

import { expect, test } from 'vitest';

import { createTestSidecarCodec } from './round-trip/sidecar-codec.ts';
import { createOpenAIChatCompletionsSidecarDetails } from '../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
import * as translate from '@floway-dev/translate';

const options = { sidecarCodec: createTestSidecarCodec() };
const messages = {
  model: 'm', stream: true, max_tokens: 32,
  messages: [{
    role: 'user' as const,
    content: [{
      type: 'document' as const,
      source: {
        type: 'content' as const,
        content: [{ type: 'text' as const, text: 'caption' }, { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } }],
      },
    }],
  }],
};
const chat = {
  model: 'm', stream: true,
  messages: [{ role: 'user' as const, content: [{ type: 'input_audio' as const, input_audio: { format: 'wav' as const, data: 'AAAA' } }] }],
};
const responses = { model: 'm', stream: true, input: [{ type: 'item_reference' as const, id: 'opaque' }] };
const gemini = {
  model: 'm', contents: [{ role: 'user' as const, parts: [{ fileData: { mimeType: 'application/pdf', fileUri: 'https://example.com/a.pdf' } }] }],
};

const routes = [
  () => translate.routeAnthropicMessagesViaOpenAIChatCompletions(messages, options),
  () => translate.routeAnthropicMessagesViaOpenAIResponses(messages, options),
  () => translate.routeOpenAIChatCompletionsViaAnthropicMessages(chat, options),
  () => translate.routeOpenAIChatCompletionsViaOpenAIResponses(chat, options),
  () => translate.routeOpenAIResponsesViaAnthropicMessages(responses, options),
  () => translate.routeOpenAIResponsesViaOpenAIChatCompletions(responses, options),
  () => translate.routeGeminiGenerateContentViaAnthropicMessages(gemini, options),
  () => translate.routeGeminiGenerateContentViaOpenAIChatCompletions(gemini, options),
  () => translate.routeGeminiGenerateContentViaOpenAIResponses(gemini, options),
];

test.each(routes.map((run, index) => ({ index, run })))('route $index returns an ordinary input error object', async ({ run }) => {
  const result = await run();
  expect(result.type).toBe('input-error');
  expect(result).not.toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  if (result.type !== 'input-error') throw new Error('Expected an input failure');
  expect(result.message.length).toBeGreaterThan(0);
});

test('an unexpected codec failure retains its original error and cause', async () => {
  const cause = new Error('codec cause');
  const failure = new Error('codec failure', { cause });
  const codec = { ...createTestSidecarCodec(), decode: async (): Promise<unknown> => { throw failure; } };
  const turn: OpenAIChatCompletionsAssistantMessageEx = {
    role: 'assistant', content: 'history', reasoning_details: createOpenAIChatCompletionsSidecarDetails('sidecar'),
  };
  await expect(translate.routeOpenAIChatCompletionsViaAnthropicMessages({ model: 'm', stream: true, messages: [turn] }, { sidecarCodec: codec })).rejects.toBe(failure);
});

import { expect, test } from 'vitest';

import { toOpenAIChatCompletionsInputAssistantMessage } from '../../src/openai-chat-completions/index.ts';

test('native Chat history retains residual fields and only replays audio identity', () => {
  const details = [{ type: 'reasoning.summary' as const, summary: 'native' }];
  const output = { role: 'assistant' as const, content: 'answer', refusal: null, audio: { id: 'a', data: 'bytes', expires_at: 4, transcript: 'text' }, reasoning_details: details };
  const input = toOpenAIChatCompletionsInputAssistantMessage(output);
  expect(input).toEqual({ role: 'assistant', content: 'answer', refusal: null, audio: { id: 'a' }, reasoning_details: details });
  expect(input.reasoning_details).toBe(details);
  expect(output.audio.data).toBe('bytes');
});

test('native Chat history distinguishes absent, null and explicitly undefined audio', () => {
  expect(toOpenAIChatCompletionsInputAssistantMessage({ role: 'assistant', content: null, refusal: null })).not.toHaveProperty('audio');
  expect(toOpenAIChatCompletionsInputAssistantMessage({ role: 'assistant', content: null, refusal: null, audio: null })).toHaveProperty('audio', null);
  expect(toOpenAIChatCompletionsInputAssistantMessage({ role: 'assistant', content: null, refusal: null, audio: undefined })).toHaveProperty('audio', undefined);
});

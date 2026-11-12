import { expect, test } from 'vitest';

import { toOpenAIChatCompletionsInputAssistantTurn } from '../../../../src/protocols/openai-chat-completions/as-target/assistant-turn.ts';
import { createReadFieldState } from '../../../../src/round-trip/reference/reference-builder.ts';
import type { OpenAIChatCompletionsAssistantOutputMessageEx } from '@floway-dev/protocols/openai-chat-completions';

test('keeps native Chat fields and reference state while reducing audio to its input identity', () => {
  const output: OpenAIChatCompletionsAssistantOutputMessageEx = {
    role: 'assistant', content: 'answer', refusal: null,
    audio: { id: 'audio-a', data: 'bytes', expires_at: 4, transcript: 'text' },
    reasoning_details: [{ type: 'reasoning.summary', summary: 'native summary' }],
    provider_specific_fields: { native: true },
  };
  const before = structuredClone(output);
  const content = createReadFieldState('text');
  const state = { content };
  const input = toOpenAIChatCompletionsInputAssistantTurn(output, state);

  expect(input.turn).toEqual({ ...output, audio: { id: 'audio-a' } });
  expect(input.turn.provider_specific_fields).toBe(output.provider_specific_fields);
  expect(input.turn.reasoning_details).toBe(output.reasoning_details);
  expect(input.state).not.toBe(state);
  expect(input.state.content).toBe(content);
  expect(output).toEqual(before);
});

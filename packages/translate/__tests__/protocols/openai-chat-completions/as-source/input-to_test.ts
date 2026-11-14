import { expect, test } from 'vitest';

import { readOpenAIChatCompletionsRequest } from '../../../../src/protocols/openai-chat-completions/as-source/input-to.ts';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';

test('empty reasoning extensions do not enter input IR', () => {
  const message: OpenAIChatCompletionsAssistantMessageEx = {
    role: 'assistant', content: 'answer',
    reasoning: '', reasoning_text: '', reasoning_content: '',
    reasoning_details: [{ type: 'reasoning.summary', summary: '', format: 'unknown', index: 0 }],
  };
  const reading = readOpenAIChatCompletionsRequest({ model: 'm', stream: true, messages: [message] });
  expect(reading.turns[0].toIRInputTurns()).toEqual([{
    kind: 'assistant', items: [{ type: 'message', content: [{ type: 'text', text: 'answer' }] }],
  }]);
});

import { expect, test, vi } from 'vitest';

import { scalarToOpenAIResponsesReasoningItem, translateOpenAIChatCompletionsReasoningItems } from '../../../../src/protocols/openai-chat-completions/via-openai-responses/reasoning.ts';
import type { OpenAIResponsesInputReasoning } from '@floway-dev/protocols/openai-responses';

test('reasoning fallback IDs are generated only when an item needs one', () => {
  const random = vi.spyOn(crypto, 'getRandomValues');

  expect(scalarToOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>(undefined)).toBeNull();
  expect(translateOpenAIChatCompletionsReasoningItems<OpenAIResponsesInputReasoning>([{
    type: 'reasoning',
    id: 'rs_existing',
    summary: [{ type: 'summary_text', text: 'trace' }],
  }])![0].id).toBe('rs_existing');
  expect(random).not.toHaveBeenCalled();

  expect(translateOpenAIChatCompletionsReasoningItems<OpenAIResponsesInputReasoning>([{
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'trace' }],
  }])![0].id).toMatch(/^rs_[0-9a-f]{32}$/);
  expect(random).toHaveBeenCalledOnce();
});

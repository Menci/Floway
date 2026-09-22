import { expect, test, vi } from 'vitest';

import { scalarToOpenAIResponsesReasoningItem, toOpenAIResponsesReasoningItem } from '../../../src/shared/openai-chat-completions-and-openai-responses/reasoning.ts';
import type { OpenAIResponsesInputReasoning } from '@floway-dev/protocols/openai-responses';

test('reasoning fallback IDs are generated only when an item needs one', () => {
  const random = vi.spyOn(crypto, 'getRandomValues');

  expect(scalarToOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>(undefined)).toBeNull();
  expect(toOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>({
    type: 'reasoning',
    id: 'rs_existing',
    summary: [{ type: 'summary_text', text: 'trace' }],
  }).id).toBe('rs_existing');
  expect(random).not.toHaveBeenCalled();

  expect(toOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'trace' }],
  }).id).toMatch(/^rs_[0-9a-f]{32}$/);
  expect(random).toHaveBeenCalledOnce();
});

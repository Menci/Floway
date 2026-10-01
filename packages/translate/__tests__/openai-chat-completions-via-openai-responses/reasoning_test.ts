import { expect, test, vi } from 'vitest';

import { scalarToOpenAIResponsesReasoningItem, toOpenAIResponsesReasoningItem, openAIChatCompletionsReasoningItems, translateOpenAIChatCompletionsReasoningItems } from '../../src/openai-chat-completions-via-openai-responses/reasoning.ts';
import { flowayReasoningFields, encodeChatCompletionsReasoningData } from '@floway-dev/protocols/openai-chat-completions';
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

test('native Responses replay cannot fabricate an ID for malformed signed history', () => {
  const message = flowayReasoningFields('', encodeChatCompletionsReasoningData('openai-responses-reasoning-items', [{ type: 'reasoning', summary: [], encrypted_content: 'signed' }]));
  expect(() => openAIChatCompletionsReasoningItems(message)).toThrow('Malformed Floway Responses reasoning items');
});

test('native reasoning items with empty summaries retain their IDs during history replay', () => {
  const items = [{ type: 'reasoning' as const, id: 'rs_empty', summary: [] }];
  expect(translateOpenAIChatCompletionsReasoningItems(items)).toEqual(items);
  expect(translateOpenAIChatCompletionsReasoningItems([])).toEqual([]);
});

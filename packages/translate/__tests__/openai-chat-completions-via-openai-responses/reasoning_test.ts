import { afterEach, expect, test, vi } from 'vitest';

import { chatCompletionsReasoningItemFromResponses, openAIChatCompletionsReasoningItems } from '../../src/openai-chat-completions-via-openai-responses/reasoning.ts';
import { flowayReasoningFields, encodeChatCompletionsReasoningData } from '@floway-dev/protocols/openai-chat-completions';

afterEach(() => vi.restoreAllMocks());

const item = { type: 'reasoning' as const, id: 'rs_existing', summary: [{ type: 'summary_text' as const, text: 'trace' }], encrypted_content: 'signed' };

test('Responses sidecars use LiteLLM field projection and replay stored IDs without scalar text', () => {
  const native = { ...item, future: 'not in the LiteLLM standard', status: 'completed' as const };
  expect(chatCompletionsReasoningItemFromResponses(native)).toEqual(item);
  const message = flowayReasoningFields('edited scalar trace', encodeChatCompletionsReasoningData('litellm-reasoning-items', [item]));
  const restored = openAIChatCompletionsReasoningItems(message);
  expect(restored).toEqual([item]);
  restored[0].summary[0].text = 'changed';
  expect(openAIChatCompletionsReasoningItems(message)).toEqual([item]);
});

test('Responses ID-only items keep their IDs and empty summaries', () => {
  const empty = { type: 'reasoning' as const, id: 'rs_empty', summary: [] };
  expect(chatCompletionsReasoningItemFromResponses(empty)).toEqual({ ...empty, encrypted_content: null });
  expect(openAIChatCompletionsReasoningItems(flowayReasoningFields('ignored', encodeChatCompletionsReasoningData('litellm-reasoning-items', [empty])))).toEqual([empty]);
  expect(openAIChatCompletionsReasoningItems(flowayReasoningFields('ignored', encodeChatCompletionsReasoningData('litellm-reasoning-items', [])))).toEqual([]);
});

test.each(['openrouter-reasoning-details', 'litellm-thinking-blocks'] as const)('Responses warns and ignores recognized %s history', standard => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(openAIChatCompletionsReasoningItems(flowayReasoningFields('ignored', encodeChatCompletionsReasoningData(standard, [null])))).toEqual([]);
  expect(warn).toHaveBeenCalledExactlyOnceWith('Floway ignored Chat Completions reasoning data for Responses:', { expected: 'litellm-reasoning-items', received: standard });
});

test.each([
  { items: [null] },
  { items: [{ type: 'reasoning', summary: [], encrypted_content: 'signed' }] },
  { items: [{ ...item, summary: [{ type: 'unknown', text: 'trace' }] }] },
  { items: [{ ...item, encrypted_content: 1 }] },
])('Responses rejects malformed matching sidecar $items', ({ items }) => {
  expect(() => openAIChatCompletionsReasoningItems(flowayReasoningFields('', encodeChatCompletionsReasoningData('litellm-reasoning-items', items)))).toThrow('Malformed LiteLLM reasoning items');
});

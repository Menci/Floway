import { expect, test, vi } from 'vitest';

import { scalarToOpenAIResponsesReasoningItem, toOpenAIResponsesInputReasoningItem, toOpenAIResponsesOutputReasoningItem } from '../../../src/shared/openai-chat-completions-and-openai-responses/reasoning.ts';

test('synthesis never mints a reasoning id and an upstream-issued id rides verbatim', () => {
  const random = vi.spyOn(crypto, 'getRandomValues');

  expect(scalarToOpenAIResponsesReasoningItem(undefined)).toBeNull();

  expect(toOpenAIResponsesInputReasoningItem({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'trace' }],
  })).toEqual({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
  expect(scalarToOpenAIResponsesReasoningItem('trace')).toEqual({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
  expect(random).not.toHaveBeenCalled();

  expect(toOpenAIResponsesInputReasoningItem({
    type: 'reasoning',
    id: 'rs_existing',
    summary: [{ type: 'summary_text', text: 'trace' }],
  }).id).toBe('rs_existing');
});

test('output reasoning has a required ID without inventing input IDs', () => {
  const source = { type: 'reasoning' as const, summary: [{ type: 'summary_text' as const, text: 'trace' }] };
  const output = toOpenAIResponsesOutputReasoningItem(source);
  expect(output.id).toMatch(/^rs_/);
  expect(output.summary).toEqual(source.summary);
  expect(toOpenAIResponsesOutputReasoningItem({ ...source, id: 'rs_existing' }).id).toBe('rs_existing');
  expect(toOpenAIResponsesInputReasoningItem(source)).not.toHaveProperty('id');
});

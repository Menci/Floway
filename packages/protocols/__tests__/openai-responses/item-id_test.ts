import { expect, test } from 'vitest';

import { createRandomOpenAIResponsesItemId, type GeneratedOpenAIResponsesItemType } from '../../src/openai-responses/item-id.ts';

test('creates unique ids with the canonical prefix', () => {
  const first = createRandomOpenAIResponsesItemId('function_call');
  expect(first).toMatch(/^fc_[0-9a-f]{32}$/);
  expect(createRandomOpenAIResponsesItemId('function_call')).not.toBe(first);
});

test('rejects an inherited property name as a runtime item type', () => {
  expect(() => createRandomOpenAIResponsesItemId('__proto__' as GeneratedOpenAIResponsesItemType))
    .toThrow('Unknown generated OpenAI Responses item type: __proto__');
});

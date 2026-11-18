import { expect, test } from 'vitest';

import { createRandomOpenAIResponsesItemId, type GeneratedOpenAIResponsesItemType } from '../../src/openai-responses/item-id.ts';

test('rejects an inherited property name as a runtime item type', () => {
  expect(() => createRandomOpenAIResponsesItemId('__proto__' as GeneratedOpenAIResponsesItemType))
    .toThrow('Unknown generated OpenAI Responses item type: __proto__');
});

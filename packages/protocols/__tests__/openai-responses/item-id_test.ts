import { expect, test } from 'vitest';

import { createRandomOpenAIResponsesItemId, type GeneratedOpenAIResponsesItemType } from '../../src/openai-responses/item-id.ts';

const expectedPrefixes = {
  message: 'msg',
  reasoning: 'rs',
  web_search_call: 'ws',
  function_call: 'fc',
  custom_tool_call: 'ctc',
  compaction: 'cmp',
  image_generation_call: 'ig',
} as const satisfies Record<GeneratedOpenAIResponsesItemType, string>;

test.each(Object.entries(expectedPrefixes))('creates unique %s ids with the canonical prefix', (type, prefix) => {
  const first = createRandomOpenAIResponsesItemId(type as GeneratedOpenAIResponsesItemType);
  const second = createRandomOpenAIResponsesItemId(type as GeneratedOpenAIResponsesItemType);

  expect(first).toMatch(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
  expect(second).toMatch(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
  expect(first).not.toBe(second);
});

test.each(['unknown', '__proto__', 'constructor', 'toString'])('rejects unsupported runtime item type %s', type => {
  expect(() => createRandomOpenAIResponsesItemId(type as GeneratedOpenAIResponsesItemType))
    .toThrow(`Unknown generated OpenAI Responses item type: ${type}`);
});

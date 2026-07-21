import { expect, test } from 'vitest';

import { createRandomResponsesItemId, type GeneratedResponsesItemType } from './item-id.ts';

const expectedPrefixes = {
  message: 'msg',
  reasoning: 'rs',
  web_search_call: 'ws',
  function_call: 'fc',
  custom_tool_call: 'ctc',
  compaction: 'cmp',
  image_generation_call: 'ig',
} as const satisfies Record<GeneratedResponsesItemType, string>;

test.each(Object.entries(expectedPrefixes))('creates unique %s ids with the canonical prefix', (type, prefix) => {
  const first = createRandomResponsesItemId(type as GeneratedResponsesItemType);
  const second = createRandomResponsesItemId(type as GeneratedResponsesItemType);

  expect(first).toMatch(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
  expect(second).toMatch(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
  expect(first).not.toBe(second);
});

test.each(['unknown', '__proto__', 'constructor', 'toString'])('rejects unsupported runtime item type %s', type => {
  expect(() => createRandomResponsesItemId(type as GeneratedResponsesItemType))
    .toThrow(`Unknown generated Responses item type: ${type}`);
});

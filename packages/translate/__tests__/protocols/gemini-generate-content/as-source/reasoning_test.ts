import { test } from 'vitest';

import { geminiGenerateContentThinkingLevelEffort } from '../../../../src/protocols/gemini-generate-content/as-source/reasoning.ts';
import { assertEquals } from '@floway-dev/test-utils';

test.each([
  ['LOW', 'low'],
  ['MEDIUM', 'medium'],
  ['HIGH', 'high'],
  ['MINIMAL', 'minimal'],
  ['THINKING_LEVEL_UNSPECIFIED', undefined],
  ['', ''],
  ['VENDOR_Turbo', 'VENDOR_Turbo'],
  ['Low', 'Low'],
] as const)('thinkingLevel %s maps to effort %s', (thinkingLevel, effort) => {
  assertEquals(geminiGenerateContentThinkingLevelEffort({ thinkingLevel }), effort);
});

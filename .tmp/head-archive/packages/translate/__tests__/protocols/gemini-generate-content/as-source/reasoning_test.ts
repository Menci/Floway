import { test } from 'vitest';

import { geminiGenerateContentThinkingLevelEffort } from '../../../../src/protocols/gemini-generate-content/as-source/reasoning.ts';
import { reasoningEffortForBudget } from '../../../../src/shared/reasoning-budget.ts';
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

test.each([
  [0, 'none'],
  [1, 'low'],
  [2048, 'low'],
  [2049, 'medium'],
  [8192, 'medium'],
  [8193, 'high'],
] as const)('budget %i approximates effort %s on a target without a budget slot', (budget, effort) => {
  assertEquals(reasoningEffortForBudget(budget), effort);
});

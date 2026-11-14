import { test } from 'vitest';

import { reasoningEffortForBudget } from '../../src/shared/reasoning-budget.ts';
import { assertEquals } from '@floway-dev/test-utils';

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

import { expect, test } from 'vitest';

import { formatAliasRuleBadges } from '../../src/common/aliases.ts';

test('returns one badge per configured part in the canonical order with explicit field keys', () => {
  expect(formatAliasRuleBadges({
    verbosity: 'medium',
    reasoning: { effort: 'high', budget_tokens: 2048 },
  })).toEqual([
    { field: 'reasoning.effort', label: 'high effort', value: 'high' },
    { field: 'reasoning.budget_tokens', label: '2048tok budget', value: 2048 },
    { field: 'verbosity', label: 'medium verbosity', value: 'medium' },
  ]);
});

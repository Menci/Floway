import { describe, expect, test } from 'vitest';

import { formatAliasRuleBadges, formatAliasRulesInline } from '../../src/common/aliases.ts';

describe('formatAliasRulesInline', () => {

  test('joins configured parts in the canonical order', () => {
    expect(formatAliasRulesInline({
      reasoning: { effort: 'high' },
      verbosity: 'low',
      serviceTier: 'priority',
    })).toBe('high effort, low verbosity, priority tier');
  });

  test('renders boolean reasoning toggles in their dedicated wording', () => {
    expect(formatAliasRulesInline({
      reasoning: { adaptive: false, summary: 'concise' },
    })).toBe('non-adaptive, summary: concise');
  });
});

describe('formatAliasRuleBadges', () => {
  test('returns one badge per configured part in the canonical order with explicit field keys', () => {
    expect(formatAliasRuleBadges({
      reasoning: { effort: 'high', budget_tokens: 2048 },
      verbosity: 'medium',
    })).toEqual([
      { field: 'reasoning.effort', label: 'high effort', value: 'high' },
      { field: 'reasoning.budget_tokens', label: '2048tok budget', value: 2048 },
      { field: 'verbosity', label: 'medium verbosity', value: 'medium' },
    ]);
  });
});

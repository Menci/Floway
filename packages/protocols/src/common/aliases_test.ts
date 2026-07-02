import { describe, expect, test } from 'vitest';

import { composeAliasDisplayName, formatAliasRuleBadges, formatAliasRulesInline } from './aliases.ts';

describe('composeAliasDisplayName', () => {
  test('bare target id when no rules apply', () => {
    expect(composeAliasDisplayName('gpt-5.4', {})).toBe('gpt-5.4');
  });

  test('parenthesizes the inline summary when a rule is set', () => {
    expect(composeAliasDisplayName('gpt-5.4', { reasoning: { effort: 'low' } })).toBe('gpt-5.4 (low effort)');
  });
});

describe('formatAliasRulesInline', () => {
  test('returns empty string when no rule is set', () => {
    expect(formatAliasRulesInline({})).toBe('');
  });

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

  test('emits adaptive when reasoning.adaptive is true and budget_tokens when set', () => {
    expect(formatAliasRulesInline({
      reasoning: { budget_tokens: 4096, adaptive: true },
    })).toBe('4096tok budget, adaptive');
  });
});

describe('formatAliasRuleBadges', () => {
  test('returns one badge per configured part in the canonical order with explicit field keys', () => {
    expect(formatAliasRuleBadges({
      reasoning: { effort: 'high', budget_tokens: 2048 },
      verbosity: 'medium',
    })).toEqual([
      { field: 'reasoning.effort', label: 'high effort' },
      { field: 'reasoning.budget_tokens', label: '2048tok budget' },
      { field: 'verbosity', label: 'medium verbosity' },
    ]);
  });

  test('returns an empty array when no rule is set', () => {
    expect(formatAliasRuleBadges({})).toEqual([]);
  });
});

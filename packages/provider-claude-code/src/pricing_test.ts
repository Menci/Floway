import { describe, expect, test } from 'vitest';

import { pricingForClaudeCodeModelKey } from './pricing.ts';

describe('pricingForClaudeCodeModelKey', () => {
  test('returns the documented per-million-token rates for 4.5-generation dated ids', () => {
    expect(pricingForClaudeCodeModelKey('claude-sonnet-4-5-20250929')).toEqual({
      input: 3,
      input_cache_read: 0.3,
      input_cache_write: 3.75,
      input_cache_write_1h: 6,
      output: 15,
    });
    expect(pricingForClaudeCodeModelKey('claude-opus-4-5-20251101')).toEqual({
      input: 5,
      input_cache_read: 0.5,
      input_cache_write: 6.25,
      input_cache_write_1h: 10,
      output: 25,
    });
    expect(pricingForClaudeCodeModelKey('claude-haiku-4-5-20251001')).toEqual({
      input: 1,
      input_cache_read: 0.1,
      input_cache_write: 1.25,
      input_cache_write_1h: 2,
      output: 5,
    });
  });

  test('returns the documented per-million-token rates for 4.6+ generation aliases with fast-mode override', () => {
    expect(pricingForClaudeCodeModelKey('claude-opus-4-8')).toEqual({
      input: 5,
      input_cache_read: 0.5,
      input_cache_write: 6.25,
      input_cache_write_1h: 10,
      output: 25,
      tiers: { fast: { input: 10, input_cache_read: 1, input_cache_write: 12.5, input_cache_write_1h: 20, output: 50 } },
    });
    expect(pricingForClaudeCodeModelKey('claude-opus-4-7')).toEqual({
      input: 5,
      input_cache_read: 0.5,
      input_cache_write: 6.25,
      input_cache_write_1h: 10,
      output: 25,
      tiers: { fast: { input: 30, input_cache_read: 3, input_cache_write: 37.5, input_cache_write_1h: 60, output: 150 } },
    });
    expect(pricingForClaudeCodeModelKey('claude-opus-4-6')).toEqual({
      input: 5,
      input_cache_read: 0.5,
      input_cache_write: 6.25,
      input_cache_write_1h: 10,
      output: 25,
      tiers: { fast: { input: 30, input_cache_read: 3, input_cache_write: 37.5, input_cache_write_1h: 60, output: 150 } },
    });
    expect(pricingForClaudeCodeModelKey('claude-sonnet-4-6')).toEqual({
      input: 3,
      input_cache_read: 0.3,
      input_cache_write: 3.75,
      input_cache_write_1h: 6,
      output: 15,
    });
  });

  test('returns the introductory rates for claude-sonnet-5 (in effect through 2026-08-31)', () => {
    expect(pricingForClaudeCodeModelKey('claude-sonnet-5')).toEqual({
      input: 2,
      input_cache_read: 0.2,
      input_cache_write: 2.5,
      input_cache_write_1h: 4,
      output: 10,
    });
  });

  test('returns the documented rates for claude-fable-5 (premium tier, no fast mode)', () => {
    expect(pricingForClaudeCodeModelKey('claude-fable-5')).toEqual({
      input: 10,
      input_cache_read: 1,
      input_cache_write: 12.5,
      input_cache_write_1h: 20,
      output: 50,
    });
  });

  test('returns the legacy Opus tier for claude-opus-4-1 (deprecated but still served)', () => {
    expect(pricingForClaudeCodeModelKey('claude-opus-4-1-20250805')).toEqual({
      input: 15,
      input_cache_read: 1.5,
      input_cache_write: 18.75,
      input_cache_write_1h: 30,
      output: 75,
    });
  });

  test('returns null for unknown / future ids (forward-compat)', () => {
    expect(pricingForClaudeCodeModelKey('claude-sonnet-5-0-20270101')).toBeNull();
  });

  test('returns null for the 4.5-generation bare alias — only the dated key carries pricing', () => {
    expect(pricingForClaudeCodeModelKey('claude-sonnet-4-5')).toBeNull();
  });
});

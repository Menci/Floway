import { describe, expect, test } from 'vitest';

import { pricingForCursorModelKey } from './pricing.ts';

describe('pricingForCursorModelKey', () => {
  test('prices the current Claude lineup by family (Cursor API-pool rates)', () => {
    // Every Opus 4.5+ shares $5 in / $25 out, every Sonnet $3 / $15.
    expect(pricingForCursorModelKey('claude-opus-4-8')).toMatchObject({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 });
    expect(pricingForCursorModelKey('claude-opus-4-5')?.output).toBe(25);
    expect(pricingForCursorModelKey('claude-sonnet-5')).toMatchObject({ input: 3, input_cache_write: 3.75, output: 15 });
    expect(pricingForCursorModelKey('claude-sonnet-4-6')?.input).toBe(3);
    expect(pricingForCursorModelKey('claude-fable-5')?.output).toBe(50);
  });

  test('prices composer-2.5 with Cursor\'s own composer rate', () => {
    expect(pricingForCursorModelKey('composer-2.5')).toMatchObject({ input: 0.5, input_cache_read: 0.2, output: 2.5 });
  });

  test('resolves GPT-5 variants to their distinct rates, specific before base', () => {
    expect(pricingForCursorModelKey('gpt-5.5')?.output).toBe(30);
    expect(pricingForCursorModelKey('gpt-5.4')?.input).toBe(2.5);
    expect(pricingForCursorModelKey('gpt-5.4-mini')?.input).toBe(0.75);
    expect(pricingForCursorModelKey('gpt-5.4-nano')?.input).toBe(0.2);
    expect(pricingForCursorModelKey('gpt-5.3-codex')?.input).toBe(1.75);
    expect(pricingForCursorModelKey('gpt-5.2')?.output).toBe(14);
    expect(pricingForCursorModelKey('gpt-5.1-codex-max')?.input).toBe(1.25);
    expect(pricingForCursorModelKey('gpt-5.1-codex-mini')?.input).toBe(0.25);
    expect(pricingForCursorModelKey('gpt-5-mini')?.input).toBe(0.25);
  });

  test('prices the Auto pool', () => {
    expect(pricingForCursorModelKey('auto')).toMatchObject({ input: 1.25, input_cache_read: 0.25, output: 6 });
  });

  test('returns null for an unknown model', () => {
    expect(pricingForCursorModelKey('some-unknown-model')).toBeNull();
  });
});

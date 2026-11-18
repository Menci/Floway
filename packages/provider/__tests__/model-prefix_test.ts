import { describe, expect, it } from 'vitest';

import { MODEL_PREFIX_REGEX, normalizeModelPrefix } from '../src/model-prefix.ts';

describe('MODEL_PREFIX_REGEX', () => {
  it('accepts a multi-segment prefix', () => expect(MODEL_PREFIX_REGEX.test('vendor/sub/')).toBe(true));

  it.each([
    ['openrouter'],          // missing trailing slash
    ['a//b/'],               // empty interior segment
  ])('rejects %j', input => expect(MODEL_PREFIX_REGEX.test(input)).toBe(false));
});

describe('normalizeModelPrefix', () => {
  it('throws when listed contains a form not in addressable', () => {
    expect(() => normalizeModelPrefix({
      prefix: 'or/',
      addressable: ['unprefixed'],
      listed: ['unprefixed', 'prefixed'],
    })).toThrow(/listed entry 'prefixed' is not in.*addressable/);
  });
});

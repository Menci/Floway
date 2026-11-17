import { describe, expect, it } from 'vitest';

import { MODEL_PREFIX_REGEX, normalizeModelPrefix } from '../src/model-prefix.ts';

describe('MODEL_PREFIX_REGEX', () => {
  it.each([
    ['openrouter/'],
    ['vendor/sub/'],
  ])('accepts %j', input => expect(MODEL_PREFIX_REGEX.test(input)).toBe(true));

  it.each([
    ['openrouter'],          // missing trailing slash
    ['/vendor/'],            // leading slash
    ['a//b/'],               // empty interior segment
    ['my prefix/'],          // space
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

  it('throws on unknown addressable form (no silent drop)', () => {
    expect(() => normalizeModelPrefix({ prefix: 'or/', addressable: ['unprefixed', 'bogus'], listed: [] }))
      .toThrow(/addressable.*'unprefixed' or 'prefixed'/);
  });
});

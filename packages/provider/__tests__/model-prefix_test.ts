import { describe, expect, it } from 'vitest';

import { MODEL_PREFIX_REGEX, normalizeModelPrefix } from '../src/model-prefix.ts';

describe('MODEL_PREFIX_REGEX', () => {
  it.each([
    ['a/'],
    ['openrouter/'],
    ['vendor/sub/'],
    ['v1.0/'],
    ['a_b-c/'],
  ])('accepts %j', input => expect(MODEL_PREFIX_REGEX.test(input)).toBe(true));

  it.each([
    ['openrouter'],          // missing trailing slash
    ['/'],                   // too short
    ['/vendor/'],            // leading slash
    ['vendor//'],            // empty trailing segment
    ['a//b/'],               // empty interior segment
    ['my prefix/'],          // space
    ['vendor:/'],            // colon
    [''],                    // empty
  ])('rejects %j', input => expect(MODEL_PREFIX_REGEX.test(input)).toBe(false));
});

describe('normalizeModelPrefix', () => {
  it('returns null for null/undefined', () => {
    expect(normalizeModelPrefix(null)).toBeNull();
    expect(normalizeModelPrefix(undefined)).toBeNull();
  });

  it('throws when listed contains a form not in addressable', () => {
    expect(() => normalizeModelPrefix({
      prefix: 'or/',
      addressable: ['unprefixed'],
      listed: ['unprefixed', 'prefixed'],
    })).toThrow(/listed entry 'prefixed' is not in.*addressable/);
  });

  it('canonicalises form order to unprefixed-first', () => {
    const out = normalizeModelPrefix({ prefix: 'or/', addressable: ['prefixed', 'unprefixed'], listed: ['prefixed', 'unprefixed'] });
    expect(out!.addressable).toEqual(['unprefixed', 'prefixed']);
    expect(out!.listed).toEqual(['unprefixed', 'prefixed']);
  });

  it('throws when addressable is empty', () => {
    expect(() => normalizeModelPrefix({ prefix: 'or/', addressable: [], listed: [] }))
      .toThrow(/addressable.*non-empty/i);
  });

  it('throws on invalid prefix string', () => {
    expect(() => normalizeModelPrefix({ prefix: 'or', addressable: ['unprefixed'], listed: [] }))
      .toThrow(/prefix.*invalid/i);
  });

  it('throws when prefix exceeds the length cap', () => {
    const long = `${'x'.repeat(64)}/`;
    expect(() => normalizeModelPrefix({ prefix: long, addressable: ['unprefixed'], listed: [] }))
      .toThrow(/64 characters/);
  });

  it('throws on unknown addressable form (no silent drop)', () => {
    expect(() => normalizeModelPrefix({ prefix: 'or/', addressable: ['unprefixed', 'bogus'], listed: [] }))
      .toThrow(/addressable.*'unprefixed' or 'prefixed'/);
  });

  it('throws on non-array addressable', () => {
    expect(() => normalizeModelPrefix({ prefix: 'or/', addressable: 'unprefixed', listed: [] }))
      .toThrow(/addressable must be an array/);
  });
});

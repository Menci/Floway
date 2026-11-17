import { describe, expect, it } from 'vitest';

import { localeForLanguage, normalizeLanguage } from '../../src/i18n/languages';

describe('normalizeLanguage', () => {
  it.each([
    ['zh-CN', 'zh-Hans'],
    ['zh-Hant-TW', 'zh-Hans'],
    ['en-GB', 'en'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });

  it('does not guess an unsupported language', () => {
    expect(normalizeLanguage('ko-KR')).toBeNull();
    expect(normalizeLanguage('ja-JP')).toBeNull();
  });

  it('treats separators and case the way a browser reports them', () => {
    expect(normalizeLanguage('zh_hans_cn')).toBe('zh-Hans');
    expect(normalizeLanguage('  EN-us  ')).toBe('en');
  });
});

describe('language locales', () => {
  it('uses the matching regional locale', () => {
    expect(localeForLanguage('zh-Hans')).toBe('zh-CN');
    expect(localeForLanguage('en')).toBe('en-US');
  });

  it('falls back to the default locale for anything unsupported', () => {
    expect(localeForLanguage('ko-KR')).toBe('en-US');
    expect(localeForLanguage(null)).toBe('en-US');
  });
});

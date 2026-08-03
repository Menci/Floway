import { describe, expect, it } from 'vitest';

import { htmlLanguageFor, localeForLanguage, normalizeLanguage } from '../../src/i18n/languages';

describe('normalizeLanguage', () => {
  it.each([
    ['zh-CN', 'zh-Hans'],
    ['zh-Hans', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'],
    ['en-GB', 'en'],
    ['en', 'en'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });

  it.each([
    'zh-HK',
    'zh-MO',
    'zh-TW',
    'zh-Hant',
    'zh-Hant-HK',
    'zh-Hant-TW',
  ])('folds %s onto Simplified rather than dropping to English', tag => {
    expect(normalizeLanguage(tag)).toBe('zh-Hans');
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

  it('states the document language as the supported tag itself', () => {
    expect(htmlLanguageFor('en')).toBe('en');
    expect(htmlLanguageFor('zh-Hans')).toBe('zh-Hans');
    expect(htmlLanguageFor('zh-TW')).toBe('zh-Hans');
    expect(htmlLanguageFor('ko-KR')).toBe('en');
  });
});

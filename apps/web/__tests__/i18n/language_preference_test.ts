import { describe, expect, it } from 'vitest';

import {
  clearStoredLanguage,
  flowayLanguageStorageKey,
  storeLanguage,
  storedLanguage,
} from '../../src/i18n/language-preference';
import { stubLocalStorage } from '../local-storage-stub';

describe('language preference', () => {
  const storage = stubLocalStorage();

  it('has no preference by default', () => {
    expect(storedLanguage()).toBeNull();
  });

  it('round-trips a supported language', () => {
    storeLanguage('zh-Hans');

    expect(storage.get(flowayLanguageStorageKey)).toBe('zh-Hans');
    expect(storedLanguage()).toBe('zh-Hans');
  });

  it('ignores an unsupported stored language', () => {
    storage.set(flowayLanguageStorageKey, 'ko-KR');

    expect(storedLanguage()).toBeNull();
  });

  it('clears a stored language', () => {
    storeLanguage('en');
    clearStoredLanguage();

    expect(storedLanguage()).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { isPlural, leafEntries, leafKeys, pluralBase } from './keys';
import { supportedLanguages } from '../../src/i18n/languages';
import en from '../../src/i18n/locales/en';
import { numberFormats } from '../../src/i18n/number-format';
import { loadLocale } from '../../src/i18n/resources';

// The app fetches one locale per session, so the whole set is assembled here
// through the same loader map rather than from a list this file keeps of its
// own, which could fall behind a locale somebody added.
const locales = await Promise.all(
  supportedLanguages.map(async language => [language, await loadLocale(language)] as const),
);

// A locale key with no English counterpart is a defect in the resources, and
// the structural case above already names it; comparing against a stand-in
// would let this one pass on a value that happens to carry nothing.
const englishReference = (expected: Map<string, string>, key: string): string => {
  const reference = expected.get(key) ?? expected.get(`${pluralBase(key)}_other`);
  if (reference === undefined) throw new Error(`No English string for ${key}`);
  return reference;
};

const interpolations = (value: string): string[] =>
  [...value.matchAll(/\{\{[^}]+\}\}/g)].map(([match]) => match).sort();

const tags = (value: string): string[] =>
  [...value.matchAll(/<\/?[^>]+>/g)].map(([match]) => match).sort();

const formatNames = (value: string): string[] =>
  [...value.matchAll(/\{\{[^},]+,\s*([^}]+?)\s*\}\}/g)].map(([, name]) => name!);

describe('translation resources', () => {
  it('keeps every locale structurally aligned with English', () => {
    const expected = [...new Set(leafKeys(en).map(pluralBase))].sort();

    for (const [language, resource] of locales) {
      expect([...new Set(leafKeys(resource).map(pluralBase))].sort(), language).toEqual(expected);
    }
  });

  it('gives every plural key an `other` form in every locale', () => {
    for (const [language, resource] of locales) {
      const keys = leafKeys(resource);
      const plurals = new Set(keys.filter(isPlural).map(pluralBase));
      for (const base of plurals) {
        expect(keys, `${language}: ${base}`).toContain(`${base}_other`);
      }
    }
  });

  it('preserves interpolation variables in every locale', () => {
    const expected = leafEntries(en);

    for (const [, resource] of locales) {
      for (const [key, value] of leafEntries(resource)) {
        const reference = englishReference(expected, key);
        expect(interpolations(value), key).toEqual(interpolations(reference));
      }
    }
  });

  // The formatter module throws on an unregistered name, but only for a key
  // that actually renders, so a typo can sit in a rarely-opened dialog.
  it('names a registered format at every interpolation that asks for one', () => {
    for (const [language, resource] of locales) {
      for (const [key, value] of leafEntries(resource)) {
        for (const name of formatNames(value)) {
          expect(Object.keys(numberFormats), `${language}: ${key}`).toContain(name);
        }
      }
    }
  });

  it('preserves rich-text tags in every locale', () => {
    const expected = leafEntries(en);

    for (const [, resource] of locales) {
      for (const [key, value] of leafEntries(resource)) {
        const reference = englishReference(expected, key);
        expect(tags(value), key).toEqual(tags(reference));
      }
    }
  });
});

import { describe, expect, it } from 'vitest';

import { supportedLanguages } from '../../src/i18n/languages';
import en from '../../src/i18n/locales/en';
import { numberFormatNames } from '../../src/i18n/number-format';
import { loadLocale } from '../../src/i18n/resources';

// The app fetches one locale per session, so the whole set is assembled here
// through the same loader map rather than from a list this file keeps of its
// own, which could fall behind a locale somebody added.
const locales = await Promise.all(
  supportedLanguages.map(async language => [language, await loadLocale(language)] as const),
);

const leafKeys = (value: object, prefix = ''): string[] =>
  Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'object' && child !== null
      ? leafKeys(child, path)
      : [path];
  });

const leafStrings = (value: object, prefix = ''): Map<string, string> =>
  new Map(
    Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof child === 'object' && child !== null
        ? [...leafStrings(child, path)]
        : [[path, String(child)] as const];
    }),
  );

// i18next appends a CLDR plural category to the key, and the categories a
// language has are a fact about that language: English distinguishes one from
// other, Chinese has only other. Comparing raw keys would demand every locale
// carry English's categories, so structure is compared on the base key and
// every plural is required to supply `other`.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

const pluralBase = (key: string): string => key.replace(PLURAL_SUFFIX, '');

const isPlural = (key: string): boolean => PLURAL_SUFFIX.test(key);

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
    const expected = leafStrings(en);

    for (const [, resource] of locales) {
      for (const [key, value] of leafStrings(resource)) {
        const reference = englishReference(expected, key);
        expect(interpolations(value), key).toEqual(interpolations(reference));
      }
    }
  });

  // The formatter module throws on an unregistered name, but only for a key
  // that actually renders, so a typo can sit in a rarely-opened dialog.
  it('names a registered format at every interpolation that asks for one', () => {
    for (const [language, resource] of locales) {
      for (const [key, value] of leafStrings(resource)) {
        for (const name of formatNames(value)) {
          expect(numberFormatNames, `${language}: ${key}`).toContain(name);
        }
      }
    }
  });

  it('preserves rich-text tags in every locale', () => {
    const expected = leafStrings(en);

    for (const [, resource] of locales) {
      for (const [key, value] of leafStrings(resource)) {
        const reference = englishReference(expected, key);
        expect(tags(value), key).toEqual(tags(reference));
      }
    }
  });
});

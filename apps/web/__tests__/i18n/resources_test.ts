import { describe, expect, it } from "vitest";

import { resources } from "../../src/i18n/resources";

const leafKeys = (value: object, prefix = ""): string[] =>
  Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "object" && child !== null
      ? leafKeys(child, path)
      : [path];
  });

const leafStrings = (value: object, prefix = ""): Map<string, string> =>
  new Map(
    Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof child === "object" && child !== null
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

const pluralBase = (key: string): string => key.replace(PLURAL_SUFFIX, "");

const isPlural = (key: string): boolean => PLURAL_SUFFIX.test(key);

const interpolations = (value: string): string[] =>
  [...value.matchAll(/\{\{[^}]+\}\}/g)].map(([match]) => match).sort();

const tags = (value: string): string[] =>
  [...value.matchAll(/<\/?[^>]+>/g)].map(([match]) => match).sort();

describe("translation resources", () => {
  it("keeps every locale structurally aligned with English", () => {
    const expected = [...new Set(leafKeys(resources.en).map(pluralBase))].sort();

    for (const [language, resource] of Object.entries(resources)) {
      expect([...new Set(leafKeys(resource).map(pluralBase))].sort(), language).toEqual(expected);
    }
  });

  it("gives every plural key an `other` form in every locale", () => {
    for (const [language, resource] of Object.entries(resources)) {
      const keys = leafKeys(resource);
      const plurals = new Set(keys.filter(isPlural).map(pluralBase));
      for (const base of plurals) {
        expect(keys, `${language}: ${base}`).toContain(`${base}_other`);
      }
    }
  });

  it("preserves interpolation variables in every locale", () => {
    const expected = leafStrings(resources.en);

    for (const resource of Object.values(resources)) {
      for (const [key, value] of leafStrings(resource)) {
        const reference = expected.get(key) ?? expected.get(`${pluralBase(key)}_other`) ?? "";
        expect(interpolations(value), key).toEqual(interpolations(reference));
      }
    }
  });

  it("preserves rich-text tags in every locale", () => {
    const expected = leafStrings(resources.en);

    for (const resource of Object.values(resources)) {
      for (const [key, value] of leafStrings(resource)) {
        const reference = expected.get(key) ?? expected.get(`${pluralBase(key)}_other`) ?? "";
        expect(tags(value), key).toEqual(tags(reference));
      }
    }
  });
});

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

const interpolations = (value: string): string[] =>
  [...value.matchAll(/\{\{[^}]+\}\}/g)].map(([match]) => match).sort();

const tags = (value: string): string[] =>
  [...value.matchAll(/<\/?[^>]+>/g)].map(([match]) => match).sort();

describe("translation resources", () => {
  it("keeps every locale structurally aligned with English", () => {
    const expected = leafKeys(resources.en).sort();

    for (const resource of Object.values(resources)) {
      expect(leafKeys(resource).sort()).toEqual(expected);
    }
  });

  it("preserves interpolation variables in every locale", () => {
    const expected = leafStrings(resources.en);

    for (const resource of Object.values(resources)) {
      for (const [key, value] of leafStrings(resource)) {
        expect(interpolations(value), key).toEqual(interpolations(expected.get(key) ?? ""));
      }
    }
  });

  it("preserves rich-text tags in every locale", () => {
    const expected = leafStrings(resources.en);

    for (const resource of Object.values(resources)) {
      for (const [key, value] of leafStrings(resource)) {
        expect(tags(value), key).toEqual(tags(expected.get(key) ?? ""));
      }
    }
  });
});

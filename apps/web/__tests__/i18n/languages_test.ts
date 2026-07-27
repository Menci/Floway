import { describe, expect, it } from "vitest";

import {
  htmlLanguageFor,
  localeForLanguage,
  normalizeLanguage,
} from "../../src/i18n/languages";

describe("normalizeLanguage", () => {
  it.each([
    ["zh-CN", "zh-Hans-CN"],
    ["zh-Hans", "zh-Hans-CN"],
    ["zh-SG", "zh-Hans-CN"],
    ["zh-HK", "zh-Hant-HK"],
    ["zh-Hant-HK", "zh-Hant-HK"],
    ["zh-MO", "zh-Hant-HK"],
    ["zh-TW", "zh-Hant-TW"],
    ["zh-Hant", "zh-Hant-TW"],
    ["en-GB", "en"],
    ["ja-JP", "ja-JP"],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });

  it("does not guess an unsupported language", () => {
    expect(normalizeLanguage("ko-KR")).toBeNull();
  });
});

describe("language locales", () => {
  it("uses the matching regional locale", () => {
    expect(localeForLanguage("zh-Hant-HK")).toBe("zh-HK");
    expect(localeForLanguage("zh-Hant-TW")).toBe("zh-TW");
    expect(htmlLanguageFor("en")).toBe("en");
  });
});

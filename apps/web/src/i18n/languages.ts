export const defaultLanguage = "en";

export const supportedLanguages = [
  "en",
  "zh-Hans-CN",
  "zh-Hant-HK",
  "zh-Hant-TW",
  "ja-JP",
] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];

const languageLocales: Record<SupportedLanguage, string> = {
  en: "en-US",
  "zh-Hans-CN": "zh-CN",
  "zh-Hant-HK": "zh-HK",
  "zh-Hant-TW": "zh-TW",
  "ja-JP": "ja-JP",
};

export const normalizeLanguage = (
  value: string | null | undefined,
): SupportedLanguage | null => {
  if (!value) return null;

  const language = value.trim().replaceAll("_", "-").toLowerCase();
  if (language === "en" || language.startsWith("en-")) return "en";
  if (language === "ja" || language.startsWith("ja-")) return "ja-JP";
  if (
    language.startsWith("zh-hk") ||
    language.startsWith("zh-mo") ||
    language.startsWith("zh-hant-hk") ||
    language.startsWith("zh-hant-mo")
  ) {
    return "zh-Hant-HK";
  }
  if (
    language.startsWith("zh-tw") ||
    language.startsWith("zh-hant-tw") ||
    language === "zh-hant"
  ) {
    return "zh-Hant-TW";
  }
  if (
    language === "zh" ||
    language === "zh-cn" ||
    language === "zh-sg" ||
    language.startsWith("zh-hans")
  ) {
    return "zh-Hans-CN";
  }

  return null;
};

export const localeForLanguage = (language: string | null | undefined): string => {
  const normalized = normalizeLanguage(language) ?? defaultLanguage;
  return languageLocales[normalized];
};

export const htmlLanguageFor = (language: string | null | undefined): string =>
  localeForLanguage(language).replace("en-US", "en");

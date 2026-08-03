export const defaultLanguage = 'en';

export const supportedLanguages = ['en', 'zh-Hans'] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];

// The supported language keys are BCP-47 tags in their own right, so the
// document language is the language; a locale is separate because number and
// date formatting needs a region the tag does not carry.
const languageLocales: Record<SupportedLanguage, string> = {
  'en': 'en-US',
  'zh-Hans': 'zh-CN',
};

// A Traditional reader gets more out of Simplified Chinese than out of English.
export const normalizeLanguage = (value: string | null | undefined): SupportedLanguage | null => {
  if (!value) return null;

  const language = value.trim().replaceAll('_', '-').toLowerCase();
  if (language === 'en' || language.startsWith('en-')) return 'en';
  if (language === 'zh' || language.startsWith('zh-')) return 'zh-Hans';

  return null;
};

// The prerender renders one index.html for every visitor and has no navigator
// to ask, so it answers with the default language.
export const browserLanguage = (): SupportedLanguage =>
  (typeof window === 'undefined' ? null : normalizeLanguage(window.navigator.language)) ?? defaultLanguage;

export const localeForLanguage = (language: string | null | undefined): string => {
  const normalized = normalizeLanguage(language) ?? defaultLanguage;
  return languageLocales[normalized];
};

export const htmlLanguageFor = (language: string | null | undefined): SupportedLanguage =>
  normalizeLanguage(language) ?? defaultLanguage;

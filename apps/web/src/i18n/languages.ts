export const defaultLanguage = 'en';

export const supportedLanguages = ['en', 'zh-Hans'] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];

const languageLocales: Record<SupportedLanguage, string> = {
  'en': 'en-US',
  'zh-Hans': 'zh-CN',
};

// Traditional tags fold onto Simplified rather than falling back to English: a
// Traditional reader gets more out of Simplified Chinese than out of English.
export const normalizeLanguage = (value: string | null | undefined): SupportedLanguage | null => {
  if (!value) return null;

  const language = value.trim().replaceAll('_', '-').toLowerCase();
  if (language === 'en' || language.startsWith('en-')) return 'en';
  if (language === 'zh' || language.startsWith('zh-')) return 'zh-Hans';

  return null;
};

export const localeForLanguage = (language: string | null | undefined): string => {
  const normalized = normalizeLanguage(language) ?? defaultLanguage;
  return languageLocales[normalized];
};

export const htmlLanguageFor = (language: string | null | undefined): string =>
  localeForLanguage(language).replace('en-US', 'en');

import type { Resource } from 'i18next';

import type { SupportedLanguage } from './languages';

// One `import()` per locale, written out rather than derived from a template,
// so the bundler sees the whole set and gives each locale a chunk of its own.
// A visitor fetches the bundle for their own language and never the others.
const localeModules: Record<SupportedLanguage, () => Promise<{ default: Resource[string] }>> = {
  'en': () => import('./locales/en'),
  'zh-Hans': () => import('./locales/zh-Hans'),
};

export const loadLocale = async (language: SupportedLanguage): Promise<Resource[string]> =>
  (await localeModules[language]()).default;

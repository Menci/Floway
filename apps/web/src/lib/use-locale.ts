import { useTranslation } from 'react-i18next';

import { localeForLanguage } from '../i18n/languages';

// The app locale, not the browser's: a `zh-Hans` dashboard read in an `en-US`
// browser is still a `zh-Hans` dashboard.
//
// `i18n.language` rather than `i18n.resolvedLanguage`, which is undefined until
// i18next has initialised and otherwise reports the fallback chain's outcome --
// resolution `localeForLanguage` already performs.
export const useLocale = (): string => {
  const { i18n } = useTranslation();
  return localeForLanguage(i18n.language);
};

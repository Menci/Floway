import { useTranslation } from 'react-i18next';

import { localeForLanguage } from '../i18n/languages';

// One answer to "which locale does this render in". The app locale, not the
// browser's: a `zh-Hans` dashboard read in an `en-US` browser is still a
// `zh-Hans` dashboard, and a page that mixed the two sources showed both
// spellings of the same instant side by side.
//
// `i18n.language` rather than `i18n.resolvedLanguage`: the latter is undefined
// until i18next has initialised and otherwise only reports the outcome of the
// fallback chain, which is resolution `localeForLanguage` already performs on
// any tag it is handed.
export const useLocale = (): string => {
  const { i18n } = useTranslation();
  return localeForLanguage(i18n.language);
};

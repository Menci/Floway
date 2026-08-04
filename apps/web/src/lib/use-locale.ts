import { localeForLanguage } from '../i18n/languages';
import { useTranslation } from '../i18n/translation';

// `i18n.language` rather than `i18n.resolvedLanguage`, which is undefined until
// i18next has initialised and otherwise duplicates the fallback resolution
// `localeForLanguage` already performs.
export const useLocale = (): string => {
  const { i18n } = useTranslation();
  return localeForLanguage(i18n.language);
};

import { useEffect } from 'react';

import { i18n } from '../i18n';
import { defaultLanguage, normalizeLanguage } from '../i18n/languages';

export function BrowserLanguageSync() {
  useEffect(() => {
    const language = normalizeLanguage(window.navigator.language) ?? defaultLanguage;
    void i18n.changeLanguage(language);
  }, []);

  return null;
}

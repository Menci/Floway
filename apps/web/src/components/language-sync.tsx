import { useEffect } from 'react';

import { setLanguage } from '../i18n';
import { storedLanguage } from '../i18n/language-preference';
import { browserLanguage } from '../i18n/languages';

export function LanguageSync() {
  useEffect(() => {
    void setLanguage(storedLanguage() ?? browserLanguage());
  }, []);

  return null;
}

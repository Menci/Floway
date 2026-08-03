import { useEffect } from 'react';

import { setLanguage } from '../i18n';
import { browserLanguage } from '../i18n/languages';

export function BrowserLanguageSync() {
  useEffect(() => {
    void setLanguage(browserLanguage());
  }, []);

  return null;
}

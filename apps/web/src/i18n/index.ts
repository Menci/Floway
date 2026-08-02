import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import {
  defaultLanguage,
  htmlLanguageFor,
  supportedLanguages,
} from './languages';
import { resources } from './resources';

void i18n.use(initReactI18next).init({
  resources,
  lng: defaultLanguage,
  fallbackLng: defaultLanguage,
  supportedLngs: [...supportedLanguages],
  interpolation: {
    escapeValue: false,
  },
});

i18n.on('languageChanged', language => {
  if (typeof window !== 'undefined') {
    window.document.documentElement.lang = htmlLanguageFor(language);
  }
});

export { i18n };

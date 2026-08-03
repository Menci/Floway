import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import {
  browserLanguage,
  defaultLanguage,
  htmlLanguageFor,
  supportedLanguages,
  type SupportedLanguage,
} from './languages';
import { numberFormatter } from './number-format';
import { loadLocale } from './resources';
import { shellResources } from './shell';

// Translation data is the larger part of what the dashboard has to load before
// it can paint, and half of that again is a language the visitor is not
// reading, so each locale is fetched on its own. That makes the strings
// asynchronous, and this module awaits them rather than handing out a promise:
// everything that renders reaches i18next through here, so React cannot mount
// -- and the prerendered boot screen cannot be replaced -- before the bundle is
// in hand, and no render can meet a missing key.
//
// Hydration is the one render that cannot be in the visitor's language: it has
// to reproduce index.html, which was prerendered in the default language. So
// the active language starts as the default with only ./shell's strings behind
// it, while `fallbackLng` names the visitor's language and carries the bundle
// loaded here. Every key outside the shell resolves through that fallback,
// which puts whatever renders between hydration and BrowserLanguageSync in the
// visitor's language rather than briefly in English.
const language = browserLanguage();
const loaded = new Set<SupportedLanguage>([language]);

void i18n.use(numberFormatter).use(initReactI18next).init({
  resources: { [defaultLanguage]: shellResources, [language]: await loadLocale(language) },
  lng: defaultLanguage,
  fallbackLng: language,
  supportedLngs: [...supportedLanguages],
  interpolation: {
    escapeValue: false,
    alwaysFormat: true,
  },
});

i18n.on('languageChanged', language => {
  if (typeof window !== 'undefined') {
    window.document.documentElement.lang = htmlLanguageFor(language);
  }
});

// The way the app changes language. A bare `changeLanguage` would reach a
// language whose bundle was never fetched, and the default language is present
// from boot carrying the shell's strings alone.
export const setLanguage = async (next: SupportedLanguage): Promise<void> => {
  if (!loaded.has(next)) {
    i18n.addResourceBundle(next, 'translation', (await loadLocale(next)).translation);
    loaded.add(next);
  }
  await i18n.changeLanguage(next);
};

export { i18n };

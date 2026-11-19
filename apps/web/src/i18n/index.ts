import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import {
  COPY_EDITOR_POST_PROCESSOR_NAME,
  copyEditorPostProcessor,
  setCopyEditorTrackingActive,
} from './copy-editor/markers';
import { isCopyEditorEnabled } from './copy-editor/mirror';
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
// it, while `fallbackLng` names the language the visitor will read -- the
// browser language, until a signed-in account's stored preference replaces it --
// and carries the bundle loaded here. Every key outside the shell resolves
// through that fallback, which puts whatever renders between hydration and
// LanguageSync in the visitor's language rather than briefly in English.
const cloneResource = <T>(value: T): T => structuredClone(value);

const language = browserLanguage();
const loaded = new Set<SupportedLanguage>([language]);
const copyEditorActive = isCopyEditorEnabled();

const instance = i18n.use(numberFormatter).use(initReactI18next);
if (copyEditorActive) {
  instance.use(copyEditorPostProcessor);
}

void instance.init({
  resources: {
    [defaultLanguage]: cloneResource(shellResources),
    [language]: cloneResource(await loadLocale(language)),
  },
  lng: defaultLanguage,
  fallbackLng: language,
  supportedLngs: [...supportedLanguages],
  interpolation: {
    escapeValue: false,
    alwaysFormat: true,
  },
  ...(copyEditorActive
    ? {
        postProcess: [COPY_EDITOR_POST_PROCESSOR_NAME],
        postProcessPassResolved: true,
        react: {
          bindI18n: 'languageChanged',
          bindI18nStore: 'added',
        },
      }
    : {}),
});

i18n.on('languageChanged', language => {
  if (typeof window !== 'undefined') {
    window.document.documentElement.lang = htmlLanguageFor(language);
  }
});

// The way the app changes language. A bare `changeLanguage` would reach a
// language whose bundle was never fetched, and the default language is present
// from boot carrying the shell's strings alone. Persisting the choice is the
// caller's job: boot sync and tests also call this, and neither is an explicit
// in-page choice.
export const setLanguage = async (next: SupportedLanguage): Promise<void> => {
  if (!loaded.has(next)) {
    const bundle = await loadLocale(next);
    // Keep any live copy-editor overrides intact if the store already merged
    // them into this language's resource bundle.
    i18n.addResourceBundle(next, 'translation', cloneResource(bundle.translation), true, false);
    loaded.add(next);
  }
  await i18n.changeLanguage(next);
};

// Called once after client hydration when copy-editor mode is active so that
// markers never enter the prerendered HydrateFallback frame. Emitting the
// store `added` event refreshes every mounted `useTranslation` consumer with
// markers attached.
export const activateCopyEditorTracking = (): void => {
  if (!copyEditorActive) return;
  setCopyEditorTrackingActive(true);
  i18n.addResources(i18n.language, 'translation', {});
};

export { i18n };

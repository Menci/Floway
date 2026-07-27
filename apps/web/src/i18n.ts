import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import {
  defaultLanguage,
  htmlLanguageFor,
  supportedLanguages,
} from "./i18n/languages";
import { resources } from "./i18n/resources";

void i18n.use(initReactI18next).init({
  resources,
  lng: defaultLanguage,
  fallbackLng: defaultLanguage,
  supportedLngs: [...supportedLanguages],
  interpolation: {
    escapeValue: false,
  },
});

void i18n.on("languageChanged", (language) => {
  if (typeof window !== "undefined") {
    window.document.documentElement.lang = htmlLanguageFor(language);
  }
});

export { i18n };
export * from "./i18n/languages";
export { resources } from "./i18n/resources";

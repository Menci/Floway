import { useEffect } from "react";

import { defaultLanguage, i18n, normalizeLanguage } from "../i18n";

export function BrowserLanguageSync() {
  useEffect(() => {
    const language = normalizeLanguage(window.navigator.language) ?? defaultLanguage;
    void i18n.changeLanguage(language);
  }, []);

  return null;
}

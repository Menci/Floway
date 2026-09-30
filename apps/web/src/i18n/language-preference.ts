import { normalizeLanguage, type SupportedLanguage } from './languages';

export const flowayLanguageStorageKey = 'floway-language';

// An explicit choice made in the page outranks the browser language, and has to
// survive reloads; localStorage is the same place the session and dashboard
// prefs already live. Storage can be denied (Safari private browsing, a
// partitioned third-party context) and happy-dom ships none, so every access is
// guarded and the app just carries on unpersisted.
export const storedLanguage = (): SupportedLanguage | null => {
  if (typeof window === 'undefined') return null;

  try {
    return normalizeLanguage(window.localStorage.getItem(flowayLanguageStorageKey));
  } catch {
    return null;
  }
};

export const storeLanguage = (language: SupportedLanguage): void => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(flowayLanguageStorageKey, language);
  } catch {
    // A denied or unavailable storage still allows the choice for this session;
    // it just does not survive the next reload.
  }
};

export const clearStoredLanguage = (): void => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(flowayLanguageStorageKey);
  } catch {
    // As above.
  }
};

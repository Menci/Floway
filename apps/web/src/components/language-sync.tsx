import { useEffect } from 'react';

import { setLanguage } from '../i18n';
import { browserLanguage } from '../i18n/languages';
import { useAuthStore } from '../stores/auth-store';
import type { SupportedLanguage } from '@floway-dev/protocols/browser';

// A signed-in account carries its language with its session; until then, and
// whenever the account chose to follow the browser, the browser decides.
export function LanguageSync() {
  const language = useAuthStore(state => state.session?.user.preferences.language ?? null);
  const resolved: SupportedLanguage | null = language;

  useEffect(() => {
    void setLanguage(resolved ?? browserLanguage());
  }, [resolved]);

  return null;
}

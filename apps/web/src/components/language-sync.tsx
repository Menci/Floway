import { useEffect } from 'react';

import { setLanguage } from '../i18n';
import { browserLanguage } from '../i18n/languages';
import { syncUiTextEditorPreference } from '../i18n/ui-text-editor/mirror';
import { useAuthStore } from '../stores/auth-store';
import type { SupportedLanguage } from '@floway-dev/protocols/browser';

// A signed-in account carries its language and UI text editor setting with its
// session; until then, and whenever the account chose to follow the browser,
// the browser decides the language while the UI text editor mirror retains the
// last signed-in user's setting so the login page can still be edited.
export function LanguageSync() {
  const language = useAuthStore(state => state.session?.user.preferences.language ?? null);
  const uiTextEditor = useAuthStore(state => state.session?.user.preferences.uiTextEditor ?? null);
  const resolved: SupportedLanguage | null = language;

  useEffect(() => {
    void setLanguage(resolved ?? browserLanguage());
  }, [resolved]);

  useEffect(() => {
    if (uiTextEditor !== null) {
      syncUiTextEditorPreference(uiTextEditor);
    }
  }, [uiTextEditor]);

  return null;
}

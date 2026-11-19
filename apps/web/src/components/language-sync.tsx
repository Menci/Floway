import { useEffect } from 'react';

import { setLanguage } from '../i18n';
import { syncCopyEditorPreference } from '../i18n/copy-editor/mirror';
import { browserLanguage } from '../i18n/languages';
import { useAuthStore } from '../stores/auth-store';
import type { SupportedLanguage } from '@floway-dev/protocols/browser';

// A signed-in account carries its language and copy-editor setting with its
// session; until then, and whenever the account chose to follow the browser,
// the browser decides the language while the copy-editor mirror retains the
// last signed-in user's setting so the login page can still be edited.
export function LanguageSync() {
  const language = useAuthStore(state => state.session?.user.preferences.language ?? null);
  const copyEditor = useAuthStore(state => state.session?.user.preferences.copyEditor ?? null);
  const resolved: SupportedLanguage | null = language;

  useEffect(() => {
    void setLanguage(resolved ?? browserLanguage());
  }, [resolved]);

  useEffect(() => {
    if (copyEditor !== null) {
      syncCopyEditorPreference(copyEditor);
    }
  }, [copyEditor]);

  return null;
}
